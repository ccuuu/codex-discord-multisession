import { request, ProxyAgent, type Dispatcher, type Dispatcher as UndiciDispatcher } from 'undici'
import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { createServer, type Socket, type Server } from 'node:net'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadBindings, saveBindings, upsertBinding, type Binding } from './bindings.js'
import { codexSessionHomes, findCodexSessionSummary, listCodexSessions, resolveCodexSessionId, type CodexSessionSummary } from './codex-sessions.js'
import { CodexRunInterruptedError } from './codex-runner.js'

export type DiscordDaemonOptions = {
  token: string
  parentChannelId: string
  stateDir: string
  workdir: string
  codexBin: string
  sandbox: string
  model?: string
  proxy?: string
  debug?: boolean
  runCodex: typeof import('./codex-runner.js').runCodex
}

type DiscordMessage = {
  id: string
  channel_id: string
  content: string
  author: { id: string; username: string; bot?: boolean }
}

type DiscordInteraction = {
  id: string
  token: string
  type: number
  channel_id?: string
  data?: {
    custom_id?: string
    component_type?: number
    values?: string[]
    components?: Array<{
      components?: Array<{
        custom_id?: string
        value?: string
      }>
    }>
  }
  member?: { user?: { id: string } }
  user?: { id: string }
  message?: {
    id: string
    content?: string
    channel_id?: string
  }
}

type DiscordChannel = {
  id: string
  parent_id?: string | null
  type?: number
}

type RestJson = Record<string, unknown>

type ActiveRun = {
  abort: AbortController
  discordThreadId: string
  startedAt: number
  prompt: string
  statusMessageId: string
  statusLines: string[]
  editTimer?: NodeJS.Timeout
  stopRequested?: boolean
  stopRequestedAt?: number
  stopFollowupTimer?: NodeJS.Timeout
}

type QueuedPrompt = {
  prompt: string
  queuedAt: number
}

type AskOption = {
  label: string
  description?: string
}

type AskQuestion = {
  question: string
  header?: string
  options: AskOption[]
  multiSelect?: boolean
}

type AskAnswer = {
  selection: string | string[]
  notes?: string
}

type PendingAsk = {
  requestId: string
  discordThreadId: string
  questions: AskQuestion[]
  currentIdx: number
  answers: AskAnswer[]
  selectValues: Map<number, string[]>
  messageIds: Map<number, string>
  socket: Socket
  timer: NodeJS.Timeout
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

export async function startDiscordDaemon(opts: DiscordDaemonOptions): Promise<void> {
  const bindingsFile = join(opts.stateDir, 'bindings.json')
  const askSocket = join(opts.stateDir, 'ask.sock')
  const activeRuns = new Map<string, ActiveRun>()
  const queuedPrompts = new Map<string, QueuedPrompt[]>()
  const pendingAsks = new Map<string, PendingAsk>()
  const managedThreads = new Set<string>()
  const restDispatcher: Dispatcher | undefined = opts.proxy ? new ProxyAgent(opts.proxy) : undefined
  const wsAgent = opts.proxy ? new HttpsProxyAgent(opts.proxy) : undefined
  let askServer: Server | undefined

  if (opts.proxy) console.error(`discord proxy enabled: ${opts.proxy}`)

  for (const threadId of Object.keys(await loadBindings(bindingsFile))) {
    managedThreads.add(threadId)
  }

  async function discordRequest(method: UndiciDispatcher.HttpMethod, path: string, body?: RestJson): Promise<any> {
    const res = await request(`https://discord.com/api/v10${path}`, {
      method,
      dispatcher: restDispatcher,
      headers: {
        authorization: `Bot ${opts.token}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.body.text()
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`Discord REST ${method} ${path} failed: ${res.statusCode} ${text.slice(0, 500)}`)
    }
    return text ? JSON.parse(text) : null
  }

  async function sendMessage(channelId: string, content: string, options: { components?: unknown[] } = {}): Promise<string> {
    const body: RestJson = {
      content,
      allowed_mentions: { parse: [] },
    }
    if (options.components) body.components = options.components
    const msg = await discordRequest('POST', `/channels/${channelId}/messages`, body)
    return String(msg.id)
  }

  async function editMessage(channelId: string, messageId: string, content: string, options: { components?: unknown[] } = {}): Promise<void> {
    const body: RestJson = {
      content,
      allowed_mentions: { parse: [] },
    }
    if (options.components) body.components = options.components
    await discordRequest('PATCH', `/channels/${channelId}/messages/${messageId}`, body)
  }

  async function createThread(parentId: string, name: string): Promise<string> {
    const thread = await discordRequest('POST', `/channels/${parentId}/threads`, {
      name,
      type: 11,
      auto_archive_duration: 1440,
    })
    return String(thread.id)
  }

  async function respondToInteraction(interaction: DiscordInteraction, type: number, data?: RestJson): Promise<void> {
    const body: RestJson = { type }
    if (data) body.data = data
    await discordRequest('POST', `/interactions/${interaction.id}/${interaction.token}/callback`, body)
  }

  async function updateInteractionMessage(interaction: DiscordInteraction, content: string, components: unknown[] = []): Promise<void> {
    await respondToInteraction(interaction, 7, {
      content,
      components,
      allowed_mentions: { parse: [] },
    })
  }

  async function replyInteractionEphemeral(interaction: DiscordInteraction, content: string): Promise<void> {
    await respondToInteraction(interaction, 4, {
      content,
      flags: 64,
      allowed_mentions: { parse: [] },
    })
  }

  function chunkDiscord(text: string, limit = 1900): string[] {
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

  async function sendChunks(channelId: string, text: string): Promise<void> {
    for (const chunk of chunkDiscord(text)) {
      await sendMessage(channelId, chunk)
    }
  }

  function escapeCodeBlock(text: string): string {
    return text.replace(/```/g, '``\u200b`')
  }

  function truncateText(text: string, limit: number): string {
    if (text.length <= limit) return text
    return `${text.slice(0, Math.max(0, limit - 20))}\n... [truncated]`
  }

  function truncateComponentText(text: string, limit: number): string {
    const oneLine = text.replace(/\s+/g, ' ').trim()
    if (oneLine.length <= limit) return oneLine
    return `${oneLine.slice(0, Math.max(0, limit - 3))}...`
  }

  function elapsedSeconds(startedAt: number): number {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  }

  function queueLength(discordThreadId: string): number {
    return queuedPrompts.get(discordThreadId)?.length ?? 0
  }

  function formatLiveStatus(run: ActiveRun, limit = 1900): string {
    const pending = queueLength(run.discordThreadId)
    const queueText = pending ? ` ${pending} queued.` : ''
    const header = run.stopRequested
      ? `Codex is stopping (${elapsedSeconds(run.startedAt)}s total, ${elapsedSeconds(run.stopRequestedAt ?? run.startedAt)}s since interrupt).${queueText} Waiting for process exit.`
      : `Codex is running (${elapsedSeconds(run.startedAt)}s).${queueText} Use \`!stop\` to interrupt.`
    const lines = run.statusLines.slice(-8)
    const body = lines.length ? `\n\n${lines.join('\n\n')}` : ''
    return truncateText(`${header}${body}`, limit)
  }

  function summarizeCodexEvent(event: unknown): string | undefined {
    if (!event || typeof event !== 'object') return undefined
    const ev = event as Record<string, unknown>
    const type = ev.type
    const item = ev.item && typeof ev.item === 'object' ? ev.item as Record<string, unknown> : undefined

    if (type === 'thread.started' && typeof ev.thread_id === 'string') {
      return `Session started: \`${ev.thread_id}\``
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
      return `Command finished with exit ${exitCode}:\n\`\`\`sh\n${escapeCodeBlock(truncateText(command, 350))}\n\`\`\`${outputBlock}`
    }

    if (type === 'item.completed' && item?.type === 'agent_message') {
      const text = typeof item.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : ''
      if (!text) return undefined
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

  function queueLiveUpdate(discordThreadId: string, line: string): void {
    const run = activeRuns.get(discordThreadId)
    if (!run) return
    if (!appendStatusLine(run, line)) return
    if (run.editTimer) return
    run.editTimer = setTimeout(() => {
      run.editTimer = undefined
      editMessage(discordThreadId, run.statusMessageId, formatLiveStatus(run)).catch(() => {})
    }, 1200)
  }

  async function editLiveStatusNow(run: ActiveRun, line?: string): Promise<void> {
    if (line) appendStatusLine(run, line)
    if (run.editTimer) {
      clearTimeout(run.editTimer)
      run.editTimer = undefined
    }
    await editMessage(run.discordThreadId, run.statusMessageId, formatLiveStatus(run)).catch(() => {})
  }

  function clearStopFollowup(run: ActiveRun): void {
    if (!run.stopFollowupTimer) return
    clearTimeout(run.stopFollowupTimer)
    run.stopFollowupTimer = undefined
  }

  function scheduleStopFollowup(run: ActiveRun): void {
    clearStopFollowup(run)
    run.stopFollowupTimer = setTimeout(() => {
      if (activeRuns.get(run.discordThreadId) !== run) return
      void (async () => {
        await editLiveStatusNow(run, 'Still stopping. The bridge has escalated beyond Ctrl+C and is waiting for Codex to exit.')
        await sendMessage(run.discordThreadId, 'Still stopping Codex. Final status will be posted here when the process exits.').catch(() => {})
      })()
    }, 10000)
  }

  function askMcpEnabled(): boolean {
    return process.env.CODEX_DISCORD_ASK_MCP !== '0'
  }

  function tomlString(value: string): string {
    return JSON.stringify(value)
  }

  function tomlArray(values: string[]): string {
    return `[${values.map(tomlString).join(', ')}]`
  }

  function askMcpScriptPath(): string {
    return fileURLToPath(new URL('../bin/codex-discord-mcp.js', import.meta.url))
  }

  function askMcpConfigOptions(): string[] {
    if (!askMcpEnabled()) return []
    return [
      '-c',
      `mcp_servers.codex_discord.command=${tomlString(process.execPath)}`,
      '-c',
      `mcp_servers.codex_discord.args=${tomlArray([askMcpScriptPath()])}`,
    ]
  }

  function withAskInstruction(prompt: string): string {
    if (!askMcpEnabled()) return prompt
    return [
      'Codex Discord bridge note: when you need the user to choose between options, confirm a decision, or provide missing input, call the MCP tool `ask_user_question` instead of ending the turn with a plain question. The tool will ask the user in this Discord thread and return the answer.',
      '',
      prompt,
    ].join('\n')
  }

  function button(customId: string, label: string, style = 1): RestJson {
    return {
      type: 2,
      custom_id: customId,
      label: truncateComponentText(label, 80),
      style,
    }
  }

  function actionRow(components: unknown[]): RestJson {
    return { type: 1, components }
  }

  function renderAskQuestion(pending: PendingAsk, question: AskQuestion): string {
    const prefix = pending.questions.length > 1 ? `Question ${pending.currentIdx + 1} of ${pending.questions.length}\n` : ''
    const header = question.header ? `**${question.header}**\n` : ''
    const options = question.options.length
      ? `\n\n${question.options.map((option, index) => {
        const description = option.description ? ` - ${option.description}` : ''
        return `${index + 1}. **${option.label}**${description}`
      }).join('\n')}`
      : '\n\nUse the button below to answer.'
    return truncateText(`${prefix}${header}${question.question}${options}`, 1900)
  }

  function buildAskComponents(requestId: string, qIdx: number, question: AskQuestion): RestJson[] {
    const options = question.options.slice(0, 20)
    if (!options.length) {
      return [actionRow([
        button(`ask:other:${requestId}:${qIdx}`, 'Answer...', 1),
      ])]
    }

    if (!question.multiSelect && options.length <= 5) {
      const buttons = options.map((option, index) => button(`ask:btn:${requestId}:${qIdx}:${index}`, option.label, 1))
      buttons.push(button(`ask:other:${requestId}:${qIdx}`, 'Other...', 2))
      const rows: RestJson[] = []
      for (let i = 0; i < buttons.length; i += 5) rows.push(actionRow(buttons.slice(i, i + 5)))
      return rows
    }

    const select = {
      type: 3,
      custom_id: `ask:sel:${requestId}:${qIdx}`,
      placeholder: question.multiSelect ? 'Pick one or more...' : 'Pick one...',
      min_values: 1,
      max_values: question.multiSelect ? Math.min(options.length, 20) : 1,
      options: options.map((option, index) => ({
        label: truncateComponentText(option.label, 100),
        value: String(index),
        ...(option.description ? { description: truncateComponentText(option.description, 100) } : {}),
      })),
    }
    const rows: RestJson[] = [actionRow([select])]
    if (question.multiSelect) {
      rows.push(actionRow([
        button(`ask:sub:${requestId}:${qIdx}`, 'Submit', 3),
        button(`ask:other:${requestId}:${qIdx}`, 'Other...', 2),
      ]))
    } else {
      rows.push(actionRow([
        button(`ask:other:${requestId}:${qIdx}`, 'Other...', 2),
      ]))
    }
    return rows
  }

  function modalText(interaction: DiscordInteraction): string {
    for (const row of interaction.data?.components ?? []) {
      for (const component of row.components ?? []) {
        if (component.custom_id === 'text' && typeof component.value === 'string') return component.value.trim()
      }
    }
    return ''
  }

  function finishAsk(pending: PendingAsk, response: { ok: boolean; answers?: AskAnswer[]; error?: string }): void {
    clearTimeout(pending.timer)
    pendingAsks.delete(pending.requestId)
    try {
      pending.socket.write(`${JSON.stringify(response)}\n`)
      pending.socket.end()
    } catch {}
  }

  async function postCurrentAskQuestion(pending: PendingAsk): Promise<void> {
    const question = pending.questions[pending.currentIdx]
    if (!question) {
      finishAsk(pending, { ok: true, answers: pending.answers })
      return
    }
    const messageId = await sendMessage(
      pending.discordThreadId,
      renderAskQuestion(pending, question),
      { components: buildAskComponents(pending.requestId, pending.currentIdx, question) },
    )
    pending.messageIds.set(pending.currentIdx, messageId)
  }

  async function advanceAsk(pending: PendingAsk): Promise<void> {
    pending.currentIdx += 1
    if (pending.currentIdx >= pending.questions.length) {
      finishAsk(pending, { ok: true, answers: pending.answers })
      return
    }
    await postCurrentAskQuestion(pending)
  }

  async function handleAskInteraction(interaction: DiscordInteraction): Promise<boolean> {
    const customId = interaction.data?.custom_id
    if (!customId?.startsWith('ask:')) return false
    const parts = customId.split(':')
    const kind = parts[1]
    const requestId = parts[2]
    const qIdx = Number.parseInt(parts[3] ?? '-1', 10)
    const pending = requestId ? pendingAsks.get(requestId) : undefined
    if (!pending) {
      await replyInteractionEphemeral(interaction, 'This question is no longer pending.').catch(() => {})
      return true
    }
    if (interaction.channel_id && interaction.channel_id !== pending.discordThreadId) {
      await replyInteractionEphemeral(interaction, 'This question belongs to another Discord thread.').catch(() => {})
      return true
    }
    if (qIdx !== pending.currentIdx) {
      await replyInteractionEphemeral(interaction, 'That question was already answered.').catch(() => {})
      return true
    }
    const question = pending.questions[qIdx]
    if (!question) return true
    if (kind === 'btn') {
      const optIdx = Number.parseInt(parts[4] ?? '-1', 10)
      const option = question.options[optIdx]
      if (!option) {
        await replyInteractionEphemeral(interaction, 'Invalid option.').catch(() => {})
        return true
      }
      pending.answers.push({ selection: option.label })
      const content = `${interaction.message?.content ?? renderAskQuestion(pending, question)}\n\nSelected: **${option.label}**`
      await updateInteractionMessage(interaction, content, []).catch(() => {})
      await advanceAsk(pending).catch(err => finishAsk(pending, { ok: false, error: err instanceof Error ? err.message : String(err) }))
      return true
    }

    if (kind === 'sel') {
      const values = (interaction.data?.values ?? [])
        .map(value => question.options[Number.parseInt(value, 10)]?.label)
        .filter((value): value is string => Boolean(value))
      if (question.multiSelect) {
        pending.selectValues.set(qIdx, values)
        await respondToInteraction(interaction, 6).catch(() => {})
        return true
      }
      const selection = values[0] ?? ''
      pending.answers.push({ selection })
      const content = `${interaction.message?.content ?? renderAskQuestion(pending, question)}\n\nSelected: **${selection}**`
      await updateInteractionMessage(interaction, content, []).catch(() => {})
      await advanceAsk(pending).catch(err => finishAsk(pending, { ok: false, error: err instanceof Error ? err.message : String(err) }))
      return true
    }

    if (kind === 'sub') {
      const values = pending.selectValues.get(qIdx) ?? []
      if (!values.length) {
        await replyInteractionEphemeral(interaction, 'Pick at least one option first.').catch(() => {})
        return true
      }
      pending.answers.push({ selection: values })
      const content = `${interaction.message?.content ?? renderAskQuestion(pending, question)}\n\nSelected: **${values.join(', ')}**`
      await updateInteractionMessage(interaction, content, []).catch(() => {})
      await advanceAsk(pending).catch(err => finishAsk(pending, { ok: false, error: err instanceof Error ? err.message : String(err) }))
      return true
    }

    if (kind === 'other') {
      await respondToInteraction(interaction, 9, {
        custom_id: `ask:mod:${requestId}:${qIdx}`,
        title: truncateComponentText(question.header ?? question.question, 45),
        components: [
          actionRow([
            {
              type: 4,
              custom_id: 'text',
              label: 'Your answer',
              style: 2,
              required: true,
              max_length: 4000,
            },
          ]),
        ],
      }).catch(() => {})
      return true
    }

    if (kind === 'mod') {
      const text = modalText(interaction)
      if (!text) {
        await replyInteractionEphemeral(interaction, 'Answer cannot be empty.').catch(() => {})
        return true
      }
      pending.answers.push({ selection: 'Other', notes: text })
      const messageId = pending.messageIds.get(qIdx)
      if (messageId) {
        await editMessage(
          pending.discordThreadId,
          messageId,
          `${renderAskQuestion(pending, question)}\n\nSelected: **Other**\n${truncateText(text, 500)}`,
          { components: [] },
        ).catch(() => {})
      }
      await replyInteractionEphemeral(interaction, 'Recorded.').catch(() => {})
      await advanceAsk(pending).catch(err => finishAsk(pending, { ok: false, error: err instanceof Error ? err.message : String(err) }))
      return true
    }

    return true
  }

  function startAskServer(): void {
    if (!askMcpEnabled()) return
    mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 })
    try {
      if (existsSync(askSocket)) unlinkSync(askSocket)
    } catch {}
    askServer = createServer(socket => {
      let buffer = ''
      let requestId: string | undefined
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        buffer += chunk
        const idx = buffer.indexOf('\n')
        if (idx < 0) return
        const line = buffer.slice(0, idx).trim()
        if (!line) return
        try {
          const request = JSON.parse(line) as {
            type?: string
            requestId?: string
            discordThreadId?: string
            questions?: AskQuestion[]
            timeoutMs?: number
          }
          if (request.type !== 'ask_user_question') throw new Error('unknown ask request type')
          if (!request.requestId || !/^[a-zA-Z0-9_-]{4,40}$/.test(request.requestId)) throw new Error('invalid request id')
          if (!request.discordThreadId) throw new Error('missing discord thread id')
          if (!Array.isArray(request.questions) || !request.questions.length) throw new Error('missing questions')
          requestId = request.requestId
          const timeoutMs = Math.max(10_000, Math.min(Number(request.timeoutMs ?? 600_000), 60 * 60 * 1000))
          const pending: PendingAsk = {
            requestId,
            discordThreadId: request.discordThreadId,
            questions: request.questions.slice(0, 4).map(question => ({
              question: String(question.question ?? '').slice(0, 1800),
              ...(question.header ? { header: String(question.header).slice(0, 80) } : {}),
              options: Array.isArray(question.options)
                ? question.options.slice(0, 20).map(option => ({
                  label: String(option.label ?? '').slice(0, 100),
                  ...(option.description ? { description: String(option.description).slice(0, 100) } : {}),
                })).filter(option => option.label)
                : [],
              ...(question.multiSelect ? { multiSelect: true } : {}),
            })).filter(question => question.question),
            currentIdx: 0,
            answers: [],
            selectValues: new Map(),
            messageIds: new Map(),
            socket,
            timer: setTimeout(() => {
              const active = pendingAsks.get(request.requestId!)
              if (active) finishAsk(active, { ok: false, error: 'Timed out waiting for a Discord answer.' })
            }, timeoutMs),
          }
          if (!pending.questions.length) throw new Error('missing valid questions')
          pendingAsks.set(request.requestId, pending)
          void postCurrentAskQuestion(pending).catch(err => finishAsk(pending, { ok: false, error: err instanceof Error ? err.message : String(err) }))
        } catch (err) {
          socket.write(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`)
          socket.end()
        }
      })
      socket.on('close', () => {
        if (!requestId) return
        const pending = pendingAsks.get(requestId)
        if (pending?.socket === socket) {
          clearTimeout(pending.timer)
          pendingAsks.delete(requestId)
        }
      })
    })
    askServer.listen(askSocket, () => {
      if (opts.debug) console.error(`discord ask socket: ${askSocket}`)
    })
    askServer.on('error', err => {
      console.error(`discord ask socket error: ${err.message}`)
    })
  }

  function enqueuePrompt(discordThreadId: string, prompt: string): number {
    const queue = queuedPrompts.get(discordThreadId) ?? []
    queue.push({ prompt, queuedAt: Date.now() })
    queuedPrompts.set(discordThreadId, queue)
    return queue.length
  }

  async function runNextQueued(discordThreadId: string): Promise<void> {
    if (activeRuns.has(discordThreadId)) return
    const queue = queuedPrompts.get(discordThreadId)
    if (!queue) return
    const next = queue.shift()
    if (!next) {
      queuedPrompts.delete(discordThreadId)
      return
    }
    if (!queue.length) queuedPrompts.delete(discordThreadId)
    await sendMessage(discordThreadId, `Starting queued message from ${elapsedSeconds(next.queuedAt)}s ago.`)
    await runCodexForThread(discordThreadId, next.prompt, true)
  }

  function threadNameFromPrompt(prompt: string): string {
    return prompt
      .replace(/[^\w .-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90) || 'codex-session'
  }

  function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`
  }

  function printReadyBanner(username: string): void {
    console.error('')
    console.error('[codex-discord] READY - Discord bridge is running')
    console.error(`  bot:            ${username}`)
    console.error(`  parent channel: ${opts.parentChannelId}`)
    console.error(`  workdir:        ${opts.workdir}`)
    console.error(`  codex binary:   ${opts.codexBin}`)
    console.error(`  sandbox:        ${opts.sandbox}`)
    if (opts.model) console.error(`  model:          ${opts.model}`)
    console.error(`  state dir:      ${opts.stateDir}`)
    console.error(`  session homes:  ${codexSessionHomes().map(shortPath).join(', ')}`)
    console.error(`  ask MCP:        ${askMcpEnabled() ? 'enabled' : 'disabled'}`)
    console.error('')
    console.error('Use Discord:')
    console.error('  !codex <task>                  start a new Codex session thread')
    console.error('  !codex-resume --last <name>    create a thread for the latest local Codex session')
    console.error('  !sessions [--limit 20]         list recent local Codex sessions')
    console.error('  !queue <message>               queue a message after the running turn')
    console.error('  !stop                          interrupt the running Codex turn in a thread')
    console.error('  !status                        show the bound session in a thread')
    console.error('')
    console.error('No output here is normal while the bot is waiting for Discord messages.')
    console.error('Press Ctrl+C to stop.')
    console.error('')
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
      if (arg === '--help' || arg === '-h') {
        return { limit, help: true }
      }
      if (arg === '--limit' || arg === '-n') {
        const value = args[++i]
        const parsed = Number.parseInt(value ?? '', 10)
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
          throw new Error('`--limit` must be an integer from 1 to 50 in Discord.')
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

  function parseParentResumePayload(payload: string): { sessionRef: string; threadName: string; cwdText?: string } {
    const { token: sessionRef, rest } = splitFirstToken(payload)
    if (!sessionRef) return { sessionRef, threadName: '' }

    const args = parseWords(rest)
    const nameParts: string[] = []
    let cwdText: string | undefined

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--cwd' || arg === '--workdir') {
        const value = args[++i]
        if (!value) throw new Error(`${arg} requires a value.`)
        cwdText = value
        continue
      }
      nameParts.push(arg)
    }

    return { sessionRef, threadName: nameParts.join(' '), cwdText }
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
      `Codex sessions from \`${inlineCode(roots.map(shortPath).join(', '))}\``,
      `Showing ${rows.length} recent session${rows.length === 1 ? '' : 's'}${filters.query ? ` matching \`${inlineCode(filters.query)}\`` : ''}${filters.cwd ? ` in \`${inlineCode(shortPath(filters.cwd))}\`` : ''}.`,
      '',
    ]

    rows.forEach((row, index) => {
      lines.push(`${index + 1}. ${formatDate(row.updatedAt)}  \`${inlineCode(row.id)}\``)
      lines.push(`   cwd: \`${inlineCode(shortPath(row.cwd))}\``)
      lines.push(`   home: \`${inlineCode(shortPath(row.home))}\``)
      if (row.preview) lines.push(`   text: ${truncateText(row.preview, 160)}`)
    })

    lines.push('')
    lines.push('Use in parent channel: `!codex-resume <session-id|--last> [--cwd path] <thread-name>`')
    lines.push('Use in a thread: `!resume <session-id|--last> [workdir]`')
    return lines.join('\n')
  }

  async function handleSessionsCommand(channelId: string, payload: string): Promise<void> {
    let filters: { limit: number; cwd?: string; query?: string; help?: boolean }
    try {
      filters = parseSessionsPayload(payload)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      await sendMessage(channelId, `${text}\nUsage: \`!sessions [--limit 20] [--query text] [--cwd path]\``)
      return
    }

    if (filters.help) {
      await sendMessage(channelId, 'Usage: `!sessions [--limit 20] [--query text] [--cwd path]`\nExamples:\n`!sessions`\n`!sessions --limit 10 --query pipeline`\n`!sessions --cwd ~/some/project`')
      return
    }

    const rows = await listCodexSessions({
      limit: filters.limit,
      cwd: filters.cwd,
      query: filters.query,
    })
    if (!rows.length) {
      await sendMessage(channelId, 'No matching Codex sessions found.')
      return
    }
    await sendChunks(channelId, formatSessionList(rows, filters))
  }

  async function getBinding(discordThreadId: string): Promise<Binding | undefined> {
    return (await loadBindings(bindingsFile))[discordThreadId]
  }

  async function getChannel(channelId: string): Promise<DiscordChannel> {
    return await discordRequest('GET', `/channels/${channelId}`) as DiscordChannel
  }

  async function isThreadUnderParent(channelId: string): Promise<boolean> {
    const channel = await getChannel(channelId)
    return String(channel.parent_id ?? '') === opts.parentChannelId
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
        'Use `!codex-resume <session-id> --cwd <workdir> <thread-name>` in the parent channel, ' +
        'use `!resume <session-id> <workdir>` in a thread, or set CODEX_HOME/CODEX_SESSION_HOMES to the Codex home that contains this session.',
      )
    }

    return {
      codexThreadId,
      codexHome: session.home,
      cwd: resolve(session.cwd),
      cwdSource: 'session',
    }
  }

  async function bindResolvedSession(discordThreadId: string, target: ResolvedBindTarget): Promise<BoundSession> {
    const binding = await upsertBinding(bindingsFile, discordThreadId, {
      codexThreadId: target.codexThreadId,
      codexHome: target.codexHome,
      cwd: target.cwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      paused: false,
    })
    managedThreads.add(discordThreadId)
    return { ...target, binding }
  }

  async function bindExistingSession(discordThreadId: string, sessionRef: string, cwdText?: string): Promise<BoundSession> {
    const target = await resolveBindTarget(sessionRef, cwdText)
    return await bindResolvedSession(discordThreadId, target)
  }

  function formatBoundWorkdir(bound: BoundSession): string {
    const suffix = bound.cwdSource === 'session' ? ' (from Codex session)' : ' (explicit)'
    return `${bound.binding.cwd}${suffix}`
  }

  async function setPaused(discordThreadId: string, paused: boolean): Promise<Binding | undefined> {
    const bindings = await loadBindings(bindingsFile)
    const binding = bindings[discordThreadId]
    if (!binding) return undefined
    binding.paused = paused
    binding.updatedAt = new Date().toISOString()
    await saveBindings(bindingsFile, bindings)
    return binding
  }

  async function handleControlCommand(discordThreadId: string, content: string): Promise<boolean> {
    const [command] = content.trim().split(/\s+/, 1)
    if (!command?.startsWith('!')) return false

    if (command === '!resume') {
      const payload = payloadAfterCommand(content, command) ?? ''
      const { token: sessionRef, rest: cwdText } = splitFirstToken(payload)
      if (!sessionRef && command === '!resume') {
        const binding = await setPaused(discordThreadId, false)
        await sendMessage(discordThreadId, binding
          ? 'Discord handoff resumed. New messages in this thread will run Codex again.'
          : 'No Codex session is bound to this thread yet. Use `!resume <codex-session-id|--last> [workdir]` to attach a local session.')
        return true
      }
      if (!sessionRef) {
        await sendMessage(discordThreadId, 'Usage: `!resume <codex-session-id|--last> [workdir]`')
        return true
      }
      try {
        const bound = await bindExistingSession(discordThreadId, sessionRef, cwdText)
        await sendMessage(
          discordThreadId,
          `Resumed Codex session in this Discord thread: ${bound.binding.codexThreadId}\nWorkdir: ${formatBoundWorkdir(bound)}\nSend the next message here to continue that session.`,
        )
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        await sendMessage(discordThreadId, `Resume failed: ${text.slice(0, 1800)}`)
      }
      return true
    }

    if (command === '!sessions') {
      await handleSessionsCommand(discordThreadId, payloadAfterCommand(content, command) ?? '')
      return true
    }

    if (command === '!attach') {
      const binding = await getBinding(discordThreadId)
      if (!binding) {
        await sendMessage(discordThreadId, 'No Codex session is bound to this thread yet.')
        return true
      }
      const cmd = `cd ${shellQuote(binding.cwd)} && ${opts.codexBin} resume ${binding.codexThreadId}`
      await sendMessage(
        discordThreadId,
        `Local terminal handoff:\n\n\`\`\`sh\n${cmd}\n\`\`\`\nUse \`!pause\` before working locally, then \`!resume\` when Discord should run Codex again.`,
      )
      return true
    }

    if (command === '!stop' || command === '!cancel' || command === '!interrupt') {
      const active = activeRuns.get(discordThreadId)
      if (!active) {
        await sendMessage(discordThreadId, 'No Codex turn is currently running in this thread.')
        return true
      }
      if (active.stopRequested) {
        await sendMessage(discordThreadId, `${formatLiveStatus(active, 1700)}\n\nInterrupt is already in progress for the current Codex turn.`)
        return true
      }
      active.stopRequested = true
      active.stopRequestedAt = Date.now()
      active.abort.abort()
      scheduleStopFollowup(active)
      await editLiveStatusNow(active, 'Interrupt requested. Waiting for Codex to stop...')
      await sendMessage(discordThreadId, 'Interrupt requested. Stopping the current Codex turn. Final status will be posted here when Codex exits.')
      return true
    }

    if (command === '!queue') {
      const payload = payloadAfterCommand(content, command) ?? ''
      if (!payload) {
        await sendMessage(discordThreadId, 'Usage: `!queue <message to run after the current Codex turn>`')
        return true
      }
      const binding = await getBinding(discordThreadId)
      if (binding?.paused) {
        await sendMessage(discordThreadId, 'This thread is paused for local terminal control. Use `!resume` before queueing Discord turns.')
        return true
      }
      const position = enqueuePrompt(discordThreadId, payload)
      const hasActive = activeRuns.has(discordThreadId)
      await sendMessage(discordThreadId, hasActive
        ? `Queued at position ${position}. It will run after the current Codex turn.`
        : 'Queued. No Codex turn is running, so it will start now.')
      if (!hasActive) {
        void runNextQueued(discordThreadId).catch(err => {
          console.error(`queued turn failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
      return true
    }

    if (command === '!pause') {
      const binding = await setPaused(discordThreadId, true)
      await sendMessage(discordThreadId, binding
        ? 'Discord handoff paused. Continue locally with `!attach`; use `!resume` to let Discord run Codex again.'
        : 'No Codex session is bound to this thread yet.')
      return true
    }

    if (command === '!status') {
      const binding = await getBinding(discordThreadId)
      const active = activeRuns.get(discordThreadId)
      const pending = queueLength(discordThreadId)
      await sendMessage(discordThreadId, binding
        ? `Codex session: ${binding.codexThreadId}\nWorkdir: ${binding.cwd}\nMode: ${binding.paused ? 'paused for local terminal' : 'Discord active'}${active ? `\n\n${formatLiveStatus(active, 1450)}` : ''}${pending && !active ? `\nQueued turns: ${pending}` : ''}`
        : 'No Codex session is bound to this thread yet.')
      return true
    }

    return false
  }

  async function runCodexForThread(discordThreadId: string, prompt: string, fromQueue = false): Promise<void> {
    const existing = activeRuns.get(discordThreadId)
    if (existing) {
      await sendMessage(
        discordThreadId,
        `${formatLiveStatus(existing, 1700)}\n\n` +
        'Your message was not queued or sent to Codex. Send `!queue <message>` to queue it, or `!stop` to interrupt.',
      )
      return
    }

    const workingId = await sendMessage(discordThreadId, fromQueue
      ? 'Codex is running a queued message. Live updates will appear here. Use `!stop` to interrupt.'
      : 'Codex is running. Live updates will appear here. Use `!stop` to interrupt.')
    const active: ActiveRun = {
      abort: new AbortController(),
      discordThreadId,
      startedAt: Date.now(),
      prompt,
      statusMessageId: workingId,
      statusLines: ['Turn requested.'],
    }
    activeRuns.set(discordThreadId, active)

    try {
      const bindings = await loadBindings(bindingsFile)
      const binding = bindings[discordThreadId]
      const bindingCodexHome = binding?.codexHome ?? (binding?.codexThreadId
        ? (await findCodexSessionSummary(binding.codexThreadId))?.home
        : undefined)
      const env = askMcpEnabled() || bindingCodexHome
        ? {
          ...(bindingCodexHome ? { CODEX_HOME: bindingCodexHome } : {}),
          ...(askMcpEnabled()
            ? {
              CODEX_DISCORD_THREAD_ID: discordThreadId,
              CODEX_DISCORD_STATE_DIR: opts.stateDir,
              CODEX_DISCORD_ASK_SOCKET: askSocket,
            }
            : {}),
        }
        : undefined
      const result = await opts.runCodex({
        cwd: binding?.cwd ?? opts.workdir,
        codexThreadId: binding?.codexThreadId,
        codexBin: opts.codexBin,
        codexGlobalOptions: [
          ...(opts.sandbox ? ['--sandbox', opts.sandbox] : []),
          ...askMcpConfigOptions(),
        ],
        codexOptions: opts.model ? ['--model', opts.model] : [],
        env,
        signal: active.abort.signal,
        onEvent: event => {
          const line = summarizeCodexEvent(event)
          if (line) queueLiveUpdate(discordThreadId, line)
        },
        prompt: withAskInstruction(prompt),
      })
      await upsertBinding(bindingsFile, discordThreadId, {
        codexThreadId: result.codexThreadId,
        codexHome: bindingCodexHome,
        cwd: binding?.cwd ?? opts.workdir,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      managedThreads.add(discordThreadId)
      await editMessage(discordThreadId, workingId, `Codex session: ${result.codexThreadId}\nCompleted in ${elapsedSeconds(active.startedAt)}s.`)
      await sendChunks(discordThreadId, result.finalText)
    } catch (err) {
      if (err instanceof CodexRunInterruptedError || active.stopRequested) {
        const finalStatus = `Codex interrupted after ${elapsedSeconds(active.startedAt)}s.${active.stopRequestedAt ? ` Stop completed in ${elapsedSeconds(active.stopRequestedAt)}s after interrupt request.` : ''}`
        await editMessage(discordThreadId, workingId, finalStatus).catch(() => {})
        await sendMessage(discordThreadId, finalStatus).catch(() => {})
      } else {
        const text = err instanceof Error ? err.message : String(err)
        await editMessage(discordThreadId, workingId, `Codex failed: ${text.slice(0, 1800)}`)
      }
    } finally {
      if (active.editTimer) clearTimeout(active.editTimer)
      clearStopFollowup(active)
      if (activeRuns.get(discordThreadId) === active) activeRuns.delete(discordThreadId)
      void runNextQueued(discordThreadId).catch(err => {
        console.error(`queued turn failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  async function handleMessage(msg: DiscordMessage): Promise<void> {
    if (msg.author.bot) return

    if (msg.channel_id === opts.parentChannelId) {
      const content = msg.content.trim()
      const sessionsPayload = payloadAfterCommand(content, '!sessions')
      if (sessionsPayload !== undefined) {
        await handleSessionsCommand(opts.parentChannelId, sessionsPayload)
        return
      }

      const resumePayload = payloadAfterCommand(content, '!codex-resume')
      if (resumePayload !== undefined) {
        let parsed
        try {
          parsed = parseParentResumePayload(resumePayload)
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err)
          await sendMessage(opts.parentChannelId, `Resume failed: ${text.slice(0, 1800)}`)
          return
        }
        const { sessionRef, threadName, cwdText } = parsed
        if (!sessionRef) {
          await sendMessage(opts.parentChannelId, 'Usage: `!codex-resume <codex-session-id|--last> [--cwd path] [thread name]`')
          return
        }
        let target
        try {
          target = await resolveBindTarget(sessionRef, cwdText)
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err)
          await sendMessage(opts.parentChannelId, `Resume failed: ${text.slice(0, 1800)}`)
          return
        }
        const threadId = await createThread(opts.parentChannelId, threadNameFromPrompt(threadName || `codex ${sessionRef}`))
        try {
          const bound = await bindResolvedSession(threadId, target)
          await sendMessage(
            threadId,
            `Resumed existing Codex session: ${bound.binding.codexThreadId}\nWorkdir: ${formatBoundWorkdir(bound)}\nSend a message here to continue that session.`,
          )
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err)
          await sendMessage(threadId, `Resume failed: ${text.slice(0, 1800)}`)
        }
        return
      }

      const prompt = payloadAfterCommand(content, '!codex') ?? ''
      if (!prompt) return
      const threadId = await createThread(opts.parentChannelId, threadNameFromPrompt(prompt))
      managedThreads.add(threadId)
      await sendMessage(threadId, `Starting Codex session for:\n${prompt}`)
      await runCodexForThread(threadId, prompt)
      return
    }

    if (!managedThreads.has(msg.channel_id) && (msg.content.trim().startsWith('!resume') || msg.content.trim().startsWith('!sessions'))) {
      try {
        if (await isThreadUnderParent(msg.channel_id)) {
          await handleControlCommand(msg.channel_id, msg.content.trim())
        }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        await sendMessage(msg.channel_id, `Resume failed: ${text.slice(0, 1800)}`)
      }
      return
    }

    if (managedThreads.has(msg.channel_id)) {
      const prompt = msg.content.trim()
      if (!prompt) return
      if (await handleControlCommand(msg.channel_id, prompt)) return
      const binding = await getBinding(msg.channel_id)
      if (binding?.paused) {
        await sendMessage(msg.channel_id, 'This thread is paused for local terminal control. Use `!resume` to let Discord run Codex again.')
        return
      }
      await runCodexForThread(msg.channel_id, prompt)
    }
  }

  function connectGateway(): void {
    if (opts.debug && opts.proxy) console.error(`discord ws proxy connect: wss://gateway.discord.gg via ${opts.proxy}`)
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json', wsAgent ? { agent: wsAgent } : undefined)
    let heartbeat: NodeJS.Timeout | null = null
    let seq: number | null = null

    ws.on('message', raw => {
      void (async () => {
        const packet = JSON.parse(String(raw))
        if (packet.s !== null && packet.s !== undefined) seq = packet.s

        if (packet.op === 10) {
          const interval = Number(packet.d.heartbeat_interval)
          heartbeat = setInterval(() => {
            ws.send(JSON.stringify({ op: 1, d: seq }))
          }, interval)
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: opts.token,
              intents: 1 | 512 | 32768,
              properties: {
                os: process.platform,
                browser: 'codex-discord-multisession',
                device: 'codex-discord-multisession',
              },
            },
          }))
          return
        }

        if (packet.t === 'READY') {
          printReadyBanner(String(packet.d.user.username))
          return
        }

        if (packet.t === 'MESSAGE_CREATE') {
          await handleMessage(packet.d as DiscordMessage)
          return
        }

        if (packet.t === 'INTERACTION_CREATE') {
          await handleAskInteraction(packet.d as DiscordInteraction)
        }
      })().catch(err => {
        console.error(`gateway message handler failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    })

    ws.on('close', (code, reason) => {
      if (heartbeat) clearInterval(heartbeat)
      console.error(`gateway closed: ${code} ${reason.toString()}`)
      setTimeout(connectGateway, 5000)
    })
    ws.on('error', err => {
      console.error(`gateway error: ${err.message}`)
    })
  }

  startAskServer()
  connectGateway()
}
