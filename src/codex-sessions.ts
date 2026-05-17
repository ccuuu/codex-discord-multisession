import { readdir, readFile, stat } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

type SessionCandidate = {
  home: string
  id: string
  path: string
  mtimeMs: number
}

export type CodexSessionSummary = {
  id: string
  home: string
  path: string
  cwd?: string
  startedAt?: string
  updatedAt: string
  preview?: string
  messageCount: number
}

type ParsedCodexSessionSummary = CodexSessionSummary & {
  updatedAtMs: number
  searchText: string
}

export type ListCodexSessionsOptions = {
  home?: string
  homes?: string[]
  limit?: number
  cwd?: string
  query?: string
}

function expandHomePath(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

function normalizeHome(value: string): string {
  return resolve(expandHomePath(value))
}

function envSessionHomes(): string[] {
  return (process.env.CODEX_SESSION_HOMES ?? '')
    .split(delimiter)
    .map(value => value.trim())
    .filter(Boolean)
}

export function codexHome(): string {
  return normalizeHome(process.env.CODEX_HOME ?? join(homedir(), '.codex'))
}

export function codexSessionHomes(options: Pick<ListCodexSessionsOptions, 'home' | 'homes'> = {}): string[] {
  const candidates = options.home
    ? [options.home, ...(options.homes ?? [])]
    : [
      process.env.CODEX_HOME,
      ...envSessionHomes(),
      ...(options.homes ?? []),
      join(homedir(), '.codex'),
    ]

  const homes: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate) continue
    const home = normalizeHome(candidate)
    if (seen.has(home)) continue
    seen.add(home)
    homes.push(home)
  }
  return homes
}

async function collectSessionCandidates(home: string, dir: string, out: SessionCandidate[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }

  await Promise.all(entries.map(async entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectSessionCandidates(home, path, out)
      return
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return
    const match = entry.name.match(UUID_RE)
    if (!match) return
    const info = await stat(path)
    out.push({ home, id: match[1], path, mtimeMs: info.mtimeMs })
  }))
}

async function collectSessionsFromHomes(homes: string[]): Promise<SessionCandidate[]> {
  const candidates: SessionCandidate[] = []
  await Promise.all(homes.map(home => collectSessionCandidates(home, join(home, 'sessions'), candidates)))
  return candidates
}

function cleanText(value: string, limit = 180): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= limit) return oneLine
  return `${oneLine.slice(0, Math.max(0, limit - 3))}...`
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(item => {
      if (!item || typeof item !== 'object') return ''
      const record = item as Record<string, unknown>
      return typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

async function summarizeSession(candidate: SessionCandidate): Promise<ParsedCodexSessionSummary> {
  const raw = await readFile(candidate.path, 'utf8')
  let id = candidate.id
  let cwd: string | undefined
  let startedAt: string | undefined
  let firstUserMessage = ''
  const allUserMessages: string[] = []
  const fallbackUserMessages: string[] = []

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const payload = entry.payload && typeof entry.payload === 'object'
      ? entry.payload as Record<string, unknown>
      : {}

    if (entry.type === 'session_meta') {
      if (typeof payload.id === 'string') id = payload.id
      if (typeof payload.cwd === 'string') cwd = payload.cwd
      if (typeof payload.timestamp === 'string') startedAt = payload.timestamp
      continue
    }

    if (entry.type === 'turn_context') {
      if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd
      continue
    }

    if (entry.type === 'event_msg' && payload.type === 'user_message') {
      const text = typeof payload.message === 'string'
        ? payload.message
        : Array.isArray(payload.text_elements)
          ? payload.text_elements.map(String).join('\n')
          : ''
      const cleaned = cleanText(text)
      if (cleaned) {
        if (!firstUserMessage) firstUserMessage = cleaned
        allUserMessages.push(cleaned)
      }
      continue
    }

    if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const cleaned = cleanText(contentText(payload.content))
      if (cleaned) fallbackUserMessages.push(cleaned)
    }
  }

  const fallback = fallbackUserMessages.find(text => !text.startsWith('<environment_context>'))
  const preview = firstUserMessage || fallback
  const updatedAt = new Date(candidate.mtimeMs).toISOString()
  const searchText = [id, cwd, startedAt, updatedAt, preview, ...allUserMessages, ...fallbackUserMessages]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()

  return {
    id,
    home: candidate.home,
    path: candidate.path,
    cwd,
    startedAt,
    updatedAt,
    updatedAtMs: candidate.mtimeMs,
    preview,
    messageCount: allUserMessages.length || fallbackUserMessages.length,
    searchText,
  }
}

function publicSessionSummary(summary: ParsedCodexSessionSummary): CodexSessionSummary {
  const { updatedAtMs: _updatedAtMs, searchText: _searchText, ...publicSummary } = summary
  return publicSummary
}

export async function listCodexSessions(options: ListCodexSessionsOptions = {}): Promise<CodexSessionSummary[]> {
  const candidates = await collectSessionsFromHomes(codexSessionHomes(options))

  let sessions = await Promise.all(candidates.map(summarizeSession))
  const cwd = options.cwd ? resolve(options.cwd) : undefined
  if (cwd) sessions = sessions.filter(session => session.cwd ? resolve(session.cwd) === cwd : false)

  const query = options.query?.trim().toLowerCase()
  if (query) sessions = sessions.filter(session => session.searchText.includes(query))

  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.path.localeCompare(a.path))
  const limit = options.limit ?? 20
  const limited = limit > 0 ? sessions.slice(0, limit) : sessions
  return limited.map(publicSessionSummary)
}

export async function findCodexSessionSummary(id: string, home?: string): Promise<CodexSessionSummary | undefined> {
  const candidates = await collectSessionsFromHomes(codexSessionHomes(home ? { home } : {}))

  const exactCandidates = candidates.filter(candidate => candidate.id === id)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))
  for (const candidate of exactCandidates) {
    const summary = await summarizeSession(candidate)
    return publicSessionSummary(summary)
  }

  const exactPaths = new Set(exactCandidates.map(candidate => candidate.path))
  const remaining = candidates.filter(candidate => !exactPaths.has(candidate.path))
  for (const candidate of remaining) {
    const summary = await summarizeSession(candidate)
    if (summary.id === id) return publicSessionSummary(summary)
  }

  return undefined
}

export async function latestCodexSessionId(home?: string): Promise<string | undefined> {
  const candidates = await collectSessionsFromHomes(codexSessionHomes(home ? { home } : {}))
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))
  return candidates[0]?.id
}

export async function resolveCodexSessionId(input: string): Promise<string> {
  const trimmed = input.trim()
  if (trimmed !== '--last') return trimmed

  const latest = await latestCodexSessionId()
  if (!latest) {
    throw new Error(`No Codex session files found under ${codexSessionHomes().map(home => join(home, 'sessions')).join(', ')}`)
  }
  return latest
}
