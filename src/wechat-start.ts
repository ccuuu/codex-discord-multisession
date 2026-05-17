import { runCodex } from './codex-runner.js'
import { startWeChatDaemon } from './wechat-daemon.js'
import { resolveWeChatStartOptions } from './wechat-start-options.js'

const config = await resolveWeChatStartOptions()

await startWeChatDaemon({ ...config, runCodex })
