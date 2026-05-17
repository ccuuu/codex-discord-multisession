import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadBindings, upsertBinding } from './bindings.js'
import { describeWeChatMessage, weChatConversationFromMessage } from './wechat-daemon.js'

const stateDir = await mkdtemp(join(tmpdir(), 'codex-wechat-smoke-'))
const bindingsFile = join(stateDir, 'bindings.json')

const textMessage = {
  from_user_id: 'fake-user-id',
  message_type: 1,
  item_list: [
    {
      type: 1,
      text_item: {
        text: '!codex hello',
      },
    },
  ],
}

const mediaMessage = {
  from_user_id: 'fake-user-id',
  message_type: 1,
  item_list: [
    {
      type: 2,
    },
  ],
  attachments: [
    {
      kind: 'image',
      path: '/tmp/fake-wechat-image.jpg',
      fileName: 'fake-wechat-image.jpg',
      size: 123,
    },
  ],
}

const botMessage = {
  from_user_id: 'fake-user-id',
  message_type: 2,
  item_list: [
    {
      type: 1,
      text_item: {
        text: 'bot echo',
      },
    },
  ],
}

const conversation = weChatConversationFromMessage(textMessage)
const ignored = weChatConversationFromMessage(botMessage)
if (!conversation) throw new Error('wechat conversation was not resolved')
if (ignored) throw new Error('bot messages should not resolve to conversations')

await upsertBinding(bindingsFile, conversation.key, {
  codexThreadId: 'fake-codex-session',
  cwd: process.cwd(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

const store = await loadBindings(bindingsFile)

console.log(JSON.stringify({
  ok: Boolean(store[conversation.key]) &&
    conversation.key === 'wechat:user:fake-user-id' &&
    describeWeChatMessage(textMessage) === '!codex hello' &&
    describeWeChatMessage(mediaMessage).includes('/tmp/fake-wechat-image.jpg'),
  conversation,
  mediaText: describeWeChatMessage(mediaMessage),
  bindingsFile,
}, null, 2))
