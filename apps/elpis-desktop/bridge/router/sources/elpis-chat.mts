// Ported from dsh-superagent (MIT), src/sources/feishu.ts (shape)
// Intake follows src/sources/feishu-loops.ts and src/sources/feishu-trigger.ts.
import { z } from 'zod'
import { key, type Trigger } from '../core/index.mts'
import type { SourceContext, SourceHost } from './host.mts'
import type { SourceKind } from './kind.mts'
import { KV } from './kv.mts'
import { pause } from './poll.mts'
import { elpisChatChannel } from './elpis-chat-channel.mts'
import { chatContext } from './elpis-chat-read.mts'
import { AllowedSchema } from '../policy.mts'

export const SOURCE = 'elpis-chat'
const ConfigSchema = z.object({ threadId: z.string().trim().default(''), pollSeconds: z.number().int().min(1).max(3600).default(2) }).strict()
export type ElpisChatConfig = z.infer<typeof ConfigSchema>
export interface ElpisChatMessage {
  /** Stable message identity, including its native turn when item IDs are turn-local. */
  id: string; threadId: string; role: 'user' | 'assistant'; actorId: string; at: string; text: string
  replyTo?: string
  images?: { id: string; url: string }[]
}
export interface ElpisChatTransport {
  /** Oldest first, after the durable message ID. A missing/deleted anchor must replay history, never skip ahead. */
  read(threadId: string, after: string | undefined, signal?: AbortSignal): Promise<ElpisChatMessage[]>
  /** Durable insert-if-absent by (threadId, reply.id), including after a lost acknowledgement or process restart. */
  appendAssistant(threadId: string, reply: { id: string; text: string }): Promise<'sent' | 'gone'>
}
export const elpisChatTriggerId = (threadId: string, messageId: string): string => key(SOURCE, threadId, messageId)

export function createElpisChatKind(transport: ElpisChatTransport): SourceKind<ElpisChatConfig> {
  return {
    kind: SOURCE, title: { zh: 'Elpis 聊天', en: 'Elpis chat' },
    description: { zh: 'Elpis 智能体的聊天。', en: 'The Elpis’s conversation.' },
    schema: ConfigSchema,
    fields: [{ key: 'threadId', type: 'text', label: { zh: '聊天 ID', en: 'Chat thread ID' } },
      { key: 'pollSeconds', type: 'number', advanced: true, min: 1, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } }],
    health: [SOURCE],
    scope: ({ meta }, config) => config.threadId && meta.threadId === config.threadId
      ? { listened: true, observed: false } : { listened: false, reason: 'chat_not_selected' },
    channel: elpisChatChannel(transport),
    threadContext: chatContext(transport),
    repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? elpisChatTriggerId(String(trigger.meta.threadId), trigger.meta.replyTo) : undefined,
    policy: { schema: z.object({ allowed: z.array(AllowedSchema).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '发送者', en: 'Allowed people' }, columns: [{ key: 'id', type: 'text', label: { zh: '发送者', en: 'Person' } }] }],
      explicit: { zh: '所选聊天中的直接请求。', en: 'A direct request in the selected Elpis chat.' } },
  }
}

function trigger(message: ElpisChatMessage): Trigger {
  return { id: elpisChatTriggerId(message.threadId, message.id), source: SOURCE,
    threads: [{ source: SOURCE, id: message.threadId }], actor: { source: SOURCE, id: message.actorId }, human: true, addressed: 'direct',
    at: message.at, text: message.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${message.threadId}`, address: { threadId: message.threadId } },
    meta: { threadId: message.threadId, messageId: message.id, ...(message.replyTo ? { replyTo: message.replyTo } : {}) } }
}

const polls = new WeakMap<SourceContext, Promise<void>>()
/** At-least-once intake; advance only after receive succeeds. Trigger storage owns dedupe, independently of the cursor. */
export async function pollElpisChat(ctx: SourceContext, transport: ElpisChatTransport, signal?: AbortSignal): Promise<void> {
  const previous = polls.get(ctx) ?? Promise.resolve()
  const running = previous.catch(() => {}).then(async () => {
    const config = ctx.config<ElpisChatConfig>(SOURCE)
    if (!config?.threadId || signal?.aborted) return
    const selected = () => !signal?.aborted && ctx.config<ElpisChatConfig>(SOURCE)?.threadId === config.threadId
    const cursor = KV.elpisChat.cursor(config.threadId)
    const messages = await transport.read(config.threadId, ctx.state.get(cursor), signal)
    for (const message of messages) {
      if (!selected()) return
      if (message.threadId !== config.threadId) continue
      if (message.role === 'user') {
        const event = trigger(message)
        if (!ctx.triggers.get(event.id)) await ctx.receive(event)
      }
      // A crash between receive and this write replays safely through the immutable Trigger ID.
      ctx.state.set(cursor, message.id)
    }
    if (selected()) ctx.report(SOURCE, { state: 'ready', detail: `Listening to ${config.threadId}` })
  })
  polls.set(ctx, running)
  try { await running } finally { if (polls.get(ctx) === running) polls.delete(ctx) }
}

export function startElpisChat(host: SourceHost, transport: ElpisChatTransport): () => Promise<void> {
  const kind = createElpisChatKind(transport)
  const release = host.sources.register(kind)
  const ctx = host.context(kind), controller = new AbortController()
  const running = watchElpisChat(ctx, transport, controller.signal)
  return async () => { controller.abort(); try { await running } finally { release() } }
}
export async function watchElpisChat(ctx: SourceContext, transport: ElpisChatTransport, signal: AbortSignal): Promise<void> {
  let onAbort: () => void = () => {}
  try {
    await Promise.race([ctx.ready, new Promise<void>(resolve => { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }) })])
  } catch (error) { ctx.report(SOURCE, { state: 'error', detail: String(error) }); return }
  finally { signal.removeEventListener('abort', onAbort) }
  while (!signal.aborted) {
    const config = ctx.config<ElpisChatConfig>(SOURCE)
    try {
      if (config?.threadId) await pollElpisChat(ctx, transport, signal)
      else ctx.report(SOURCE, { state: 'paused', detail: config ? 'Choose the Elpis’s chat' : 'Off' })
    } catch (error) { if (!signal.aborted) ctx.report(SOURCE, { state: 'error', detail: String(error) }) }
    await pause((ctx.config<ElpisChatConfig>(SOURCE)?.pollSeconds ?? 2) * 1000, signal)
  }
}
