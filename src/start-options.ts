import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  defaultCodexBin,
  defaultCodexSandbox,
  defaultConfigFile,
  defaultStateDir,
  loadConfig,
  resolveRuntimeConfig,
  saveConfig,
  type BridgeConfig,
} from './config.js'

export type StartCliOptions = BridgeConfig & {
  debug?: boolean
  yes?: boolean
  noPrompt?: boolean
  noSave?: boolean
}

export type ResolvedStartOptions = {
  token: string
  parentChannelId: string
  stateDir: string
  workdir: string
  codexBin: string
  sandbox: string
  model?: string
  proxy?: string
  debug?: boolean
}

type ResolveStartOptionsArgs = {
  configFile?: string
  cliOpts?: StartCliOptions
  includeHttpProxyFallback?: boolean
}

function canPrompt(cliOpts: StartCliOptions): boolean {
  return Boolean(
    input.isTTY &&
    output.isTTY &&
    !cliOpts.yes &&
    !cliOpts.noPrompt &&
    process.env.CODEX_DISCORD_NO_PROMPT !== '1'
  )
}

function withHttpProxyFallback(config: ReturnType<typeof resolveRuntimeConfig>, enabled: boolean): ReturnType<typeof resolveRuntimeConfig> {
  if (!enabled || config.proxy) return config
  return {
    ...config,
    proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined,
  }
}

async function askValue(
  rl: ReturnType<typeof createInterface>,
  label: string,
  fallback: string | undefined,
  options: { required?: boolean; clearable?: boolean } = {},
): Promise<string | undefined> {
  const clearHint = options.clearable ? ", '-' to clear" : ''
  const suffix = fallback ? ` [${fallback}${clearHint}]` : options.clearable ? " ['-' for blank]" : ''
  const answer = (await rl.question(`${label}${suffix}: `)).trim()
  if (options.clearable && answer === '-') return undefined
  const value = answer || fallback
  if (options.required && !value) throw new Error(`${label} is required`)
  return value
}

async function askBoolean(rl: ReturnType<typeof createInterface>, label: string, fallback: boolean): Promise<boolean> {
  const answer = (await rl.question(`${label} [${fallback ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase()
  if (!answer) return fallback
  return answer === 'y' || answer === 'yes'
}

async function askSecret(label: string, fallback: string | undefined): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return fallback ?? ''

  return await new Promise((resolve, reject) => {
    let value = ''
    const wasRaw = input.isRaw

    function cleanup(): void {
      output.write('\n')
      input.off('data', onData)
      input.setRawMode(Boolean(wasRaw))
    }

    function onData(chunk: Buffer): void {
      const text = String(chunk)
      for (const char of text) {
        if (char === '\u0003') {
          cleanup()
          reject(new Error('Interrupted'))
          return
        }
        if (char === '\r' || char === '\n') {
          cleanup()
          resolve(value.trim() || fallback || '')
          return
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        if (char >= ' ') value += char
      }
    }

    output.write(`${label}${fallback ? ' [set; press Enter to keep]' : ''}: `)
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

export async function resolveStartOptions(args: ResolveStartOptionsArgs = {}): Promise<ResolvedStartOptions> {
  const configFile = args.configFile ?? process.env.CODEX_DISCORD_CONFIG ?? defaultConfigFile()
  const cliOpts = args.cliOpts ?? {}
  const current = await loadConfig(configFile)
  const defaults = withHttpProxyFallback(
    resolveRuntimeConfig({ ...current, ...cliOpts }),
    Boolean(args.includeHttpProxyFallback),
  )

  let parentChannelId = defaults.parentChannelId
  let workdir = defaults.workdir
  let proxy = defaults.proxy
  let model = defaults.model
  let sandbox = defaults.sandbox
  let codexBin = defaults.codexBin
  let stateDir = defaults.stateDir
  let token = process.env.DISCORD_BOT_TOKEN ?? ''
  let saveNonSecret = false

  if (canPrompt(cliOpts)) {
    console.log('Codex Discord start')
    console.log('Press Enter to accept a default. Bot token is never saved.')
    console.log('')

    const rl = createInterface({ input, output })
    try {
      parentChannelId = await askValue(rl, 'Discord parent channel ID', parentChannelId || undefined, { required: true }) ?? ''
      workdir = await askValue(rl, 'Codex workdir', workdir || process.cwd(), { required: true }) ?? process.cwd()
      proxy = await askValue(rl, 'Discord proxy', proxy, { clearable: true })
      codexBin = await askValue(rl, 'Codex binary', codexBin || defaultCodexBin(), { required: true }) ?? defaultCodexBin()
      sandbox = await askValue(rl, 'Codex sandbox', sandbox || defaultCodexSandbox(), { required: true }) ?? defaultCodexSandbox()
      model = await askValue(rl, 'Codex model', model, { clearable: true })
      stateDir = await askValue(rl, 'State dir', stateDir || defaultStateDir(), { required: true }) ?? defaultStateDir()
      saveNonSecret = !cliOpts.noSave && await askBoolean(rl, `Save non-secret settings to ${configFile}`, true)
    } finally {
      rl.close()
    }

    token = await askSecret('Discord bot token', token)
  }

  if (!token) throw new Error('DISCORD_BOT_TOKEN is required. Set it or enter it when prompted.')
  if (!parentChannelId) throw new Error('parentChannelId is required. Set CODEX_DISCORD_PARENT_CHANNEL_ID or enter it when prompted.')
  if (!existsSync(workdir)) throw new Error(`workdir does not exist: ${workdir}`)

  if (saveNonSecret) {
    await saveConfig({
      ...current,
      parentChannelId,
      workdir,
      proxy: proxy || undefined,
      model: model || undefined,
      sandbox,
      codexBin,
      stateDir,
      tokenSource: 'env',
    }, configFile)
    console.log(`Saved non-secret settings to ${configFile}`)
  }

  return {
    token,
    parentChannelId,
    stateDir,
    workdir,
    codexBin,
    sandbox,
    model,
    proxy,
    debug: cliOpts.debug || process.env.CODEX_DISCORD_PROXY_DEBUG === '1',
  }
}
