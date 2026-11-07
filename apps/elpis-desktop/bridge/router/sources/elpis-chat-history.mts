import { existsSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { EngineItem } from '../../client-thread-list.mts'

const ReplySchema = z.object({ id: z.string(), threadId: z.string(), text: z.string(), at: z.number(), after: z.string() })
type Reply = z.infer<typeof ReplySchema>
export type ChatHistoryEntry = { turnId: string; item: EngineItem & { phase?: string }; startedAtMs?: number | null; completedAtMs?: number | null }
const identity = (entry: ChatHistoryEntry) => `${entry.turnId}:${entry.item.id}`
const entryOf = (reply: Reply): ChatHistoryEntry => ({ turnId: `router-${createHash('sha256').update(JSON.stringify([reply.threadId, reply.id])).digest('hex')}`,
  item: { id: reply.id, type: 'agentMessage', text: reply.text, phase: 'final_answer' }, startedAtMs: reply.at, completedAtMs: reply.at })

/** Visible router replies: native inject_items is model context only, so these belong to the bridge's chat history. */
export class ElpisChatHistory {
  private readonly directory: string
  private readonly file: string
  constructor(home: string) { this.directory = join(home, 'router'); this.file = join(this.directory, 'chat-replies.sqlite') }
  private read(threadId: string): Reply[] {
    if (!existsSync(this.file)) return []
    const db = new DatabaseSync(this.file, { readOnly: true })
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reply'").get()) return []
      return db.prepare('SELECT value FROM reply WHERE thread=? ORDER BY rowid DESC').all(threadId)
        .map(row => ReplySchema.parse(JSON.parse(String(row.value))))
    }
    finally { db.close() }
  }
  /** The first payload wins, even across clients, crashes and lost acknowledgements. */
  append(threadId: string, reply: { id: string; text: string }, after: string) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.file)
    try {
      chmodSync(this.file, 0o600)
      db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS reply (thread TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(thread,id));')
      const value: Reply = { ...reply, threadId, after, at: Date.now() }
      db.prepare('INSERT INTO reply VALUES (?,?,?) ON CONFLICT(thread,id) DO NOTHING').run(threadId, reply.id, JSON.stringify(value))
      const row = db.prepare('SELECT value FROM reply WHERE thread=? AND id=?').get(threadId, reply.id)
      return entryOf(ReplySchema.parse(JSON.parse(String(row?.value))))
    } finally { db.close() }
  }
  /** Replies share the native item's page; engine cursors stay valid as the conversation grows. */
  merge<T extends ChatHistoryEntry>(threadId: string, page: { data: T[]; nextCursor?: string | null }) {
    const replies = this.read(threadId)
    const data: (T | ReturnType<typeof entryOf>)[] = []
    for (const entry of page.data) {
      for (const reply of replies) if (reply.after === identity(entry)) data.push(entryOf(reply))
      data.push(entry)
    }
    if (!page.nextCursor) for (const reply of replies) if (!reply.after) data.push(entryOf(reply))
    return data
  }
}
