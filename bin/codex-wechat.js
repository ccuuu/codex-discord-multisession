#!/usr/bin/env node

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { existsSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { defaultCodexBin, defaultCodexSandbox } from '../dist/config.js'
import {
  defaultWeChatConfigFile,
  defaultWeChatStateDir,
  defaultWxBin,
  loadWeChatConfig,
  resolveWeChatRuntimeConfig,
  saveWeChatConfig,
} from '../dist/wechat-config.js'
import { runCodex } from '../dist/codex-runner.js'
import { upsertBinding } from '../dist/bindings.js'
import { codexSessionHomes, findCodexSessionSummary, listCodexSessions, resolveCodexSessionId } from '../dist/codex-sessions.js'
import { startWeChatDaemon } from '../dist/wechat-daemon.js'
import { resolveWeChatStartOptions } from '../dist/wechat-start-options.js'
import { captureCommand, getWxStatus, runWxLogin } from '../dist/wechat-preflight.js'

function usage() {
  console.log(`Usage: codex-wechat <command>

Commands:
  setup     Interactively write ~/.codex/channels/wechat/config.json
  login     Run one wx QR login check using the configured wx binary
  doctor    Check wx, Codex binary, and workdir
  start     Start the local WeChat bridge through the wx CLI
  status    Print resolved configuration
  resume    Resume an existing Codex session in a WeChat user conversation
  sessions  List recent local Codex sessions
  help      Show this help

Environment:
  CODEX_WECHAT_WX_BIN       Overrides config wx executable. Default: wx.
  CODEX_WECHAT_WORKDIR      Overrides config workdir.
  CODEX_BIN                 Overrides config Codex executable.
  CODEX_SANDBOX             Overrides config sandbox. Default: workspace-write.
  CODEX_WECHAT_SANDBOX      Fallback sandbox override if CODEX_SANDBOX is unset.
  CODEX_MODEL               Overrides config model.
  CODEX_WECHAT_STATE_DIR    Overrides state directory.
  CODEX_HOME                Primary Codex home for session lookup and resume.
  CODEX_SESSION_HOMES       Extra Codex homes to scan, separated by ${process.platform === 'win32' ? ';' : ':'}.
  CODEX_WECHAT_NO_PROMPT=1  Disable interactive start prompts.

Examples:
  codex-wechat doctor
  codex-wechat login
  codex-wechat start
  codex-wechat start --yes
  codex-wechat sessions --limit 20 --query pipeline
  codex-wechat resume --user <wechat user id> --session <codex session id>
  codex-wechat resume --conversation wechat:user:<wechat user id> --session --last
`)
}

function parseArgs(argv) {
  const opts = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config') opts.config = argv[++i]
    else if (arg === '--workdir') opts.workdir = argv[++i]
    else if (arg === '--wx-bin') opts.wxBin = argv[++i]
    else if (arg === '--model') opts.model = argv[++i]
    else if (arg === '--codex-bin') opts.codexBin = argv[++i]
    else if (arg === '--sandbox') opts.sandbox = argv[++i]
    else if (arg === '--state-dir') opts.stateDir = argv[++i]
    else if (arg === '--conversation') opts.conversationKey = argv[++i]
    else if (arg === '--user') opts.wechatUserId = argv[++i]
    else if (arg === '--session') opts.codexThreadId = argv[++i]
    else if (arg === '--limit' || arg === '-n') opts.limit = argv[++i]
    else if (arg === '--query' || arg === '-q') opts.query = argv[++i]
    else if (arg === '--cwd') opts.cwd = argv[++i]
    else if (arg === '--json') opts.json = true
    else if (arg === '--debug') opts.debug = true
    else if (arg === '--fresh') opts.fresh = true
    else if (arg === '--yes' || arg === '-y') opts.yes = true
    else if (arg === '--no-prompt') opts.noPrompt = true
    else if (arg === '--no-save') opts.noSave = true
    else rest.push(arg)
  }
  return { opts, rest }
}

async function askOrDefault(rl, prompt, fallback) {
  if (!process.stdin.isTTY) return fallback ?? ''
  const answer = await rl.question(prompt)
  return answer.trim() || fallback || ''
}

async function askYesNo(question, fallback = true) {
  if (!process.stdin.isTTY) return fallback
  const rl = createInterface({ input, output })
  try {
    const answer = (await rl.question(`${question} [${fallback ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase()
    if (!answer) return fallback
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

async function setup(configFile, cliOpts = {}) {
  const current = await loadWeChatConfig(configFile)
  const rl = createInterface({ input, output })
  try {
    console.log(`Writing config to ${configFile}`)
    console.log('Run `wx login` separately; WeChat credentials stay in the wx CLI keychain.')

    const workdir = cliOpts.workdir ?? await askOrDefault(
      rl,
      `Codex workdir [${current.workdir ?? process.cwd()}]: `,
      current.workdir ?? process.cwd(),
    )
    const wxBin = cliOpts.wxBin ?? await askOrDefault(
      rl,
      `wx binary [${current.wxBin ?? defaultWxBin()}]: `,
      current.wxBin ?? defaultWxBin(),
    )
    const model = cliOpts.model ?? await askOrDefault(
      rl,
      `Codex model, blank for default${current.model ? ` [${current.model}]` : ''}: `,
      current.model,
    )
    const sandbox = cliOpts.sandbox ?? await askOrDefault(
      rl,
      `Codex sandbox [${current.sandbox ?? defaultCodexSandbox()}]: `,
      current.sandbox ?? defaultCodexSandbox(),
    )
    const codexBin = cliOpts.codexBin ?? await askOrDefault(
      rl,
      `Codex binary [${current.codexBin ?? defaultCodexBin()}]: `,
      current.codexBin ?? defaultCodexBin(),
    )
    const stateDir = cliOpts.stateDir ?? await askOrDefault(
      rl,
      `State dir [${current.stateDir ?? defaultWeChatStateDir()}]: `,
      current.stateDir ?? defaultWeChatStateDir(),
    )

    const next = {
      ...current,
      workdir: String(workdir).trim() || current.workdir || process.cwd(),
      wxBin: String(wxBin).trim() || current.wxBin || defaultWxBin(),
      model: String(model ?? '').trim() || current.model || undefined,
      sandbox: String(sandbox ?? '').trim() || current.sandbox || defaultCodexSandbox(),
      codexBin: String(codexBin).trim() || current.codexBin || defaultCodexBin(),
      stateDir: String(stateDir).trim() || current.stateDir || defaultWeChatStateDir(),
    }
    await saveWeChatConfig(next, configFile)
    console.log('Config saved.')
    console.log('Start with:')
    console.log('  wx login')
    console.log('  codex-wechat start')
  } finally {
    rl.close()
  }
}

async function start(configFile, cliOpts) {
  const config = await resolveWeChatStartOptions({ configFile, cliOpts })
  await startWeChatDaemon({
    stateDir: config.stateDir,
    workdir: config.workdir,
    wxBin: config.wxBin,
    codexBin: config.codexBin,
    sandbox: config.sandbox,
    model: config.model,
    debug: config.debug,
    runCodex,
  })
}

async function login(configFile, cliOpts) {
  const config = resolveWeChatRuntimeConfig({ ...(await loadWeChatConfig(configFile)), ...cliOpts })
  await runWxLogin(config.wxBin, Boolean(cliOpts.fresh))
  console.log('wx QR login completed. Session credentials are not saved; `codex-wechat start` will scan again for its live bridge session.')
}

async function doctor(configFile, cliOpts) {
  const config = resolveWeChatRuntimeConfig({ ...(await loadWeChatConfig(configFile)), ...cliOpts })
  let ok = true

  function check(pass, label, detail) {
    if (!pass) ok = false
    console.log(`${pass ? 'OK' : 'FAIL'} ${label}: ${detail}`)
  }

  console.log('Codex WeChat doctor')
  console.log(`Config: ${configFile}`)

  const wxStatus = await getWxStatus(config.wxBin)
  check(wxStatus.available, 'wx binary', config.wxBin)
  if (wxStatus.available) {
    check(wxStatus.ok, 'wx status', wxStatus.error ?? 'ok')
    check(true, 'wx login mode', 'ephemeral; `codex-wechat start` scans a QR code for each bridge process')
  }

  check(existsSync(config.workdir), 'workdir', config.workdir)

  try {
    const codexVersion = await captureCommand(config.codexBin, ['--version'])
    const output = `${codexVersion.stdout}${codexVersion.stderr}`.trim()
    check(codexVersion.code === 0, 'codex binary', output || config.codexBin)
  } catch (err) {
    ok = false
    console.log(`FAIL codex binary: ${err instanceof Error ? err.message : String(err)}`)
  }

  check(Boolean(config.sandbox), 'sandbox', config.sandbox)
  console.log(`State dir: ${config.stateDir}`)
  console.log(`Session homes: ${codexSessionHomes().join(', ')}`)
  if (!ok) process.exitCode = 1
}

async function status(configFile, cliOpts) {
  const config = resolveWeChatRuntimeConfig({ ...(await loadWeChatConfig(configFile)), ...cliOpts })
  console.log(JSON.stringify({
    configFile,
    workdir: config.workdir,
    wxBin: config.wxBin,
    codexBin: config.codexBin,
    sandbox: config.sandbox,
    model: config.model ?? null,
    stateDir: config.stateDir,
    sessionHomes: codexSessionHomes(),
  }, null, 2))
}

function normalizePath(value, base = process.cwd()) {
  if (value === '~') return homedir()
  if (value?.startsWith('~/')) return join(homedir(), value.slice(2))
  return resolvePath(base, value)
}

async function resolveBindWorkdir(codexThreadId, cliWorkdir, configWorkdir) {
  const session = await findCodexSessionSummary(codexThreadId)
  if (cliWorkdir) {
    return {
      cwd: normalizePath(cliWorkdir, configWorkdir),
      codexHome: session?.home,
      source: 'explicit',
    }
  }

  if (!session?.cwd) {
    throw new Error(
      `Cannot infer workdir for Codex session ${codexThreadId}. ` +
      'Pass --workdir <path>, or set CODEX_HOME/CODEX_SESSION_HOMES to the Codex home that contains this session.',
    )
  }

  return {
    cwd: normalizePath(session.cwd),
    codexHome: session.home,
    source: 'Codex session',
  }
}

async function resume(configFile, cliOpts) {
  const config = resolveWeChatRuntimeConfig({ ...(await loadWeChatConfig(configFile)), ...cliOpts })
  const conversationKey = cliOpts.conversationKey ?? (cliOpts.wechatUserId ? `wechat:user:${cliOpts.wechatUserId}` : undefined)
  const sessionRef = cliOpts.codexThreadId

  if (!conversationKey) throw new Error('resume requires --user <wechat user id> or --conversation wechat:user:<wechat user id>')
  if (!sessionRef) throw new Error('resume requires --session <codex session id|--last>')

  const codexThreadId = await resolveCodexSessionId(sessionRef)
  const { cwd, codexHome, source } = await resolveBindWorkdir(codexThreadId, cliOpts.workdir, config.workdir)
  if (!existsSync(cwd)) throw new Error(`workdir does not exist: ${cwd}`)
  const binding = await upsertBinding(join(config.stateDir, 'bindings.json'), conversationKey, {
    codexThreadId,
    codexHome,
    cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paused: false,
  })

  console.log(`Resumed Codex session ${binding.codexThreadId} in WeChat conversation ${conversationKey}`)
  console.log(`Workdir: ${binding.cwd} (${source})`)
}

function parseLimit(value, fallback = 20) {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('--limit must be a non-negative integer')
  return parsed
}

function shortPath(value) {
  if (!value) return '(unknown cwd)'
  const home = homedir()
  return value === home ? '~' : value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value
}

function formatDate(value) {
  if (!value) return 'unknown time'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function sessions(cliOpts) {
  const limit = parseLimit(cliOpts.limit)
  const rows = await listCodexSessions({
    limit,
    cwd: cliOpts.cwd,
    query: cliOpts.query,
  })

  if (cliOpts.json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }

  console.log(`Codex sessions: ${codexSessionHomes().map(home => join(home, 'sessions')).join(', ')}`)
  if (cliOpts.cwd) console.log(`CWD filter: ${cliOpts.cwd}`)
  if (cliOpts.query) console.log(`Query: ${cliOpts.query}`)
  if (!rows.length) {
    console.log('No matching sessions found.')
    return
  }

  rows.forEach((row, index) => {
    console.log(`${index + 1}. ${formatDate(row.updatedAt)}  ${row.id}`)
    console.log(`   cwd: ${shortPath(row.cwd)}`)
    console.log(`   home: ${shortPath(row.home)}`)
    if (row.preview) console.log(`   text: ${row.preview}`)
  })
  console.log('')
  console.log('Use in WeChat: !resume <session-id|--last> [workdir]')
}

const { opts, rest } = parseArgs(process.argv.slice(2))
const command = rest[0] ?? 'help'
const configFile = opts.config ?? process.env.CODEX_WECHAT_CONFIG ?? defaultWeChatConfigFile()

try {
  if (command === 'setup') await setup(configFile, opts)
  else if (command === 'login') await login(configFile, opts)
  else if (command === 'doctor') await doctor(configFile, opts)
  else if (command === 'start') await start(configFile, opts)
  else if (command === 'status') await status(configFile, opts)
  else if (command === 'resume') await resume(configFile, opts)
  else if (command === 'sessions') await sessions(opts)
  else usage()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
