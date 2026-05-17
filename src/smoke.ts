import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadBindings, upsertBinding } from './bindings.js'
import { runCodex } from './codex-runner.js'

const stateDir = process.env.CODEX_DISCORD_STATE_DIR ?? join(tmpdir(), 'codex-discord-multisession-smoke')
const bindingsFile = join(stateDir, 'bindings.json')
const cwd = await mkdtemp(join(tmpdir(), 'codex-discord-cwd-'))
const discordThreadId = process.env.CODEX_DISCORD_FAKE_THREAD_ID ?? 'fake-discord-thread-1'

const first = await runCodex({
  cwd,
  prompt: 'Reply with exactly: codex-discord-bridge-ok',
})
await upsertBinding(bindingsFile, discordThreadId, {
  codexThreadId: first.codexThreadId,
  cwd,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

const store = await loadBindings(bindingsFile)
const bound = store[discordThreadId]
if (!bound) throw new Error('binding was not persisted')

const second = await runCodex({
  cwd,
  codexThreadId: bound.codexThreadId,
  prompt: 'What exact phrase did I ask you to reply with in the previous turn? Reply only with that phrase.',
})

console.log(JSON.stringify({
  ok: second.finalText.trim() === 'codex-discord-bridge-ok',
  discordThreadId,
  codexThreadId: bound.codexThreadId,
  first: first.finalText.trim(),
  second: second.finalText.trim(),
  bindingsFile,
}, null, 2))
