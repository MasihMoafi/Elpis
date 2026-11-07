// Ported from dsh-superagent (MIT), tests/registry.spec.ts
import { it } from 'node:test'
import { expect } from 'expect'
import { z } from 'zod'
import { SourceRegistry } from './registry.mts'
import { githubKind } from './github.mts'
import { HealthBoard } from '../infra/health.mts'
import type { SourceKind } from './kind.mts'
import type { Settings } from './settings.mts'

const probe: SourceKind<{ interval: number }> = {
  kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
  schema: z.object({ interval: z.number().int().min(1).default(5) }).strict(), fields: [],
}
const settings = (sources: Settings['sources'] = {}): Settings => ({ sources, policy: { sources: {} } })

it('lists installed kinds in order and preserves stored uninstalled kinds', () => {
  const sources = new SourceRegistry(() => settings({ probe: { enabled: false, config: { interval: 9 } }, retired: { enabled: true, config: { x: 1 } } }))
  sources.register(probe); sources.register(githubKind)
  expect(sources.instances()).toEqual([
    { id: 'github', kind: 'github', enabled: true, config: { repository: '', cli: '', pollSeconds: 60, failuresBeforeError: 3, observeIssues: false, observePulls: false, observeComments: false, observeCi: false }, installed: true },
    { id: 'probe', kind: 'probe', enabled: false, config: { interval: 9 }, installed: true },
    { id: 'retired', kind: 'retired', enabled: true, config: { x: 1 }, installed: false },
  ])
})
it('validates submitted configuration and rejects unknown kinds', () => {
  const sources = new SourceRegistry(() => settings())
  sources.register(probe)
  expect(sources.validate('probe', { enabled: true, config: {} })).toEqual({ enabled: true, config: { interval: 5 } })
  expect(() => sources.validate('probe', { enabled: true, config: { interval: 0 } })).toThrow()
  expect(() => sources.validate('missing', { enabled: true, config: {} })).toThrow('not installed')
})
it('releases health claims after failure and unregister', () => {
  const board = new HealthBoard()
  board.claim('runtime')
  const sources = new SourceRegistry(() => settings(), board)
  const unregister = sources.register(githubKind)
  expect(() => sources.register({ ...probe, health: ['probe', 'runtime'] })).toThrow('runtime')
  expect(() => sources.register({ ...probe, health: ['sync:probe'] })).toThrow('sync:probe')
  const release = sources.register({ ...probe, health: ['probe'] })
  release(); unregister()
  expect(() => sources.register(githubKind)).not.toThrow()
})
it('disables invalid stored configuration while retaining defaults', () => {
  const sources = new SourceRegistry(() => settings({ probe: { enabled: true, config: { interval: 0 } } }))
  sources.register(probe)
  expect(sources.instance('probe')).toEqual({ id: 'probe', kind: 'probe', enabled: false, config: { interval: 5 } })
  expect(sources.scope({ source: 'probe', meta: {} })).toEqual({ listened: false, reason: 'source_disabled' })
})
