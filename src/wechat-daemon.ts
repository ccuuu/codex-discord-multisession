import { execFile, spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { basename, extname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readdir, readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { loadBindings, saveBindings, upsertBinding, type Binding } from './bindings.js'
import { codexSessionHomes, findCodexSessionSummary, listCodexSessions, resolveCodexSessionId, type CodexSessionSummary } from './codex-sessions.js'
import { CodexRunInterruptedError } from './codex-runner.js'

const execFileAsync = promisify(execFile)

export type WeChatDaemonOptions = {
  stateDir: string
  workdir: string
  wxBin: string
  codexBin: string
  sandbox: string
  model?: string
  debug?: boolean
  runCodex: typeof import('./codex-runner.js').runCodex
}

type WeChatItem = {
  type?: number
  text_item?: {
    text?: string
  }
  voice_item?: {
    text?: string
  }
  file_item?: {
    file_name?: string
  }
}

type WeChatMessage = {
  seq?: number
  message_id?: number
  from_user_id?: string
  create_time_ms?: number
  message_type?: number
  item_list?: WeChatItem[]
  attachments?: WeChatAttachment[]
}

type BridgeAck = {
  bridge_event?: string
  id?: string
  error?: string
}

type WeChatAttachment = {
  kind?: string
  path?: string
  fileName?: string
  size?: number
}

type Conversation = {
  key: string
  userId: string
}

type ActiveRun = {
  abort: AbortController
  conversation: Conversation
  startedAt: number
  prompt: string
  statusLines: string[]
  longRunNoticeTimer?: NodeJS.Timeout
  stopRequested?: boolean
  stopRequestedAt?: number
  stopFollowupTimer?: NodeJS.Timeout
}

type WorkspaceSnapshotMode = 'git' | 'fs'

type FileSnapshot = {
  absPath: string
  relPath: string
  size: number
  mtimeMs: number
  status?: string
}

type WorkspaceSnapshot = {
  mode: WorkspaceSnapshotMode
  root: string
  files: Map<string, FileSnapshot>
}

type QueuedPrompt = {
  prompt: string
  queuedAt: number
  conversation: Conversation
  forceNew?: boolean
  imagePaths?: string[]
}

type BindWorkdirSource = 'explicit' | 'session'

type ResolvedBindTarget = {
  codexThreadId: string
  codexHome?: string
  cwd: string
  cwdSource: BindWorkdirSource
}

type BoundSession = ResolvedBindTarget & {
  binding: Binding
}

const MESSAGE_TYPE_USER = 1
const ITEM_TYPE_TEXT = 1
const ITEM_TYPE_IMAGE = 2
const ITEM_TYPE_VOICE = 3
const ITEM_TYPE_FILE = 4
const ITEM_TYPE_VIDEO = 5
const LONG_RUN_NOTICE_MS = 120000
const DEFAULT_ARTIFACT_MAX_FILES = 5
const DEFAULT_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_FS_SNAPSHOT_MAX_FILES = 8000
const FS_SNAPSHOT_EXCLUDED_DIRS = new Set([
  '.cache',
  '.git',
  '.hg',
  '.next',
  '.nuxt',
  '.svn',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
])
const SENSITIVE_FILE_NAMES = new Set([
  '.env',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'kubeconfig',
])
const SENSITIVE_EXTENSIONS = new Set(['.cer', '.crt', '.key', '.p12', '.pem', '.pfx'])
const IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'])

export function weChatConversationFromMessage(msg: WeChatMessage): Conversation | undefined {
  if (msg.message_type !== MESSAGE_TYPE_USER) return undefined
  if (!msg.from_user_id) return undefined
  return {
    key: `wechat:user:${msg.from_user_id}`,
    userId: msg.from_user_id,
  }
}

export function describeWeChatMessage(msg: WeChatMessage): string {
  const hasAttachments = Boolean(msg.attachments?.length)
  const parts = (msg.item_list ?? []).map(item => {
    switch (item.type) {
      case ITEM_TYPE_TEXT:
        return item.text_item?.text ?? ''
      case ITEM_TYPE_IMAGE:
        return hasAttachments ? '' : '[image]'
      case ITEM_TYPE_VOICE:
        return item.voice_item?.text ? `[voice] ${item.voice_item.text}` : hasAttachments ? '' : '[voice]'
      case ITEM_TYPE_FILE:
        return hasAttachments ? '' : `[file] ${item.file_item?.file_name ?? 'attachment'}`
      case ITEM_TYPE_VIDEO:
        return hasAttachments ? '' : '[video]'
      default:
        return `[item:${item.type ?? 'unknown'}]`
    }
  }).filter(Boolean)
  for (const attachment of msg.attachments ?? []) {
    if (!attachment.path) continue
    const label = attachment.fileName ? `${attachment.fileName} -> ${attachment.path}` : attachment.path
    parts.push(`[${attachment.kind ?? 'attachment'}] ${label}`)
  }
  return parts.join(' ').trim()
}

export async function startWeChatDaemon(opts: WeChatDaemonOptions): Promise<void> {
  const bindingsFile = join(opts.stateDir, 'bindings.json')
  const activeRuns = new Map<string, ActiveRun>()
  const queuedPrompts = new Map<string, QueuedPrompt[]>()
  const pendingBridgeAcks = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>()
  const seenMessages = new Set<string>()
  let watchProcess: ChildProcessByStdio<Writable, Readable, Readable> | undefined
  let stopping = false
  let bridgeCommandSeq = 0

  function chunkText(text: string, limit = 2800): string[] {
    if (!text) return ['(no final response)']
    const chunks: string[] = []
    let rest = text
    while (rest.length > limit) {
      chunks.push(rest.slice(0, limit))
      rest = rest.slice(limit)
    }
    chunks.push(rest)
    return chunks
  }

  function truncateText(text: string, limit: number): string {
    if (text.length <= limit) return text
    return `${text.slice(0, Math.max(0, limit - 20))}\n... [truncated]`
  }

  function escapeCodeBlock(text: string): string {
    return text.replace(/```/g, '``\u200b`')
  }

  function elapsedSeconds(startedAt: number): number {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  }

  function queueLength(conversationKey: string): number {
    return queuedPrompts.get(conversationKey)?.length ?? 0
  }

  function imagePathsFromMessage(msg: WeChatMessage): string[] {
    return (msg.attachments ?? [])
      .filter(attachment => attachment.kind === 'image' && typeof attachment.path === 'string' && attachment.path)
      .map(attachment => attachment.path as string)
  }

  async function sendText(conversation: Conversation, text: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      await sendWxText(conversation.userId, chunk)
    }
  }

  async function sendWxText(userId: string, text: string): Promise<void> {
    const safeText = text.startsWith('--') ? `\n${text}` : text
    await new Promise<void>((resolveSend, reject) => {
      if (!watchProcess || !watchProcess.stdin.writable) {
        reject(new Error('wx bridge is not ready for outgoing messages.'))
        return
      }
      const payload = `${JSON.stringify({ cmd: 'send', to: userId, text: safeText })}\n`
      watchProcess.stdin.write(payload, err => {
        if (err) reject(err)
        else resolveSend()
      })
    }).catch(err => {
      console.error(`wechat send failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  async function sendWxMedia(userId: string, filePath: string, caption?: string): Promise<boolean> {
    const id = `media-${Date.now()}-${++bridgeCommandSeq}`
    const timeoutMs = envInt('CODEX_WECHAT_MEDIA_SEND_TIMEOUT_MS', 60000, 1000, 10 * 60 * 1000)
    return await new Promise<boolean>((resolveSend) => {
      if (!watchProcess || !watchProcess.stdin.writable) {
        console.error('wechat media send failed: wx bridge is not ready for outgoing media.')
        resolveSend(false)
        return
      }
      const timer = setTimeout(() => {
        pendingBridgeAcks.delete(id)
        console.error(`wechat media send timed out waiting for wx bridge ack: ${filePath}`)
        resolveSend(false)
      }, timeoutMs)
      pendingBridgeAcks.set(id, {
        timer,
        resolve: ok => {
          clearTimeout(timer)
          resolveSend(ok)
        },
      })
      const payload = `${JSON.stringify({
        cmd: 'sendMedia',
        id,
        to: userId,
        path: filePath,
        ...(caption ? { caption } : {}),
      })}\n`
      watchProcess.stdin.write(payload, err => {
        if (!err) return
        const pending = pendingBridgeAcks.get(id)
        if (pending) {
          pendingBridgeAcks.delete(id)
          clearTimeout(pending.timer)
        }
        console.error(`wechat media send failed for ${userId}: ${err.message}`)
        resolveSend(false)
      })
    })
  }

  function handleBridgeAck(ack: BridgeAck): void {
    if (!ack.id) return
    const pending = pendingBridgeAcks.get(ack.id)
    if (!pending) return
    pendingBridgeAcks.delete(ack.id)
    if (ack.bridge_event === 'send.ok') {
      pending.resolve(true)
      return
    }
    if (ack.error) console.error(`wechat bridge send failed: ${ack.error}`)
    pending.resolve(false)
  }

  function clearPendingBridgeAcks(): void {
    for (const [id, pending] of pendingBridgeAcks) {
      pendingBridgeAcks.delete(id)
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
  }

  function envInt(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, parsed))
  }

  function formatBytes(value: number): string {
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
    return `${(value / 1024 / 1024).toFixed(1)} MiB`
  }

  function isSensitiveArtifact(file: FileSnapshot): boolean {
    const name = basename(file.relPath).toLowerCase()
    if (SENSITIVE_FILE_NAMES.has(name)) return true
    if (name.startsWith('.env.')) return true
    if (SENSITIVE_EXTENSIONS.has(extname(name))) return true
    return file.relPath.split('/').some(part => part === '.ssh' || part === '.kube')
  }

  async function fileSnapshot(root: string, relPath: string, statusText?: string): Promise<FileSnapshot | undefined> {
    const absPath = resolve(root, relPath)
    try {
      const info = await stat(absPath)
      if (!info.isFile()) return undefined
      return {
        absPath,
        relPath,
        size: info.size,
        mtimeMs: info.mtimeMs,
        status: statusText,
      }
    } catch {
      return undefined
    }
  }

  function parseGitStatus(output: string): Array<{ status: string; relPath: string }> {
    const entries = output.split('\0').filter(Boolean)
    const rows: Array<{ status: string; relPath: string }> = []
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      if (entry.length < 4) continue
      const statusText = entry.slice(0, 2)
      const relPath = entry.slice(3)
      rows.push({ status: statusText, relPath })
      if (statusText.includes('R') || statusText.includes('C')) i += 1
    }
    return rows
  }

  async function captureGitWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot | undefined> {
    try {
      const rootResult = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })
      const root = String(rootResult.stdout).trim()
      if (!root) return undefined
      const statusResult = await execFileAsync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
      })
      const files = new Map<string, FileSnapshot>()
      for (const row of parseGitStatus(String(statusResult.stdout))) {
        if (row.status.includes('D')) continue
        const snapshot = await fileSnapshot(root, row.relPath, row.status)
        if (snapshot) files.set(snapshot.absPath, snapshot)
      }
      return { mode: 'git', root, files }
    } catch {
      return undefined
    }
  }

  async function captureFsWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot | undefined> {
    const root = resolve(cwd)
    const maxFiles = envInt('CODEX_WECHAT_FS_SNAPSHOT_MAX_FILES', DEFAULT_FS_SNAPSHOT_MAX_FILES, 100, 50000)
    const files = new Map<string, FileSnapshot>()

    async function scan(dir: string): Promise<void> {
      if (files.size > maxFiles) throw new Error(`workspace snapshot exceeded ${maxFiles} files`)
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const absPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (FS_SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue
          await scan(absPath)
          continue
        }
        if (!entry.isFile()) continue
        const relPath = relative(root, absPath)
        const snapshot = await fileSnapshot(root, relPath)
        if (snapshot) files.set(snapshot.absPath, snapshot)
      }
    }

    try {
      await scan(root)
      return { mode: 'fs', root, files }
    } catch (err) {
      console.error(`wechat artifact snapshot skipped: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  async function captureWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot | undefined> {
    return await captureGitWorkspaceSnapshot(cwd) ?? await captureFsWorkspaceSnapshot(cwd)
  }

  function changedSince(before: WorkspaceSnapshot, after: FileSnapshot): boolean {
    const previous = before.files.get(after.absPath)
    if (!previous) return true
    return previous.size !== after.size ||
      Math.abs(previous.mtimeMs - after.mtimeMs) > 1 ||
      previous.status !== after.status
  }

  async function collectWorkspaceArtifacts(before: WorkspaceSnapshot): Promise<FileSnapshot[]> {
    const after = before.mode === 'git'
      ? await captureGitWorkspaceSnapshot(before.root)
      : await captureFsWorkspaceSnapshot(before.root)
    if (!after) return []
    return [...after.files.values()]
      .filter(file => changedSince(before, file))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async function sendWorkspaceArtifacts(conversation: Conversation, before: WorkspaceSnapshot | undefined): Promise<void> {
    if (!before || process.env.CODEX_WECHAT_SEND_ARTIFACTS === '0') return

    const artifacts = await collectWorkspaceArtifacts(before)
    if (!artifacts.length) return

    const safeArtifacts = artifacts.filter(file => !isSensitiveArtifact(file))
    const sensitiveCount = artifacts.length - safeArtifacts.length
    if (!safeArtifacts.length) {
      await sendText(conversation, `Codex changed ${artifacts.length} sensitive-looking file(s). They were not sent to WeChat.`)
      return
    }

    const maxFiles = envInt('CODEX_WECHAT_ARTIFACT_MAX_FILES', DEFAULT_ARTIFACT_MAX_FILES, 0, 20)
    const maxBytes = envInt('CODEX_WECHAT_ARTIFACT_MAX_BYTES', DEFAULT_ARTIFACT_MAX_BYTES, 1024, 50 * 1024 * 1024)
    const sendable = safeArtifacts.filter(file => file.size <= maxBytes).slice(0, maxFiles)
    const tooLargeCount = safeArtifacts.filter(file => file.size > maxBytes).length
    const unsentCount = Math.max(0, safeArtifacts.length - sendable.length)

    const listed = safeArtifacts.slice(0, 20).map(file => `- ${file.relPath} (${formatBytes(file.size)})`)
    const lines = [
      `Codex changed ${artifacts.length} workspace file(s) in this turn.`,
      ...listed,
    ]
    if (safeArtifacts.length > listed.length) lines.push(`... ${safeArtifacts.length - listed.length} more file(s) not shown.`)
    if (sensitiveCount) lines.push(`${sensitiveCount} sensitive-looking file(s) were not listed or sent.`)
    if (tooLargeCount) lines.push(`${tooLargeCount} file(s) exceeded ${formatBytes(maxBytes)} and were not sent.`)
    if (sendable.length) lines.push(`Sending ${sendable.length} changed file(s) to WeChat.`)
    else if (unsentCount) lines.push('No files were auto-sent. Increase CODEX_WECHAT_ARTIFACT_MAX_FILES or CODEX_WECHAT_ARTIFACT_MAX_BYTES if needed.')

    await sendText(conversation, lines.join('\n'))

    for (const file of sendable) {
      await sendWxMedia(conversation.userId, file.absPath, `Codex artifact: ${file.relPath}`)
    }
  }

  function expandHomePath(value: string): string {
    if (value === '~') return homedir()
    if (value.startsWith('~/')) return join(homedir(), value.slice(2))
    return value
  }

  async function maybeExistingCodexHome(value: string | undefined, homes: Set<string>): Promise<void> {
    if (!value) return
    const home = resolve(expandHomePath(value))
    try {
      const info = await stat(home)
      if (info.isDirectory()) homes.add(home)
    } catch {}
  }

  async function codexHomeFromBinary(): Promise<string | undefined> {
    let binPath = opts.codexBin
    if (!binPath.includes('/')) {
      try {
        const resolved = await execFileAsync('which', [binPath], {
          encoding: 'utf8',
          timeout: 3000,
          maxBuffer: 1024 * 1024,
        })
        binPath = String(resolved.stdout).trim()
      } catch {
        return undefined
      }
    }
    if (!binPath) return undefined

    try {
      const script = await readFile(resolve(binPath), 'utf8')
      const match = script.match(/(?:^|\s)CODEX_HOME=(?:"([^"]+)"|'([^']+)'|([^\s]+))/)
      return match ? expandHomePath(match[1] ?? match[2] ?? match[3] ?? '') : undefined
    } catch {
      return undefined
    }
  }

  async function generatedImageHomes(): Promise<string[]> {
    const homes = new Set<string>()
    for (const home of codexSessionHomes()) {
      await maybeExistingCodexHome(home, homes)
    }
    await maybeExistingCodexHome(await codexHomeFromBinary(), homes)
    return [...homes]
  }

  async function collectGeneratedImages(codexThreadId: string, startedAt: number): Promise<FileSnapshot[]> {
    if (!codexThreadId) return []
    const cutoff = startedAt - 10000
    const files = new Map<string, FileSnapshot>()

    async function scan(home: string, dir: string): Promise<void> {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
      }
      for (const entry of entries) {
        const absPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          await scan(home, absPath)
          continue
        }
        if (!entry.isFile()) continue
        if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
        const info = await stat(absPath)
        if (info.mtimeMs < cutoff) continue
        files.set(absPath, {
          absPath,
          relPath: relative(home, absPath),
          size: info.size,
          mtimeMs: info.mtimeMs,
        })
      }
    }

    for (const home of await generatedImageHomes()) {
      await scan(home, join(home, 'generated_images', codexThreadId))
    }
    return [...files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async function sendGeneratedImages(conversation: Conversation, codexThreadId: string | undefined, startedAt: number): Promise<number> {
    if (!codexThreadId || process.env.CODEX_WECHAT_SEND_ARTIFACTS === '0') return 0
    const images = await collectGeneratedImages(codexThreadId, startedAt)
    if (!images.length) return 0

    const maxFiles = envInt('CODEX_WECHAT_ARTIFACT_MAX_FILES', DEFAULT_ARTIFACT_MAX_FILES, 0, 20)
    const maxBytes = envInt('CODEX_WECHAT_ARTIFACT_MAX_BYTES', DEFAULT_ARTIFACT_MAX_BYTES, 1024, 50 * 1024 * 1024)
    const sendable = images.filter(file => file.size <= maxBytes).slice(0, maxFiles)
    const tooLargeCount = images.filter(file => file.size > maxBytes).length

    let sent = 0
    for (const file of sendable) {
      if (await sendWxMedia(conversation.userId, file.absPath)) sent += 1
    }

    if (!sent) {
      await sendText(
        conversation,
        [
          `Codex generated ${images.length} image file(s), but none were sent to WeChat.`,
          ...images.slice(0, 5).map(file => `- ${file.absPath} (${formatBytes(file.size)})`),
          tooLargeCount ? `${tooLargeCount} image(s) exceeded ${formatBytes(maxBytes)}.` : '',
          'Check the codex-wechat terminal for wx media-send errors.',
        ].filter(Boolean).join('\n'),
      )
    }
    return sent
  }

  function formatWxSpawnError(err: unknown): Error {
    const error = err as NodeJS.ErrnoException
    if (error.code === 'ENOENT') {
      return new Error(
        `Cannot start wx binary "${opts.wxBin}": executable not found in PATH. ` +
        'Install or link the local wx CLI, or set CODEX_WECHAT_WX_BIN to an absolute path.',
      )
    }
    return err instanceof Error ? err : new Error(String(err))
  }

  function formatLiveStatus(run: ActiveRun, limit = 2600): string {
    const pending = queueLength(run.conversation.key)
    const queueText = pending ? ` ${pending} queued.` : ''
    const header = run.stopRequested
      ? `Codex is stopping (${elapsedSeconds(run.startedAt)}s total, ${elapsedSeconds(run.stopRequestedAt ?? run.startedAt)}s since interrupt).${queueText} Waiting for process exit.`
      : `Codex is running (${elapsedSeconds(run.startedAt)}s).${queueText} Use !stop to interrupt.`
    const lines = run.statusLines.slice(-6)
    const body = lines.length ? `\n\n${lines.join('\n\n')}` : ''
    return truncateText(`${header}${body}`, limit)
  }

  function formatRunningReply(run: ActiveRun, limit = 1600): string {
    const pending = queueLength(run.conversation.key)
    const queueText = pending ? ` ${pending} queued.` : ''
    const status = run.stopRequested
      ? `Codex is stopping (${elapsedSeconds(run.startedAt)}s total, ${elapsedSeconds(run.stopRequestedAt ?? run.startedAt)}s since interrupt).${queueText}`
      : `Codex is already running in this WeChat chat (${elapsedSeconds(run.startedAt)}s).${queueText}`
    return truncateText(
      `${status} This message was not queued. Send !status for the latest snapshot, !queue <message> to queue it, or !stop to interrupt.`,
      limit,
    )
  }

  function summarizeCodexEvent(event: unknown): string | undefined {
    if (!event || typeof event !== 'object') return undefined
    const ev = event as Record<string, unknown>
    const type = ev.type
    const item = ev.item && typeof ev.item === 'object' ? ev.item as Record<string, unknown> : undefined

    if (type === 'thread.started' && typeof ev.thread_id === 'string') {
      return `Session started: ${ev.thread_id}`
    }
    if (type === 'turn.started') return 'Turn started.'
    if (type === 'turn.completed') return 'Turn completed.'

    if (type === 'item.started' && item?.type === 'command_execution') {
      const command = typeof item.command === 'string' ? item.command : '(unknown command)'
      return `Running command:\n\`\`\`sh\n${escapeCodeBlock(truncateText(command, 500))}\n\`\`\``
    }

    if (type === 'item.completed' && item?.type === 'command_execution') {
      const command = typeof item.command === 'string' ? item.command : '(unknown command)'
      const exitCode = item.exit_code === null || item.exit_code === undefined ? '?' : String(item.exit_code)
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output.trim() : ''
      const outputBlock = output
        ? `\nOutput:\n\`\`\`text\n${escapeCodeBlock(truncateText(output, 700))}\n\`\`\``
        : ''
      return `Command finished with exit ${exitCode}:\n\`\`\`sh\n${escapeCodeBlock(truncateText(command, 300))}\n\`\`\`${outputBlock}`
    }

    if (type === 'item.completed' && item?.type === 'agent_message') {
      const text = typeof item.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : ''
      if (!text) return undefined
      if (text.toLowerCase() === 'agent response ready.') return undefined
      return `Agent message:\n${truncateText(text, 700)}`
    }

    return undefined
  }

  function appendStatusLine(run: ActiveRun, line: string): boolean {
    if (run.statusLines[run.statusLines.length - 1] === line) return false
    run.statusLines.push(line)
    if (run.statusLines.length > 30) run.statusLines.splice(0, run.statusLines.length - 30)
    return true
  }

  function queueLiveUpdate(conversationKey: string, line: string): void {
    const run = activeRuns.get(conversationKey)
    if (!run) return
    appendStatusLine(run, line)
  }

  async function sendLiveStatusNow(run: ActiveRun, line?: string): Promise<void> {
    if (line) appendStatusLine(run, line)
    await sendText(run.conversation, formatLiveStatus(run))
  }

  function scheduleLongRunNotice(run: ActiveRun): void {
    run.longRunNoticeTimer = setTimeout(() => {
      if (activeRuns.get(run.conversation.key) !== run) return
      if (run.stopRequested) return
      const pending = queueLength(run.conversation.key)
      const queueText = pending ? ` ${pending} queued.` : ''
      void sendText(
        run.conversation,
        `Codex is still working (${elapsedSeconds(run.startedAt)}s).${queueText}\nNo more automatic progress updates will be sent. Send !status to view a status snapshot, !queue <message> to queue another message, or !stop to interrupt.`,
      )
    }, LONG_RUN_NOTICE_MS)
  }

  function clearStopFollowup(run: ActiveRun): void {
    if (!run.stopFollowupTimer) return
    clearTimeout(run.stopFollowupTimer)
    run.stopFollowupTimer = undefined
  }

  function scheduleStopFollowup(run: ActiveRun): void {
    clearStopFollowup(run)
    run.stopFollowupTimer = setTimeout(() => {
      if (activeRuns.get(run.conversation.key) !== run) return
      void sendText(
        run.conversation,
        'Still stopping Codex. The bridge has escalated beyond Ctrl+C and will post the final status when the process exits.',
      )
    }, 10000)
  }

  function enqueuePrompt(conversation: Conversation, prompt: string, forceNew = false, imagePaths: string[] = []): number {
    const queue = queuedPrompts.get(conversation.key) ?? []
    queue.push({ prompt, queuedAt: Date.now(), conversation, forceNew, imagePaths })
    queuedPrompts.set(conversation.key, queue)
    return queue.length
  }

  async function runNextQueued(conversationKey: string): Promise<void> {
    if (activeRuns.has(conversationKey)) return
    const queue = queuedPrompts.get(conversationKey)
    if (!queue) return
    const next = queue.shift()
    if (!next) {
      queuedPrompts.delete(conversationKey)
      return
    }
    if (!queue.length) queuedPrompts.delete(conversationKey)
    await runCodexForConversation(next.conversation, next.prompt, {
      fromQueue: true,
      forceNew: Boolean(next.forceNew),
      imagePaths: next.imagePaths,
    })
  }

  function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`
  }

  function splitFirstToken(text: string): { token: string; rest: string } {
    const trimmed = text.trim()
    const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/)
    return { token: match?.[1] ?? '', rest: match?.[2]?.trim() ?? '' }
  }

  function payloadAfterCommand(content: string, command: string): string | undefined {
    const trimmed = content.trim()
    if (trimmed === command) return ''
    if (trimmed.startsWith(`${command} `)) return trimmed.slice(command.length).trim()
    return undefined
  }

  function normalizeWorkdir(input?: string): string {
    const raw = input?.trim()
    if (!raw) return opts.workdir
    if (raw === '~') return homedir()
    if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
    return resolve(opts.workdir, raw)
  }

  function parseWords(input: string): string[] {
    const words: string[] = []
    let current = ''
    let quote: '"' | "'" | undefined
    let escaping = false

    for (const ch of input) {
      if (escaping) {
        current += ch
        escaping = false
        continue
      }
      if (ch === '\\') {
        escaping = true
        continue
      }
      if (quote) {
        if (ch === quote) quote = undefined
        else current += ch
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (/\s/.test(ch)) {
        if (current) {
          words.push(current)
          current = ''
        }
        continue
      }
      current += ch
    }

    if (current) words.push(current)
    return words
  }

  function parseSessionsPayload(payload: string): { limit: number; cwd?: string; query?: string; help?: boolean } {
    const args = parseWords(payload)
    let limit = 20
    let cwd: string | undefined
    let query: string | undefined
    const positionalQuery: string[] = []

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--help' || arg === '-h') return { limit, help: true }
      if (arg === '--limit' || arg === '-n') {
        const value = args[++i]
        const parsed = Number.parseInt(value ?? '', 10)
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
          throw new Error('`--limit` must be an integer from 1 to 50 in WeChat.')
        }
        limit = parsed
        continue
      }
      if (arg === '--query' || arg === '-q') {
        const value = args[++i]
        if (!value) throw new Error('`--query` requires a value.')
        query = query ? `${query} ${value}` : value
        continue
      }
      if (arg === '--cwd') {
        const value = args[++i]
        if (!value) throw new Error('`--cwd` requires a value.')
        cwd = normalizeWorkdir(value)
        continue
      }
      if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
      positionalQuery.push(arg)
    }

    if (!query && positionalQuery.length) query = positionalQuery.join(' ')
    return { limit, cwd, query }
  }

  function inlineCode(text: string): string {
    return text.replace(/`/g, "'")
  }

  function shortPath(value?: string): string {
    if (!value) return '(unknown cwd)'
    const home = homedir()
    return value === home ? '~' : value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value
  }

  function formatDate(value: string): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    const pad = (number: number) => String(number).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function formatSessionList(rows: CodexSessionSummary[], filters: { limit: number; cwd?: string; query?: string }): string {
    const roots = codexSessionHomes().map(home => join(home, 'sessions'))
    const lines = [
      `Codex sessions from ${inlineCode(roots.map(shortPath).join(', '))}`,
      `Showing ${rows.length} recent session${rows.length === 1 ? '' : 's'}${filters.query ? ` matching ${inlineCode(filters.query)}` : ''}${filters.cwd ? ` in ${inlineCode(shortPath(filters.cwd))}` : ''}.`,
      '',
    ]

    rows.forEach((row, index) => {
      lines.push(`${index + 1}. ${formatDate(row.updatedAt)}  ${inlineCode(row.id)}`)
      lines.push(`   cwd: ${inlineCode(shortPath(row.cwd))}`)
      lines.push(`   home: ${inlineCode(shortPath(row.home))}`)
      if (row.preview) lines.push(`   text: ${truncateText(row.preview, 160)}`)
    })

    lines.push('')
    lines.push('Use here: !resume <session-id|--last> [workdir]')
    return lines.join('\n')
  }

  async function handleSessionsCommand(reply: (text: string) => Promise<void>, payload: string): Promise<void> {
    let filters: { limit: number; cwd?: string; query?: string; help?: boolean }
    try {
      filters = parseSessionsPayload(payload)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      await reply(`${text}\nUsage: !sessions [--limit 20] [--query text] [--cwd path]`)
      return
    }

    if (filters.help) {
      await reply('Usage: !sessions [--limit 20] [--query text] [--cwd path]\nExamples:\n!sessions\n!sessions --limit 10 --query pipeline\n!sessions --cwd ~/some/project')
      return
    }

    const rows = await listCodexSessions({
      limit: filters.limit,
      cwd: filters.cwd,
      query: filters.query,
    })
    await reply(rows.length ? formatSessionList(rows, filters) : 'No matching Codex sessions found.')
  }

  async function getBinding(conversationKey: string): Promise<Binding | undefined> {
    return (await loadBindings(bindingsFile))[conversationKey]
  }

  async function resolveBindTarget(sessionRef: string, cwdText?: string): Promise<ResolvedBindTarget> {
    const codexThreadId = await resolveCodexSessionId(sessionRef)
    const session = await findCodexSessionSummary(codexThreadId)
    if (cwdText?.trim()) {
      return {
        codexThreadId,
        codexHome: session?.home,
        cwd: normalizeWorkdir(cwdText),
        cwdSource: 'explicit',
      }
    }

    if (!session?.cwd) {
      throw new Error(
        `Cannot infer workdir for Codex session ${codexThreadId}. ` +
        'Use !resume <session-id> <workdir>, or set CODEX_HOME/CODEX_SESSION_HOMES to the Codex home that contains this session.',
      )
    }

    return {
      codexThreadId,
      codexHome: session.home,
      cwd: resolve(session.cwd),
      cwdSource: 'session',
    }
  }

  async function bindResolvedSession(conversation: Conversation, target: ResolvedBindTarget): Promise<BoundSession> {
    const binding = await upsertBinding(bindingsFile, conversation.key, {
      codexThreadId: target.codexThreadId,
      codexHome: target.codexHome,
      cwd: target.cwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      paused: false,
    })
    return { ...target, binding }
  }

  async function bindExistingSession(conversation: Conversation, sessionRef: string, cwdText?: string): Promise<BoundSession> {
    const target = await resolveBindTarget(sessionRef, cwdText)
    return await bindResolvedSession(conversation, target)
  }

  function formatBoundWorkdir(bound: BoundSession): string {
    const suffix = bound.cwdSource === 'session' ? ' (from Codex session)' : ' (explicit)'
    return `${bound.binding.cwd}${suffix}`
  }

  async function setPaused(conversationKey: string, paused: boolean): Promise<Binding | undefined> {
    const bindings = await loadBindings(bindingsFile)
    const binding = bindings[conversationKey]
    if (!binding) return undefined
    binding.paused = paused
    binding.updatedAt = new Date().toISOString()
    await saveBindings(bindingsFile, bindings)
    return binding
  }

  async function handleControlCommand(
    conversation: Conversation,
    content: string,
    reply: (text: string) => Promise<void>,
    imagePaths: string[] = [],
  ): Promise<boolean> {
    const [command] = content.trim().split(/\s+/, 1)
    if (!command?.startsWith('!')) return false

    if (command === '!help') {
      await reply([
        'Codex WeChat commands:',
        '!codex <task> start a new Codex session in this WeChat chat',
        '!resume <session-id|--last> [workdir] resume an existing local Codex session in this chat',
        '!sessions [--limit 20] [--query text] [--cwd path] list local sessions',
        '!queue <message> queue a message after the running turn',
        '!stop interrupt the running turn',
        '!status show binding and live status',
        '!attach print a local terminal handoff command',
      ].join('\n'))
      return true
    }

    if (command === '!resume') {
      const payload = payloadAfterCommand(content, command) ?? ''
      const { token: sessionRef, rest: cwdText } = splitFirstToken(payload)
      if (!sessionRef && command === '!resume') {
        const binding = await setPaused(conversation.key, false)
        await reply(binding
          ? 'WeChat handoff resumed. New messages in this chat will run Codex again.'
          : 'No Codex session is bound to this WeChat chat yet. Use !resume <codex-session-id|--last> [workdir] to attach a local session.')
        return true
      }
      if (!sessionRef) {
        await reply('Usage: !resume <codex-session-id|--last> [workdir]')
        return true
      }
      try {
        const bound = await bindExistingSession(conversation, sessionRef, cwdText)
        await reply(
          `Resumed Codex session in this WeChat chat: ${bound.binding.codexThreadId}\nWorkdir: ${formatBoundWorkdir(bound)}\nSend the next message here to continue that session.`,
        )
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        await reply(`Resume failed: ${text.slice(0, 2500)}`)
      }
      return true
    }

    if (command === '!sessions') {
      await handleSessionsCommand(reply, payloadAfterCommand(content, command) ?? '')
      return true
    }

    if (command === '!attach') {
      const binding = await getBinding(conversation.key)
      if (!binding) {
        await reply('No Codex session is bound to this WeChat chat yet.')
        return true
      }
      const cmd = `cd ${shellQuote(binding.cwd)} && ${opts.codexBin} resume ${binding.codexThreadId}`
      await reply(
        `Local terminal handoff:\n\n${cmd}\n\nUse !pause before working locally, then !resume when WeChat should run Codex again.`,
      )
      return true
    }

    if (command === '!stop' || command === '!cancel' || command === '!interrupt') {
      const active = activeRuns.get(conversation.key)
      if (!active) {
        await reply('No Codex turn is currently running in this WeChat chat.')
        return true
      }
      if (active.stopRequested) {
        await reply(`${formatLiveStatus(active, 2400)}\n\nInterrupt is already in progress for the current Codex turn.`)
        return true
      }
      active.stopRequested = true
      active.stopRequestedAt = Date.now()
      active.abort.abort()
      scheduleStopFollowup(active)
      await sendLiveStatusNow(active, 'Interrupt requested. Waiting for Codex to stop...')
      await reply('Interrupt requested. Stopping the current Codex turn. Final status will be posted here when Codex exits.')
      return true
    }

    if (command === '!queue') {
      const payload = payloadAfterCommand(content, command) ?? ''
      if (!payload) {
        await reply('Usage: !queue <message to run after the current Codex turn>')
        return true
      }
      const binding = await getBinding(conversation.key)
      if (binding?.paused) {
        await reply('This WeChat chat is paused for local terminal control. Use !resume before queueing WeChat turns.')
        return true
      }
      const position = enqueuePrompt(conversation, payload, false, imagePaths)
      const hasActive = activeRuns.has(conversation.key)
      await reply(hasActive
        ? `Queued at position ${position}. It will run after the current Codex turn.`
        : 'Queued. No Codex turn is running, so it will start now.')
      if (!hasActive) {
        void runNextQueued(conversation.key).catch(err => {
          console.error(`wechat queued turn failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
      return true
    }

    if (command === '!pause') {
      const binding = await setPaused(conversation.key, true)
      await reply(binding
        ? 'WeChat handoff paused. Continue locally with !attach; use !resume to let WeChat run Codex again.'
        : 'No Codex session is bound to this WeChat chat yet.')
      return true
    }

    if (command === '!status') {
      const binding = await getBinding(conversation.key)
      const active = activeRuns.get(conversation.key)
      const pending = queueLength(conversation.key)
      await reply(binding
        ? `Codex session: ${binding.codexThreadId}\nWorkdir: ${binding.cwd}\nMode: ${binding.paused ? 'paused for local terminal' : 'WeChat active'}${active ? `\n\n${formatLiveStatus(active, 2200)}` : ''}${pending && !active ? `\nQueued turns: ${pending}` : ''}`
        : 'No Codex session is bound to this WeChat chat yet.')
      return true
    }

    if (command === '!codex') {
      const payload = payloadAfterCommand(content, command) ?? ''
      if (!payload) {
        await reply('Usage: !codex <task>')
        return true
      }
      await runCodexForConversation(conversation, payload, { forceNew: true, startNotice: reply, imagePaths })
      return true
    }

    return false
  }

  async function runCodexForConversation(
    conversation: Conversation,
    prompt: string,
    options: { forceNew?: boolean; fromQueue?: boolean; startNotice?: (text: string) => Promise<void>; imagePaths?: string[] } = {},
  ): Promise<void> {
    const existing = activeRuns.get(conversation.key)
    if (existing) {
      const text = formatRunningReply(existing)
      if (options.startNotice) await options.startNotice(text)
      else await sendText(conversation, text)
      return
    }

    const active: ActiveRun = {
      abort: new AbortController(),
      conversation,
      startedAt: Date.now(),
      prompt,
      statusLines: ['Turn requested.'],
    }
    activeRuns.set(conversation.key, active)
    scheduleLongRunNotice(active)

    let artifactSnapshot: WorkspaceSnapshot | undefined
    let completedCodexThreadId: string | undefined
    let completedCwd: string | undefined
    let completedFinalText = ''
    try {
      const bindings = await loadBindings(bindingsFile)
      const existingBinding = bindings[conversation.key]
      const binding = options.forceNew ? undefined : existingBinding
      const cwd = binding?.cwd ?? opts.workdir
      const bindingCodexHome = binding?.codexHome ?? (binding?.codexThreadId
        ? (await findCodexSessionSummary(binding.codexThreadId))?.home
        : undefined)
      artifactSnapshot = await captureWorkspaceSnapshot(cwd)
      const result = await opts.runCodex({
        cwd,
        codexThreadId: binding?.codexThreadId,
        codexBin: opts.codexBin,
        codexGlobalOptions: opts.sandbox ? ['--sandbox', opts.sandbox] : [],
        codexOptions: opts.model ? ['--model', opts.model] : [],
        imagePaths: options.imagePaths,
        env: bindingCodexHome ? { CODEX_HOME: bindingCodexHome } : undefined,
        signal: active.abort.signal,
        onEvent: event => {
          const line = summarizeCodexEvent(event)
          if (line) queueLiveUpdate(conversation.key, line)
        },
        prompt,
      })
      await upsertBinding(bindingsFile, conversation.key, {
        codexThreadId: result.codexThreadId,
        codexHome: bindingCodexHome,
        cwd,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      completedCodexThreadId = result.codexThreadId
      completedCwd = cwd
      completedFinalText = result.finalText.trim()
    } catch (err) {
      if (err instanceof CodexRunInterruptedError || active.stopRequested) {
        const finalStatus = `Codex interrupted after ${elapsedSeconds(active.startedAt)}s.${active.stopRequestedAt ? ` Stop completed in ${elapsedSeconds(active.stopRequestedAt)}s after interrupt request.` : ''}`
        await sendText(conversation, finalStatus)
      } else {
        const text = err instanceof Error ? err.message : String(err)
        await sendText(conversation, `Codex failed: ${text.slice(0, 2500)}`)
      }
    } finally {
      if (active.longRunNoticeTimer) clearTimeout(active.longRunNoticeTimer)
      clearStopFollowup(active)
      let sentGeneratedImages = 0
      try {
        sentGeneratedImages = await sendGeneratedImages(conversation, completedCodexThreadId, active.startedAt)
        await sendWorkspaceArtifacts(conversation, artifactSnapshot)
      } catch (err) {
        console.error(`wechat artifact send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (completedCodexThreadId && completedCwd && completedFinalText) {
        await sendText(
          conversation,
          `Codex completed in ${elapsedSeconds(active.startedAt)}s.\nSession: ${completedCodexThreadId}\nWorkdir: ${completedCwd}\n\n${completedFinalText}`,
        )
      } else if (completedCodexThreadId && completedCwd && !sentGeneratedImages) {
        await sendText(
          conversation,
          `Codex completed in ${elapsedSeconds(active.startedAt)}s.\nSession: ${completedCodexThreadId}\nWorkdir: ${completedCwd}\n\n(no final response)`,
        )
      }
      if (activeRuns.get(conversation.key) === active) activeRuns.delete(conversation.key)
      void runNextQueued(conversation.key).catch(err => {
        console.error(`wechat queued turn failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  async function handleMessage(msg: WeChatMessage): Promise<void> {
    const conversation = weChatConversationFromMessage(msg)
    if (!conversation) return

    const dedupeKey = messageDedupeKey(msg)
    if (dedupeKey && seenMessages.has(dedupeKey)) return
    if (dedupeKey) {
      seenMessages.add(dedupeKey)
      if (seenMessages.size > 1000) {
        const first = seenMessages.values().next().value
        if (first) seenMessages.delete(first)
      }
    }

    const content = describeWeChatMessage(msg).trim()
    if (!content) return
    const imagePaths = imagePathsFromMessage(msg)

    const reply = (text: string) => sendText(conversation, text)
    if (await handleControlCommand(conversation, content, reply, imagePaths)) return

    const binding = await getBinding(conversation.key)
    if (!binding) {
      await reply('No Codex session is bound here yet. Use !codex <task> to start one, or !resume <session-id|--last> to attach a local session.')
      return
    }
    if (binding.paused) {
      await reply('This WeChat chat is paused for local terminal control. Use !resume to let WeChat run Codex again.')
      return
    }
    await runCodexForConversation(conversation, content, { startNotice: reply, imagePaths })
  }

  function messageDedupeKey(msg: WeChatMessage): string | undefined {
    if (msg.message_id !== undefined) return `id:${msg.message_id}`
    if (msg.seq !== undefined) return `seq:${msg.seq}`
    if (msg.from_user_id && msg.create_time_ms) return `${msg.from_user_id}:${msg.create_time_ms}:${describeWeChatMessage(msg)}`
    return undefined
  }

  function printReadyBanner(): void {
    console.error('')
    console.error('[codex-wechat] READY - local WeChat bridge is running')
    console.error(`  wx binary:    ${opts.wxBin}`)
    console.error(`  workdir:      ${opts.workdir}`)
    console.error(`  codex binary: ${opts.codexBin}`)
    console.error(`  sandbox:      ${opts.sandbox}`)
    if (opts.model) console.error(`  model:        ${opts.model}`)
    console.error(`  state dir:    ${opts.stateDir}`)
    console.error(`  session homes: ${codexSessionHomes().map(shortPath).join(', ')}`)
    console.error('')
    console.error('Use WeChat:')
    console.error('  !codex <task>                  start a new Codex session in this chat')
    console.error('  !resume <session-id|--last>    resume the latest or a specific local Codex session')
    console.error('  !sessions [--limit 20]         list recent local Codex sessions')
    console.error('  !queue <message>               queue a message after the running turn')
    console.error('  !stop                          interrupt the running Codex turn')
    console.error('  !status                        show the bound session and live status')
    console.error('')
    console.error('No output here is normal while the bridge is waiting for WeChat messages.')
    console.error('Press Ctrl+C to stop.')
    console.error('')
  }

  function handleWatchLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    void (async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed) as unknown
      } catch {
        if (opts.debug) console.error(`wechat watch output: ${trimmed}`)
        return
      }
      const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
      if (typeof record?.bridge_event === 'string') {
        handleBridgeAck(record as BridgeAck)
        return
      }
      const msg = parsed as WeChatMessage
      if (opts.debug) {
        console.error(`wechat message: ${JSON.stringify({
          from_user_id: msg.from_user_id,
          message_type: msg.message_type,
          message_id: msg.message_id,
          seq: msg.seq,
          text: truncateText(describeWeChatMessage(msg), 160),
        })}`)
      }
      await handleMessage(msg)
    })().catch(err => {
      console.error(`wechat message handler failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  function startWatch(): void {
    if (stopping) return
    const child = spawn(opts.wxBin, ['bridge', '--resume', '--json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    watchProcess = child

    let stdoutBuffer = ''
    let stderrBuffer = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk
      let idx: number
      while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, idx)
        stdoutBuffer = stdoutBuffer.slice(idx + 1)
        handleWatchLine(line)
      }
    })

    child.stderr.on('data', chunk => {
      stderrBuffer += chunk
      let idx: number
      while ((idx = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, idx).trim()
        stderrBuffer = stderrBuffer.slice(idx + 1)
        if (line) console.error(`wx bridge: ${line}`)
      }
    })

    child.on('error', err => {
      console.error(formatWxSpawnError(err).message)
    })

    child.on('close', code => {
      if (watchProcess === child) watchProcess = undefined
      clearPendingBridgeAcks()
      if (stopping) return
      console.error(`wx bridge exited ${code ?? 'unknown'}. Restarting in 5s.`)
      setTimeout(startWatch, 5000)
    })
  }

  function stopWatch(): void {
    stopping = true
    clearPendingBridgeAcks()
    if (!watchProcess) return
    try {
      watchProcess.kill('SIGTERM')
    } catch {}
  }

  process.once('SIGINT', () => {
    stopWatch()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    stopWatch()
    process.exit(143)
  })

  startWatch()
  printReadyBanner()
}
