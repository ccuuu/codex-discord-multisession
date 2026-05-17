import { spawn } from 'node:child_process'

export type CommandResult = {
  code: number | null
  stdout: string
  stderr: string
}

export type WxStatus = {
  available: boolean
  loggedIn: boolean
  ok: boolean
  output: string
  error?: string
}

export type EnsureWxLoginOptions = {
  wxBin: string
  force?: boolean
  fresh?: boolean
  interactive?: boolean
  assumeYes?: boolean
  prompt?: (question: string, fallback: boolean) => Promise<boolean>
}

export function formatCommandSpawnError(bin: string, purpose: string, err: unknown): Error {
  const error = err as NodeJS.ErrnoException
  if (error.code === 'ENOENT') {
    return new Error(
      `Cannot start ${purpose} binary "${bin}": executable not found in PATH. ` +
      `Set the matching binary option to an absolute path or put "${bin}" in PATH.`,
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

export async function captureCommand(bin: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      resolve({ code, stdout, stderr })
    })
  })
}

async function runInherited(bin: string, args: string[]): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', code => {
      resolve(code)
    })
  })
}

export async function getWxStatus(wxBin: string): Promise<WxStatus> {
  let result: CommandResult
  try {
    result = await captureCommand(wxBin, ['status'])
  } catch (err) {
    return {
      available: false,
      loggedIn: false,
      ok: false,
      output: '',
      error: formatCommandSpawnError(wxBin, 'wx', err).message,
    }
  }

  const output = `${result.stdout}${result.stderr}`.trim()
  const noSavedSession = /No saved session\.?|savedSession:\s*none|loginMode:\s*ephemeral/i.test(output)
  if (noSavedSession) {
    return {
      available: true,
      loggedIn: false,
      ok: true,
      output,
    }
  }

  if (result.code !== 0) {
    return {
      available: true,
      loggedIn: false,
      ok: false,
      output,
      error: `wx status exited ${result.code}: ${output}`,
    }
  }

  return {
    available: true,
    loggedIn: true,
    ok: true,
    output,
  }
}

export async function runWxLogin(wxBin: string, fresh = false): Promise<void> {
  let code: number | null
  try {
    code = await runInherited(wxBin, fresh ? ['login', '--fresh'] : ['login'])
  } catch (err) {
    throw formatCommandSpawnError(wxBin, 'wx', err)
  }
  if (code !== 0) throw new Error(`wx login exited ${code}`)
}

export async function ensureWxLoggedIn(options: EnsureWxLoginOptions): Promise<WxStatus> {
  if (options.force) {
    await runWxLogin(options.wxBin, Boolean(options.fresh))
    return await getWxStatus(options.wxBin)
  }

  const status = await getWxStatus(options.wxBin)
  if (!status.available) throw new Error(status.error ?? `wx binary is not available: ${options.wxBin}`)
  if (!status.ok) throw new Error(status.error ?? 'wx status failed')
  if (status.loggedIn) return status

  if (!options.interactive) {
    throw new Error(
      'No saved wx session. Run `codex-wechat login` first, or run `codex-wechat start --login` from a TTY.',
    )
  }

  const shouldLogin = options.assumeYes || await (options.prompt?.('No saved wx session. Run `wx login` now?', true) ?? Promise.resolve(true))
  if (!shouldLogin) {
    throw new Error('No saved wx session. Run `codex-wechat login` before starting the bridge.')
  }

  await runWxLogin(options.wxBin, Boolean(options.fresh))
  return await getWxStatus(options.wxBin)
}
