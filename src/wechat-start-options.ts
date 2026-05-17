import { existsSync } from 'node:fs'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { defaultCodexBin, defaultCodexSandbox } from './config.js'
import {
  defaultWeChatConfigFile,
  defaultWeChatStateDir,
  defaultWxBin,
  loadWeChatConfig,
  resolveWeChatRuntimeConfig,
  saveWeChatConfig,
  type WeChatConfig,
} from './wechat-config.js'

export type WeChatStartCliOptions = WeChatConfig & {
  debug?: boolean
  yes?: boolean
  noPrompt?: boolean
  noSave?: boolean
}

export type ResolvedWeChatStartOptions = {
  stateDir: string
  workdir: string
  wxBin: string
  codexBin: string
  sandbox: string
  model?: string
  debug?: boolean
}

type ResolveWeChatStartOptionsArgs = {
  configFile?: string
  cliOpts?: WeChatStartCliOptions
}

function canPrompt(cliOpts: WeChatStartCliOptions): boolean {
  return Boolean(
    input.isTTY &&
    output.isTTY &&
    !cliOpts.yes &&
    !cliOpts.noPrompt &&
    process.env.CODEX_WECHAT_NO_PROMPT !== '1'
  )
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

export async function resolveWeChatStartOptions(args: ResolveWeChatStartOptionsArgs = {}): Promise<ResolvedWeChatStartOptions> {
  const configFile = args.configFile ?? process.env.CODEX_WECHAT_CONFIG ?? defaultWeChatConfigFile()
  const cliOpts = args.cliOpts ?? {}
  const current = await loadWeChatConfig(configFile)
  const defaults = resolveWeChatRuntimeConfig({ ...current, ...cliOpts })

  let workdir = defaults.workdir
  let wxBin = defaults.wxBin
  let model = defaults.model
  let sandbox = defaults.sandbox
  let codexBin = defaults.codexBin
  let stateDir = defaults.stateDir
  let saveNonSecret = false

  if (canPrompt(cliOpts)) {
    console.log('Codex WeChat local start')
    console.log('This requires a local `wx` CLI session. Run `wx login` first if needed.')
    console.log('')

    const rl = createInterface({ input, output })
    try {
      workdir = await askValue(rl, 'Codex workdir', workdir || process.cwd(), { required: true }) ?? process.cwd()
      wxBin = await askValue(rl, 'wx binary', wxBin || defaultWxBin(), { required: true }) ?? defaultWxBin()
      codexBin = await askValue(rl, 'Codex binary', codexBin || defaultCodexBin(), { required: true }) ?? defaultCodexBin()
      sandbox = await askValue(rl, 'Codex sandbox', sandbox || defaultCodexSandbox(), { required: true }) ?? defaultCodexSandbox()
      model = await askValue(rl, 'Codex model', model, { clearable: true })
      stateDir = await askValue(rl, 'State dir', stateDir || defaultWeChatStateDir(), { required: true }) ?? defaultWeChatStateDir()
      saveNonSecret = !cliOpts.noSave && await askBoolean(rl, `Save settings to ${configFile}`, true)
    } finally {
      rl.close()
    }
  }

  if (!wxBin) throw new Error('CODEX_WECHAT_WX_BIN is required. Set it or enter it when prompted.')
  if (!existsSync(workdir)) throw new Error(`workdir does not exist: ${workdir}`)

  if (saveNonSecret) {
    await saveWeChatConfig({
      ...current,
      workdir,
      wxBin,
      model: model || undefined,
      sandbox,
      codexBin,
      stateDir,
    }, configFile)
    console.log(`Saved settings to ${configFile}`)
  }

  return {
    stateDir,
    workdir,
    wxBin,
    codexBin,
    sandbox,
    model,
    debug: cliOpts.debug || process.env.CODEX_WECHAT_DEBUG === '1',
  }
}
