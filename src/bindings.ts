import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type Binding = {
  discordThreadId: string
  codexThreadId: string
  codexHome?: string
  cwd: string
  createdAt: string
  updatedAt: string
  paused?: boolean
}

export type BindingStore = Record<string, Binding>

export async function loadBindings(file: string): Promise<BindingStore> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as BindingStore
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

export async function saveBindings(file: string, store: BindingStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
}

export async function upsertBinding(file: string, discordThreadId: string, patch: Omit<Binding, 'discordThreadId'>): Promise<Binding> {
  const store = await loadBindings(file)
  const existing = store[discordThreadId]
  const now = new Date().toISOString()
  const binding: Binding = {
    discordThreadId,
    codexThreadId: patch.codexThreadId,
    codexHome: patch.codexHome ?? existing?.codexHome,
    cwd: patch.cwd,
    createdAt: existing?.createdAt ?? patch.createdAt ?? now,
    updatedAt: now,
    paused: patch.paused ?? existing?.paused,
  }
  store[discordThreadId] = binding
  await saveBindings(file, store)
  return binding
}
