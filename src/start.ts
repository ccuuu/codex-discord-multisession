import { runCodex } from './codex-runner.js'
import { startDiscordDaemon } from './discord-daemon.js'
import { resolveStartOptions } from './start-options.js'

const config = await resolveStartOptions({ includeHttpProxyFallback: true })

await startDiscordDaemon({ ...config, runCodex })
