// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/client.spec.tsx, controls.spec.tsx and panel-*.spec.tsx.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { act } from 'react'
import { dom } from './fixtures/dom.mts'
import { panel, field } from './fixtures/panel.mts'
import { en } from './locales.ts'
import { waitFor } from '../../bridge/router/executor/fixtures.mts'
import { savePrompts } from '../../bridge/router/app/prompts.mts'
after(() => dom.window.close())

test('panel text actions use the shared content link instead of resizing a ghost button', async t => {
  const p = await panel(); t.after(p.close)
  const actions = [...document.querySelectorAll('.dt-textlink, .dt-open')]
  assert.ok(actions.length > 0)
  for (const action of actions) {
    assert.equal(action.getAttribute('data-variant'), 'link', action.textContent ?? '')
    assert.equal(action.getAttribute('data-size'), 'content', action.textContent ?? '')
  }
})

test('panel CSS leaves shared control geometry and appearance with the design system', () => {
  const css = readFileSync(new URL('./client.css', import.meta.url), 'utf8')
  // Page-local control rules caused text and prompt navigation to overlap at narrow widths.
  // These controls already own their sizes, focus, type and colours in components/ui and settings/rows.
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]!.trim()
    if (/::(?:before|after)/.test(selector)) continue
    if (/\bbutton\b|\.dt-(?:open|textlink|more-link|nav-item|settings-link|tab|subtab|select|textarea|segment|pill|switch)\b/.test(selector)) {
      assert.doesNotMatch(rule[2]!, /(?:^|;)\s*(?:height|min-height|padding(?:-\w+)?|font(?:-\w+)?|background|border(?:-\w+)?|color)\s*:/, selector)
    }
  }
})

test('Elpis panel exposes every domain page, opens its main session, and remembers navigation', async t => {
  const p = await panel(); t.after(p.close)
  assert.deepEqual([...document.querySelectorAll('[role="tab"]')].map(element => element.textContent), ['Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Settings'])
  await p.click(en.openMaster); assert.deepEqual(p.opened, [p.h.app.masterId])
  for (const name of ['Source', 'Trigger', 'Eval', 'Execution', 'Settings']) await p.click(name, document.querySelector('[aria-label="Elpis"]') ?? document.querySelector('.dt-tabs') ?? document)
  await p.click(en['settingsGroup.prompts'])
  await p.remount(); assert.match(p.text(), /Communication/)
  assert.ok(p.requests.some(request => request.includes('/prompts')))
})

test('the shared glossary dialog explains domain terms and closes through its own control', async t => {
  const p = await panel(); t.after(p.close)
  await p.click(en.glossary)
  const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog)
  assert.match(dialog.textContent ?? '', /An authorized unit of work/)
  await p.click(en.close, dialog); assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('shared segmented choices retain arrow, Home and End navigation', async t => {
  const p = await panel({ page: 'settings', query: { group: 'eval' } }); t.after(p.close)
  const group = [...document.querySelectorAll<HTMLElement>('[role="radiogroup"]')].find(element => element.getAttribute('aria-label') === en.acceptMode)
  assert.ok(group)
  const choices = [...group.querySelectorAll<HTMLElement>('[role="radio"]')]
  assert.equal(choices.length, 3)
  await act(async () => { choices[1]!.click() }); await p.settle()
  for (const [key, index] of [['Home', 0], ['ArrowLeft', 2], ['ArrowRight', 0], ['End', 2]] as const) {
    await act(async () => { group.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    await act(() => delay(30))
    assert.equal(choices[index]!.getAttribute('aria-checked'), 'true', key)
    assert.equal(document.activeElement, choices[index], key)
  }
})

test('deployment limit edits, discard, and save change only the revisioned local configuration', async t => {
  const p = await panel({ page: 'settings', query: { group: 'deployment' } }); t.after(p.close)
  const original = p.h.app.machine.admissionContextMaxPages.get()
  await p.fill(field(en.deploymentContextPages), '3')
  assert.equal(p.h.app.machine.admissionContextMaxPages.get(), original)
  await p.click(en.discard); assert.equal(field(en.deploymentContextPages).value, String(original))
  await p.fill(field(en.deploymentContextPages), '3'); await p.click(en.save)
  assert.equal(p.h.app.machine.admissionContextMaxPages.get(), 3)
  assert.equal(p.h.server.connections.size, 0)
})

test('deployment explains a pending or failed read and enables its fields only after a successful read', async t => {
  const p = await panel()
  const fetch = globalThis.fetch
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = async (input, init) => {
    if (typeof input === 'string' && input.endsWith('/deployment')) {
      await pending
      return Response.json({ error: 'The local service is unavailable.' }, { status: 503 })
    }
    return fetch(input, init)
  }
  t.after(async () => { release(); globalThis.fetch = fetch; await p.close() })
  await p.click(en['tab.settings'], document.querySelector('.dt-column > .dt-tabs') ?? document)
  await p.click(en['settingsGroup.deployment'])
  assert.ok([...document.querySelectorAll('[role="status"]')].some(element => element.textContent === en.loading))
  assert.ok(field(en.deploymentContextPages).matches(':disabled'))
  await act(async () => { release(); await delay(20) })
  assert.ok(document.querySelector('[role="alert"]'))
  assert.ok(field(en.deploymentContextPages).matches(':disabled'))
  globalThis.fetch = fetch
  await p.remount()
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.equal(field(en.deploymentContextPages).matches(':disabled'), false)
})

test('execution drafts survive navigation and saving persists the worker limit through the actual API', async t => {
  const p = await panel({ page: 'settings', query: { group: 'execution' } }); t.after(p.close)
  const initial = p.h.app.store.settings().executor.maxWorkers
  await p.fill(field(en.maxWorkers), String(initial - 1))
  await p.remount(); assert.equal(field(en.maxWorkers).value, String(initial - 1))
  await p.click(en.save); assert.equal(p.h.app.store.settings().executor.maxWorkers, initial - 1)
  assert.ok(p.requests.some(request => request.startsWith('PUT /api/mother/settings/executor')))
})

test('prompt editing, preview and save retain the full composed instructions and their version', async t => {
  const p = await panel({ page: 'settings', query: { group: 'prompts' } }); t.after(p.close)
  await p.fill(field(en.promptBody), 'Always report the checked behavior and remaining uncertainty.')
  assert.equal(p.h.app.prompts.current().revision, 0)
  await p.click(en.save)
  assert.equal(p.h.app.prompts.current().revision, 1)
  assert.equal(p.h.app.prompts.current().config.communication, 'Always report the checked behavior and remaining uncertainty.')
  await p.click(en.promptViewFull)
  assert.match(p.text(), /Always report the checked behavior and remaining uncertainty/)
  assert.ok(p.requests.some(request => request.startsWith('POST /api/mother/prompts/preview')))
})

test('a filtered search result explains why it has no thread and no navigation action', async t => {
  const p = await panel(); t.after(p.close)
  const settings = p.h.app.store.settings()
  p.h.app.store.saveSettings({ ...settings, sources: { ...settings.sources, retired: { enabled: true, config: {} } } })
  p.h.app.engine.receive({ id: 'filtered', source: 'retired', actor: { source: 'retired', id: 'person' }, threads: [{ source: 'retired', id: '1' }], human: true, at: new Date().toISOString(), text: 'Needle from an unavailable source', meta: {} })
  const search = field(en.searchLabel)
  await p.fill(search, 'Needle')
  await act(async () => { search.closest('form')!.requestSubmit() }); await p.settle()
  const results = document.querySelector('.dt-search-results'); assert.ok(results)
  assert.ok(results.textContent?.includes(en['reason.source_not_installed']))
  assert.equal([...results.querySelectorAll('button')].some(button => button.textContent?.includes('Needle')), false)
})

test('a blocked ticket opens its worker and retries or stops only after confirmation through the real API', async t => {
  const p = await panel(undefined, async h => {
    await h.app.start(); const id = h.message('work', 'Inspect this project'); await h.app.pump(); await h.route(id); await h.app.pump()
    const ticket = h.app.store.tickets.list()[0]!
    await waitFor(() => assert.equal(h.app.store.tickets.get(ticket.id)?.assignments.at(-1)?.state, 'running'))
    const worker = h.app.workers.sessions.nativeId(`worker-${ticket.id}`)!
    await h.call(worker, 'orchestrator_report', { state: 'blocked', summary: 'The required project input is unavailable.' })
    h.server.finish(worker); await h.app.pump()
  }); t.after(p.close)
  const ticket = p.h.app.store.tickets.list()[0]!, original = ticket.assignments.length
  assert.match(p.text(), /required project input/)
  await p.click(en.openSession); assert.deepEqual(p.opened, [`worker-${ticket.id}`])
  await p.click(en.retry); await p.click(en.cancel, document.querySelector('[role="alertdialog"]') ?? document)
  assert.equal(p.h.app.store.tickets.get(ticket.id)?.assignments.length, original)
  await p.click(en.retry); await p.click(en.confirm, document.querySelector('[role="alertdialog"]') ?? document)
  assert.equal(p.h.app.store.tickets.get(ticket.id)?.assignments.length, original + 1)
  await p.click(en['tab.execution'], document.querySelector('.dt-tabs') ?? document)
  const row = [...document.querySelectorAll('.dt-ticket')].find(element => element.textContent?.includes(ticket.title)); assert.ok(row)
  await p.click(ticket.title, row)
  await p.click(en.stop); await p.click(en.confirm, document.querySelector('[role="alertdialog"]') ?? document)
  assert.equal(p.h.app.store.tickets.get(ticket.id)?.ended?.outcome, 'stopped')
  assert.ok(p.requests.includes(`POST /api/mother/tickets/${ticket.id}/retry`))
  assert.ok(p.requests.includes(`POST /api/mother/tickets/${ticket.id}/stop`))
})

test('a prompt saved elsewhere refuses the stale save and keeps the local draft', async t => {
  const p = await panel({ page: 'settings', query: { group: 'prompts' } }); t.after(p.close)
  await p.fill(field(en.promptBody), 'Local unsaved instructions.')
  const current = p.h.app.prompts.current()
  await savePrompts({ store: p.h.app.store, prompts: p.h.app.prompts, sessions: p.h.app.workers.sessions },
    { ...current.config, communication: 'Instructions saved elsewhere.' }, current.revision, 'panel')
  await p.click(en.save)
  assert.equal(p.h.app.prompts.current().config.communication, 'Instructions saved elsewhere.')
  assert.equal(field(en.promptBody).value, 'Local unsaved instructions.')
  assert.ok(document.querySelector('[role="alert"]'))
})
