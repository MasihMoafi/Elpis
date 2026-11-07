/** Structural Elpis runtime boundary used by the faithfully ported executor; implementations live in sessions.mts. */
import type { SubprocessRuntime } from '../infra/types.mts'
import type { Jobs, Subagents } from './background.mts'

export type SessionEvent = { type: 'user/message'; data: { id: string; source: { kind: string } } }
  | { type: 'assistant/message'; data: { message: { content: { type: 'text'; text: string }[] } } }
export interface Agent {
  readonly id: string
  readonly status: 'running' | 'idle'
  readonly inbox: { remove(id: string): void }
  readonly session: { snapshotEvents(): SessionEvent[] }
  cancel(reason: { kind: 'user' }, options: { keepInbox: boolean }): void
  whenIdle(): Promise<void>
}
export interface RuntimeEvents {
  'agent/status': [event: { agent: Agent; status: Agent['status'] }]
  'agent/inbox/claimed': [event: { agent: Agent; message: { source: { kind: string } } }]
  'session/event': [session: { id: string }, event: SessionEvent]
  'agent/error': [event: { agent: Agent; error: unknown }]
}
export interface Context {
  readonly subprocess: SubprocessRuntime
  readonly agents: ReadonlyMap<string, Agent>
  readonly jobs?: Jobs
  readonly subagents?: Subagents
  refresh?(sessionId: string): Promise<void>
  on<K extends keyof RuntimeEvents>(name: K, listener: (...args: RuntimeEvents[K]) => void): () => void
}
