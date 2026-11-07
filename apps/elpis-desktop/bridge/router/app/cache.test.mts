// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/cache.spec.ts.
import { it } from 'node:test'
import { expect } from 'expect'
import { TextCache } from './cache.mts'

it('drops the least recently used texts once they exceed the limit, but never the text just set', () => {
  const cache = new TextCache(10)
  cache.set('a', 'aaaa'); cache.set('b', 'bbbb')
  expect(cache.get('a')).toBe('aaaa')
  cache.set('c', 'cccc')
  // Reading `a` made `b` the least recently used.
  expect([...cache.entries()]).toEqual([['a', 'aaaa'], ['c', 'cccc']])
  cache.set('a', 'a')
  expect([...cache.entries()]).toEqual([['c', 'cccc'], ['a', 'a']])
  cache.set('big', 'x'.repeat(20))
  expect([...cache.entries()]).toEqual([['big', 'x'.repeat(20)]])
  expect(cache.get('c')).toBeUndefined()
})
