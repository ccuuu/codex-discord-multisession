#!/usr/bin/env node

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { existsSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { defaultCodexBin, defaultCodexSandbox, defaultConfigFile, defaultStateDir, loadConfig, resolveRuntimeConfig, saveConfig } from '../dist/config.js'
import { runCodex } from '../dist/codex-runner.js'
import { upsertBinding } from '../dist/bindings.js'
import { codexSessionHomes, findCodexSessionSummary, listCodexSessions, resolveCodexSessionId } from '../dist/codex-sessions.js'
import { startDiscordDaemon } from '../dist/discord-daemon.js'
import { resolveStartOptions } from '../dist/start-options.js'

function usage() {
  console.log(`Usage: codex-discord <command>

Commands:
  setup     Interactively write ~/.codex/channels/discord/config.json
  start     Start the Discord bridge
  status    Print resolved non-secret configuration
  resume    Resume an existing Codex session in an existing Discord thread
  sessions  List recent local Codex sessions
  help      Show this help

Environment:
  DISCORD_BOT_TOKEN                 Required for start. Never written by setup.
  CODEX_DISCORD_PARENT_CHANNEL_ID   Overrides config parent channel.
  CODEX_DISCORD_WORKDIR             Overrides config workdir.
  CODEX_DISCORD_PROXY               Overrides config proxy.
  CODEX_BIN                         Overrides config Codex executable.
  CODEX_SANDBOX                     Overrides config sandbox. Default: workspace-write.
  CODEX_DISCORD_SANDBOX             Fallback sandbox override if CODEX_SANDBOX is unset.
  CODEX_MODEL                       Overrides config model.
  CODEX_DISCORD_STATE_DIR           Overrides state directory.
  CODEX_HOME                        Primary Codex home for session lookup and resume.
  CODEX_SESSION_HOMES               Extra Codex homes to scan, separated by ${process.platform === 'win32' ? ';' : ':'}.
  CODEX_DISCORD_ASK_MCP=0           Disable Discord ask_user_question MCP tool.
  CODEX_DISCORD_NO_PROMPT=1         Disable interactive start prompts.

Examples:
  codex-discord start
  codex-discord start --yes
  codex-discord resume --thread <discord thread id> --session <codex session id>
  codex-discord resume --thread <discord thread id> --session --last
  codex-discord resume --thread <discord thread id> --session <id> --workdir <path>
  codex-discord sessions --limit 20 --query pipeline
`)
}

function parseArgs(argv) {
  const opts = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config') opts.config = argv[++i]
    else if (arg === '--parent') opts.parentChannelId = argv[++i]
    else if (arg === '--workdir') opts.workdir = argv[++i]
    else if (arg === '--proxy') opts.proxy = argv[++i]
    else if (arg === '--model') opts.model = argv[++i]
    else if (arg === '--codex-bin') opts.codexBin = argv[++i]
    else if (arg === '--sandbox') opts.sandbox = argv[++i]
    else if (arg === '--thread') opts.discordThreadId = argv[++i]
    else if (arg === '--session') opts.codexThreadId = argv[++i]
    else if (arg === '--limit' || arg === '-n') opts.limit = argv[++i]
    else if (arg === '--query' || arg === '-q') opts.query = argv[++i]
    else if (arg === '--cwd') opts.cwd = argv[++i]
    else if (arg === '--json') opts.json = true
    else if (arg === '--debug') opts.debug = true
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

async function setup(configFile, cliOpts = {}) {
  const current = await loadConfig(configFile)
  const rl = createInterface({ input, output })
  try {
    console.log(`Writing non-secret config to ${configFile}`)
    console.log('Bot token is not stored. Set DISCORD_BOT_TOKEN before start.')

    const parentChannelId = cliOpts.parentChannelId ?? await askOrDefault(
      rl,
      `Parent channel ID${current.parentChannelId ? ` [${current.parentChannelId}]` : ''}: `,
      current.parentChannelId,
    )
    const workdir = cliOpts.workdir ?? await askOrDefault(
      rl,
      `Codex workdir [${current.workdir ?? process.cwd()}]: `,
      current.workdir ?? process.cwd(),
    )
    const proxy = cliOpts.proxy ?? await askOrDefault(
      rl,
      `Proxy, blank for none${current.proxy ? ` [${current.proxy}]` : ' (example http://127.0.0.1:7897)'}: `,
      current.proxy,
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

    const next = {
      ...current,
      parentChannelId: String(parentChannelId).trim() || current.parentChannelId,
      workdir: String(workdir).trim() || current.workdir || process.cwd(),
      proxy: String(proxy ?? '').trim() || current.proxy || undefined,
      model: String(model ?? '').trim() || current.model || undefined,
      sandbox: String(sandbox ?? '').trim() || current.sandbox || defaultCodexSandbox(),
      codexBin: String(codexBin).trim() || current.codexBin || defaultCodexBin(),
      stateDir: current.stateDir ?? defaultStateDir(),
      tokenSource: 'env',
    }
    if (!next.parentChannelId) throw new Error('parent channel ID is required')
    await saveConfig(next, configFile)
    console.log('Config saved.')
    console.log('Start with:')
    console.log('  export DISCORD_BOT_TOKEN=<bot token>')
    console.log('  codex-discord start')
  } finally {
    rl.close()
  }
}

async function start(configFile, cliOpts) {
  const config = await resolveStartOptions({ configFile, cliOpts })
  await startDiscordDaemon({
    token: config.token,
    parentChannelId: config.parentChannelId,
    stateDir: config.stateDir,
    workdir: config.workdir,
    codexBin: config.codexBin,
    sandbox: config.sandbox,
    model: config.model,
    proxy: config.proxy,
    debug: config.debug,
    runCodex,
  })
}

async function status(configFile, cliOpts) {
  const config = resolveRuntimeConfig({ ...(await loadConfig(configFile)), ...cliOpts })
  console.log(JSON.stringify({
    configFile,
    parentChannelId: config.parentChannelId || null,
    workdir: config.workdir,
    proxy: config.proxy ?? null,
    codexBin: config.codexBin,
    sandbox: config.sandbox,
    model: config.model ?? null,
    stateDir: config.stateDir,
    sessionHomes: codexSessionHomes(),
    hasTokenInEnv: Boolean(process.env.DISCORD_BOT_TOKEN),
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
  const config = resolveRuntimeConfig({ ...(await loadConfig(configFile)), ...cliOpts })
  const discordThreadId = cliOpts.discordThreadId
  const sessionRef = cliOpts.codexThreadId

  if (!discordThreadId) throw new Error('resume requires --thread <discord thread id>')
  if (!sessionRef) throw new Error('resume requires --session <codex session id|--last>')

  const codexThreadId = await resolveCodexSessionId(sessionRef)
  const { cwd, codexHome, source } = await resolveBindWorkdir(codexThreadId, cliOpts.workdir, config.workdir)
  if (!existsSync(cwd)) throw new Error(`workdir does not exist: ${cwd}`)
  const binding = await upsertBinding(join(config.stateDir, 'bindings.json'), discordThreadId, {
    codexThreadId,
    codexHome,
    cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paused: false,
  })

  console.log(`Resumed Codex session ${binding.codexThreadId} in Discord thread ${binding.discordThreadId}`)
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
  console.log('Use in Discord: !codex-resume <session-id|--last> [--cwd path] <thread-name>')
}

const { opts, rest } = parseArgs(process.argv.slice(2))
const command = rest[0] ?? 'help'
const configFile = opts.config ?? process.env.CODEX_DISCORD_CONFIG ?? defaultConfigFile()

try {
  if (command === 'setup') await setup(configFile, opts)
  else if (command === 'start') await start(configFile, opts)
  else if (command === 'status') await status(configFile, opts)
  else if (command === 'resume') await resume(configFile, opts)
  else if (command === 'sessions') await sessions(opts)
  else usage()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
