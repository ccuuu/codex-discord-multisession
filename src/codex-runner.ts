import { spawn } from 'node:child_process'
import { defaultCodexBin } from './config.js'

export type CodexRunOptions = {
  cwd: string
  prompt: string
  codexThreadId?: string
  codexBin?: string
  codexGlobalOptions?: string[]
  codexOptions?: string[]
  imagePaths?: string[]
  env?: Record<string, string>
  signal?: AbortSignal
  onEvent?: (event: unknown) => void | Promise<void>
}

export type CodexRunResult = {
  codexThreadId: string
  finalText: string
  events: unknown[]
}

type JsonEvent = {
  type?: string
  thread_id?: string
  item?: {
    type?: string
    text?: string
  }
}

export class CodexRunInterruptedError extends Error {
  constructor() {
    super('Codex run interrupted')
    this.name = 'CodexRunInterruptedError'
  }
}

function formatSpawnError(bin: string, err: unknown): Error {
  const error = err as NodeJS.ErrnoException
  if (error.code === 'ENOENT') {
    return new Error(
      `Cannot start Codex binary "${bin}": executable not found in PATH. ` +
      'Shell aliases and functions are not visible to this bridge. ' +
      'Unset CODEX_BIN or set it to a real executable, for example CODEX_BIN=codex. ' +
      'If you need a custom Codex wrapper, create a real wrapper script in PATH or pass its absolute path.',
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

export async function runCodex(opts: CodexRunOptions): Promise<CodexRunResult> {
  const bin = opts.codexBin ?? defaultCodexBin()
  const codexGlobalOptions = opts.codexGlobalOptions ?? []
  const codexOptions = opts.codexOptions ?? []
  const imageOptions = (opts.imagePaths ?? []).flatMap(path => ['--image', path])
  const args = opts.codexThreadId
    ? [...codexGlobalOptions, 'exec', 'resume', '--json', '--skip-git-repo-check', ...codexOptions, ...imageOptions, opts.codexThreadId, opts.prompt]
    : [...codexGlobalOptions, 'exec', '--json', '--skip-git-repo-check', ...codexOptions, ...imageOptions, '-C', opts.cwd, opts.prompt]

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    const events: unknown[] = []
    let codexThreadId = opts.codexThreadId ?? ''
    let finalText = ''
    let interrupted = false
    let sigtermTimer: NodeJS.Timeout | undefined
    let sigkillTimer: NodeJS.Timeout | undefined

    function signalChild(signal: NodeJS.Signals): void {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch {
        try { child.kill(signal) } catch {}
      }
    }

    function interrupt(): void {
      interrupted = true
      signalChild('SIGINT')
      sigtermTimer = setTimeout(() => {
        signalChild('SIGTERM')
      }, 2000)
      sigkillTimer = setTimeout(() => {
        if (process.platform !== 'win32') signalChild('SIGKILL')
      }, 7000)
    }

    if (opts.signal?.aborted) interrupt()
    else opts.signal?.addEventListener('abort', interrupt, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      let idx: number
      while ((idx = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, idx).trim()
        stdout = stdout.slice(idx + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line) as JsonEvent
          events.push(ev)
          if (opts.onEvent) void Promise.resolve(opts.onEvent(ev)).catch(() => {})
          if (ev.type === 'thread.started' && ev.thread_id) codexThreadId = ev.thread_id
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
            finalText = ev.item.text
          }
        } catch {
          events.push({ type: 'unparsed', line })
        }
      }
    })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', err => reject(formatSpawnError(bin, err)))
    child.on('close', code => {
      opts.signal?.removeEventListener('abort', interrupt)
      if (sigtermTimer) clearTimeout(sigtermTimer)
      if (sigkillTimer) clearTimeout(sigkillTimer)
      if (interrupted) {
        reject(new CodexRunInterruptedError())
        return
      }
      if (code !== 0) {
        reject(new Error(`codex exited ${code}: ${stderr.trim()}`))
        return
      }
      if (!codexThreadId) {
        reject(new Error(`codex did not emit thread.started; stderr=${stderr.trim()}`))
        return
      }
      resolve({ codexThreadId, finalText, events })
    })
  })
}
