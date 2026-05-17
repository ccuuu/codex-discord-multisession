import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defaultStateDir } from './config.js'

type JsonRpcId = string | number | null

type JsonRpcRequest = {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: Record<string, unknown>
}

type AskOption = {
  label: string
  description?: string
}

type AskQuestion = {
  question: string
  header?: string
  options: AskOption[]
  multiSelect?: boolean
}

type AskResponse = {
  ok: boolean
  answers?: Array<{ selection: string | string[]; notes?: string }>
  error?: string
}

const SERVER_INFO = {
  name: 'codex-discord-ask',
  version: '0.1.0',
}

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'Question to ask the human in the current Discord thread.',
    },
    header: {
      type: 'string',
      description: 'Optional short heading displayed before the question.',
    },
    options: {
      type: 'array',
      description: 'Optional choices. Buttons are used for up to five options; select menus are used for longer lists.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['label'],
      },
    },
    multiSelect: {
      type: 'boolean',
      description: 'Allow selecting more than one option.',
    },
    questions: {
      type: 'array',
      description: 'Optional multi-question form. If provided, question/header/options at the top level are ignored.',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          header: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label'],
            },
          },
          multiSelect: { type: 'boolean' },
        },
        required: ['question'],
      },
    },
    timeoutSeconds: {
      type: 'number',
      description: 'How long to wait for a Discord answer. Default: 600 seconds.',
    },
  },
  required: [],
}

function sendRpc(message: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function sendResult(id: JsonRpcId, result: unknown): void {
  sendRpc({ jsonrpc: '2.0', id, result })
}

function sendError(id: JsonRpcId, code: number, message: string): void {
  sendRpc({ jsonrpc: '2.0', id, error: { code, message } })
}

function normalizeString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, limit)
}

function normalizeOptions(value: unknown): AskOption[] {
  if (!Array.isArray(value)) return []
  const options: AskOption[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const label = normalizeString(record.label, 100)
    if (!label) continue
    const description = normalizeString(record.description, 100)
    options.push(description ? { label, description } : { label })
    if (options.length >= 20) break
  }
  return options
}

function normalizeQuestion(input: Record<string, unknown>): AskQuestion | undefined {
  const question = normalizeString(input.question, 1800)
  if (!question) return undefined
  const header = normalizeString(input.header, 80)
  const options = normalizeOptions(input.options)
  return {
    question,
    ...(header ? { header } : {}),
    options,
    ...(input.multiSelect === true ? { multiSelect: true } : {}),
  }
}

function normalizeQuestions(args: Record<string, unknown>): AskQuestion[] {
  const rawQuestions = Array.isArray(args.questions) ? args.questions : undefined
  if (rawQuestions?.length) {
    return rawQuestions
      .map(item => item && typeof item === 'object' ? normalizeQuestion(item as Record<string, unknown>) : undefined)
      .filter((question): question is AskQuestion => Boolean(question))
      .slice(0, 4)
  }
  const single = normalizeQuestion(args)
  return single ? [single] : []
}

function formatAnswers(questions: AskQuestion[], response: AskResponse): string {
  if (!response.ok) return response.error ?? 'Discord ask failed.'
  const lines = ['User answered via Discord:']
  questions.forEach((question, index) => {
    const answer = response.answers?.[index]
    const selection = Array.isArray(answer?.selection)
      ? answer.selection.join(', ')
      : answer?.selection ?? ''
    const notes = answer?.notes ? `\nNotes: ${answer.notes}` : ''
    lines.push(`Q${index + 1}: ${question.question}\nA: ${selection}${notes}`)
  })
  return lines.join('\n\n')
}

async function askDiscord(questions: AskQuestion[], timeoutMs: number): Promise<AskResponse> {
  const discordThreadId = process.env.CODEX_DISCORD_THREAD_ID
  if (!discordThreadId) {
    return {
      ok: false,
      error: 'CODEX_DISCORD_THREAD_ID is not set. This tool only works when Codex is launched by codex-discord.',
    }
  }

  const stateDir = process.env.CODEX_DISCORD_STATE_DIR ?? defaultStateDir()
  const socketPath = process.env.CODEX_DISCORD_ASK_SOCKET ?? join(stateDir, 'ask.sock')
  const requestId = randomUUID().replace(/-/g, '').slice(0, 12)
  const payload = {
    type: 'ask_user_question',
    requestId,
    discordThreadId,
    questions,
    timeoutMs,
  }

  return await new Promise<AskResponse>((resolve) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'Timed out waiting for the Discord ask bridge.' })
    }, timeoutMs + 5000)

    function finish(response: AskResponse): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch {}
      resolve(response)
    }

    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`)
    })
    socket.on('data', chunk => {
      buffer += chunk
      const idx = buffer.indexOf('\n')
      if (idx < 0) return
      const line = buffer.slice(0, idx).trim()
      if (!line) return
      try {
        finish(JSON.parse(line) as AskResponse)
      } catch (err) {
        finish({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
    socket.on('error', err => {
      finish({ ok: false, error: `Cannot reach codex-discord ask bridge at ${socketPath}: ${err.message}` })
    })
    socket.on('close', () => {
      if (!settled) finish({ ok: false, error: 'codex-discord ask bridge closed before answering.' })
    })
  })
}

async function handleToolCall(id: JsonRpcId, params: Record<string, unknown> | undefined): Promise<void> {
  const name = typeof params?.name === 'string' ? params.name : ''
  if (name !== 'ask_user_question' && name !== 'discord_ask') {
    sendResult(id, {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    })
    return
  }

  const args = params?.arguments && typeof params.arguments === 'object'
    ? params.arguments as Record<string, unknown>
    : {}
  const questions = normalizeQuestions(args)
  if (!questions.length) {
    sendResult(id, {
      content: [{ type: 'text', text: 'ask_user_question requires a non-empty question.' }],
      isError: true,
    })
    return
  }

  const timeoutSeconds = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds)
    ? Math.max(10, Math.min(3600, Math.floor(args.timeoutSeconds)))
    : 600
  const response = await askDiscord(questions, timeoutSeconds * 1000)
  sendResult(id, {
    content: [{ type: 'text', text: formatAnswers(questions, response) }],
    isError: !response.ok,
  })
}

async function handleMessage(message: JsonRpcRequest): Promise<void> {
  if (message.id === undefined || message.id === null) return
  const id = message.id
  switch (message.method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
      return
    case 'ping':
      sendResult(id, {})
      return
    case 'tools/list':
      sendResult(id, {
        tools: [
          {
            name: 'ask_user_question',
            description: 'Ask the human a question in the current Discord thread and wait for the answer.',
            inputSchema: TOOL_SCHEMA,
          },
          {
            name: 'discord_ask',
            description: 'Alias for ask_user_question.',
            inputSchema: TOOL_SCHEMA,
          },
        ],
      })
      return
    case 'tools/call':
      await handleToolCall(id, message.params)
      return
    case 'resources/list':
      sendResult(id, { resources: [] })
      return
    case 'prompts/list':
      sendResult(id, { prompts: [] })
      return
    default:
      sendError(id, -32601, `Method not found: ${message.method ?? '(missing)'}`)
  }
}

export function runDiscordAskMcpServer(): void {
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = buffer.slice(0, headerEnd).toString('utf8')
      const lengthMatch = header.match(/content-length:\s*(\d+)/i)
      if (!lengthMatch) {
        buffer = Buffer.alloc(0)
        return
      }
      const length = Number.parseInt(lengthMatch[1] ?? '', 10)
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + length
      if (buffer.length < bodyEnd) return
      const body = buffer.slice(bodyStart, bodyEnd).toString('utf8')
      buffer = buffer.slice(bodyEnd)
      try {
        const message = JSON.parse(body) as JsonRpcRequest
        void handleMessage(message).catch(err => {
          if (message.id !== undefined && message.id !== null) {
            sendError(message.id, -32603, err instanceof Error ? err.message : String(err))
          }
        })
      } catch (err) {
        sendError(null, -32700, err instanceof Error ? err.message : String(err))
      }
    }
  })
}

runDiscordAskMcpServer()
