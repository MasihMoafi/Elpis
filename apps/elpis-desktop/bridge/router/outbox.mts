// Adapted from dsh-superagent (MIT), src/app/outbox.ts. Receipts and effects share one transaction.
import { z } from 'zod'
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from './core/index.mts'
import { Later, type Effects } from './executor/effects.mts'
import type { ExecutorStore } from './executor/store.mts'
import type { SourceRegistry } from './sources/registry.mts'
import type { Commands } from './infra/commands.mts'

const ReceiptSchema = z.object({ id: z.string(), channel: z.object({ source: z.string(), thread: z.string(), address: z.record(z.string(), z.string()) }),
  text: z.string(), kind: z.enum(['acknowledgement', 'reply', 'notice']), ticketId: z.string().optional(), status: z.enum(['pending', 'sent', 'dropped']) })
export class Outbox implements OutboxPort {
  private readonly store: ExecutorStore
  private readonly effects: Effects
  constructor(store: ExecutorStore, effects: Effects, sources: SourceRegistry, commands: Commands, paused: () => boolean) {
    this.store = store; this.effects = effects
    store.db.exec('CREATE TABLE IF NOT EXISTS reply_receipt (id TEXT PRIMARY KEY, value TEXT NOT NULL);')
    effects.handle('reply', async (_payload, id) => {
      const receipt = this.get(id)
      if (receipt?.status !== 'pending') return
      if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off')
      if (!sources.channelAllowed(receipt.channel)) { this.settle(receipt, 'dropped'); return }
      const result = await sources.send(receipt, commands)
      if (result === 'waiting') throw new Later('The Source is not installed')
      this.settle(receipt, result === 'gone' ? 'dropped' : 'sent')
    }, { ordered: true, limit: () => paused() ? 0 : 1, retry: [2000, 60_000] })
  }
  private get(id: string) {
    const row = this.store.db.prepare('SELECT value FROM reply_receipt WHERE id=?').get(id)
    if (!row) return undefined
    const { ticketId, ...receipt } = ReceiptSchema.parse(JSON.parse(String(row.value)))
    return { ...receipt, ...(ticketId ? { ticketId } : {}) }
  }
  private settle(message: OutboundMessage, status: ReplyStatus): void {
    this.store.db.prepare('UPDATE reply_receipt SET value=? WHERE id=?').run(JSON.stringify({ ...message, status }), message.id)
  }
  send(message: OutboundMessage): void {
    this.store.atomic(() => {
      if (this.get(message.id)) return
      this.store.db.prepare('INSERT INTO reply_receipt VALUES (?,?)').run(message.id, JSON.stringify({ ...message, status: 'pending' }))
      this.effects.enqueue('reply', message.id, {})
    })
  }
  status(id: string): ReplyStatus | undefined { return this.get(id)?.status }
  withdraw(id: string): void {
    this.store.atomic(() => { const receipt = this.get(id); if (receipt?.status === 'pending') { this.settle(receipt, 'dropped'); this.effects.cancel('reply', id) } })
  }
}
