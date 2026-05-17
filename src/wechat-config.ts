import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { defaultCodexBin, defaultCodexSandbox } from './config.js'

export type WeChatConfig = {
  workdir?: string
  wxBin?: string
  codexBin?: string
  sandbox?: string
  model?: string
  stateDir?: string
}

export function defaultWeChatStateDir(): string {
  return join(homedir(), '.codex', 'channels', 'wechat')
}

export function defaultWeChatConfigFile(): string {
  return join(defaultWeChatStateDir(), 'config.json')
}

export function defaultWxBin(): string {
  return 'wx'
}

export async function loadWeChatConfig(file = process.env.CODEX_WECHAT_CONFIG ?? defaultWeChatConfigFile()): Promise<WeChatConfig> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as WeChatConfig
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

export async function saveWeChatConfig(config: WeChatConfig, file = process.env.CODEX_WECHAT_CONFIG ?? defaultWeChatConfigFile()): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
}

export function resolveWeChatRuntimeConfig(config: WeChatConfig): Required<Pick<WeChatConfig, 'workdir' | 'wxBin' | 'codexBin' | 'sandbox' | 'stateDir'>> & WeChatConfig {
  const stateDir = process.env.CODEX_WECHAT_STATE_DIR ?? config.stateDir ?? defaultWeChatStateDir()
  return {
    ...config,
    workdir: process.env.CODEX_WECHAT_WORKDIR ?? config.workdir ?? process.cwd(),
    wxBin: process.env.CODEX_WECHAT_WX_BIN ?? config.wxBin ?? defaultWxBin(),
    codexBin: process.env.CODEX_BIN ?? config.codexBin ?? defaultCodexBin(),
    sandbox: process.env.CODEX_SANDBOX ?? process.env.CODEX_WECHAT_SANDBOX ?? config.sandbox ?? defaultCodexSandbox(),
    model: process.env.CODEX_MODEL ?? config.model,
    stateDir,
  }
}
