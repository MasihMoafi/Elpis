// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/retry-health.spec.ts.
import { it } from 'node:test'
import { expect } from 'expect'
import { RetryHealth, type RetryHealthEvent } from './retry-health.mts'

const epoch = Date.parse('2026-09-21T08:00:00Z')
const event = (type: string, seq: number, data: unknown): RetryHealthEvent => ({ type, seq, time: epoch + seq * 1000, data })
const retry = (seq: number, data: Record<string, unknown> = {}) => event('llm/retry', seq, {
  retryId: 'chain-a', turn: 1, step: 2, provider: 'provider-a', mode: 'always', retry: 1, policyKey: 'opaque', delayMs: 10000,
  failure: { code: 'INVALID_REQUEST', message: 'OpenAI API error (400): {"type":"budget_exceeded","message":"Budget has been exceeded! Current cost: 100, Max budget: 99","secret":"never disclose"}' }, ...data,
})
const success = (seq: number, turn = 1, step = 2, provider = 'provider-a'): RetryHealthEvent => ({
  type: 'assistant/message', seq: seq, time: epoch + seq * 1000,   data: { turn, step, stream: [], message: { content: [], source: { kind: 'model', provider, model: 'test-model' } } },
})

it('projects native retry schedules without exposing failure text or policy data', () => {
  const health = new RetryHealth()
  health.observe('worker-a', retry(1))
  health.observe('worker-a', event('llm/retry-started', 2, { retryId: 'chain-a', turn: 1, step: 2, retry: 1 }))
  expect(health.get('worker-a')).toEqual({ sessionId: 'worker-a', provider: 'provider-a', attempts: 1, since: '2026-09-21T08:00:01.000Z', lastAt: '2026-09-21T08:00:01.000Z' })
  health.observe('worker-a', retry(3, { retry: 345 }))
  expect(health.get('worker-a')).toEqual({ sessionId: 'worker-a', provider: 'provider-a', attempts: 345, since: '2026-09-21T08:00:01.000Z', lastAt: '2026-09-21T08:00:03.000Z' })
  expect(JSON.stringify(health.list())).not.toMatch(/secret|Current cost|Max budget|policyKey|failure|chain-a/)
})

for (const failure of [
  { type: 'budget_exceeded', message: 'provider omitted body', code: 'INVALID_REQUEST' },
  { code: 'budget_exceeded', message: 'provider omitted body' },
  { code: 'INVALID_REQUEST', message: '{"error":{"type":"budget_exceeded"}}' },
  { code: 'INVALID_REQUEST', message: 'Budget has been exceeded! Current cost: redacted' },
]) it('recognizes budget failure metadata or a known provider message: %j' + ' ' + JSON.stringify(failure), () => {
  const health = new RetryHealth(); health.observe('master', retry(1, { failure }))
  expect(health.get('master')?.attempts).toBe(1)
})

for (const failure of [
  { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' },
  { code: 'INVALID_REQUEST', status: 429, message: 'Budget has been exceeded!' },
  { code: 'AUTHENTICATION_ERROR', message: 'Budget has been exceeded!' },
  { code: 'INVALID_REQUEST', status: 401, message: 'Budget has been exceeded!' },
  { code: 'CONTEXT_LENGTH_EXCEEDED', message: 'Context budget has been exceeded!' },
  { code: 'INVALID_REQUEST', message: 'maximum context length exceeded' },
  { code: 'INVALID_REQUEST', message: 'a budget was mentioned in this error but was not exceeded' },
  null,
]) it('does not classify another failure as a budget wait: %j' + ' ' + JSON.stringify(failure), () => {
  const health = new RetryHealth(); health.observe('worker', retry(1, { failure }))
  expect(health.list()).toEqual([])
})

it('ignores quoted assistant/user text and failed attempts without a scheduled retry', () => {
  const health = new RetryHealth()
  health.observe('worker', event('user/message', 1, { content: [{ type: 'text', text: 'Budget has been exceeded!' }] }))
  health.observe('worker', event('assistant/message', 2, { turn: 1, step: 2, message: { content: [{ type: 'text', text: '{"type":"budget_exceeded"}' }] } }))
  health.observe('worker', event('assistant/attempt', 3, { turn: 1, step: 2, failure: { type: 'budget_exceeded' } }))
  expect(health.list()).toEqual([])
})

it('keeps independent sessions and starts a fresh status for a new provider or chain', () => {
  const health = new RetryHealth()
  health.observe('a', retry(1, { retry: 12 })); health.observe('b', retry(1, { provider: 'provider-b' }))
  health.observe('a', retry(2, { provider: 'fallback', retry: 1 }))
  expect(health.get('a')).toMatchObject({ provider: 'fallback', attempts: 1, since: '2026-09-21T08:00:02.000Z' })
  health.observe('a', success(3)) // An old provider output must not clear the current chain.
  expect(health.get('a')?.provider).toBe('fallback')
  health.observe('a', retry(4, { provider: 'fallback', retryId: 'chain-b', retry: 1 }))
  expect(health.get('a')?.since).toBe('2026-09-21T08:00:04.000Z')
  health.observe('a', success(5, 1, 2, 'fallback'))
  expect(health.get('a')).toBeUndefined()
  expect(health.get('b')?.provider).toBe('provider-b')
})

it('does not let duplicate, out-of-order or previous-step events replace or clear the active wait', () => {
  const health = new RetryHealth()
  health.observe('worker', retry(5, { step: 3, retry: 2 }))
  health.observe('worker', retry(5, { step: 3, retry: 99 }))
  health.observe('worker', success(4, 1, 3))
  health.observe('worker', success(6, 1, 2))
  health.observe('worker', retry(7, { step: 2, retry: 100 }))
  health.observe('worker', event('turn/end', 8, { turn: 0 }))
  health.observe('worker', retry(9, { step: 3, retry: 1 }))
  expect(health.get('worker')).toMatchObject({ attempts: 2, since: '2026-09-21T08:00:05.000Z', lastAt: '2026-09-21T08:00:05.000Z' })
  health.observe('worker', success(10, 1, 3))
  expect(health.get('worker')).toBeUndefined()
  health.observe('worker', retry(11, { step: 3, retry: 3 }))
  expect(health.get('worker')).toBeUndefined()
})

it('does not treat interrupted assistant output as success', () => {
  const health = new RetryHealth(); health.observe('worker', retry(1))
  const interrupted = success(2)
  health.observe('worker', { ...interrupted, data: { ...(interrupted.data as Record<string, unknown>), interrupted: true } })
  expect(health.get('worker')).toBeDefined()
  health.observe('worker', success(3))
  expect(health.get('worker')).toBeUndefined()
})

it('clears when the active request now retries a different failure, not when the retry starts', () => {
  const health = new RetryHealth(); health.observe('worker', retry(1))
  health.observe('worker', event('llm/retry-started', 2, { retryId: 'chain-a', turn: 1, step: 2, retry: 1 }))
  expect(health.get('worker')).toBeDefined()
  health.observe('worker', retry(3, { retry: 2, failure: { code: 'RATE_LIMIT', status: 429, message: 'Try later' } }))
  expect(health.get('worker')).toBeUndefined()
  health.observe('worker', retry(4, { retry: 3 }))
  expect(health.get('worker')?.since).toBe('2026-09-21T08:00:04.000Z')
})

for (const boundary of ['turn/end', 'turn/start', 'step/start', 'idle', 'disposed']) it('clears active status at %s without reviving on late events' + ' ' + JSON.stringify(boundary), () => {
  const health = new RetryHealth(); health.observe('worker', retry(1))
  if (boundary === 'idle' || boundary === 'disposed') health.clear('worker')
  else health.observe('worker', event(boundary, 2, boundary === 'turn/start' ? { turn: 2 } : boundary === 'step/start' ? { turn: 1, step: 3 } : { turn: 1 }))
  expect(health.get('worker')).toBeUndefined()
  health.observe('worker', retry(3, { retry: 2 }))
  expect(health.get('worker')).toBeUndefined()
  health.observe('worker', retry(4, { turn: 3, step: 1 }))
  expect(health.get('worker')?.attempts).toBe(1)
})

it('reconstructs only the active wait from a restored snapshot and permits idle cleanup', () => {
  const health = new RetryHealth()
  const history = [retry(1), success(2), event('step/start', 3, { turn: 1, step: 3 }), retry(4, { step: 3, retryId: 'chain-b' }), event('llm/retry-started', 5, { turn: 1, step: 3, retryId: 'chain-b', retry: 1 })]
  health.restore('worker', history)
  expect(health.get('worker')).toEqual({ sessionId: 'worker', provider: 'provider-a', attempts: 1, since: '2026-09-21T08:00:04.000Z', lastAt: '2026-09-21T08:00:04.000Z' })
  health.restore('worker', history)
  expect(health.list()).toHaveLength(1)
  health.restore('worker', [...history, event('turn/end', 6, { turn: 1 })])
  expect(health.list()).toEqual([])
  health.restore('worker', history); health.clear('worker')
  expect(health.list()).toEqual([])
})

it('bounds counters and provider labels and exposes detached status values only', () => {
  const health = new RetryHealth()
  health.observe('worker', retry(1, { retry: Number.MAX_VALUE, provider: 'provider-a\nAuthorization: Bearer secret' }))
  expect(health.get('worker')).toMatchObject({ attempts: Number.MAX_SAFE_INTEGER, provider: 'unknown' })
  expect(JSON.stringify(health.list())).not.toContain('secret')
  const status = health.get('worker')!; status.provider = 'mutated'
  health.list()[0]!.attempts = 0
  expect(health.get('worker')).toMatchObject({ attempts: Number.MAX_SAFE_INTEGER, provider: 'unknown' })
})

for (const attempts of [NaN, Infinity, -1, 1.5]) it('ignores malformed retry count %s' + ' ' + JSON.stringify(attempts), () => {
  const health = new RetryHealth(); health.observe('worker', retry(1, { retry: attempts }))
  expect(health.list()).toEqual([])
})
