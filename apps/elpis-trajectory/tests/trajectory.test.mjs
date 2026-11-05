import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { chromium } from 'playwright-core'

const fixture = JSON.parse(await readFile(new URL('../fixtures/sample.json', import.meta.url), 'utf8'))
const cells = fixture.turns.flatMap(turn => turn.groups.flatMap(group => group.cells))
let server
let browser
let baseURL

async function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

before(async () => {
  const port = await availablePort()
  baseURL = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    stdio: 'pipe',
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
  })
  let serverOutput = ''
  server.stdout.on('data', chunk => { serverOutput += chunk })
  server.stderr.on('data', chunk => { serverOutput += chunk })
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) break
    try {
      if ((await fetch(baseURL)).ok) { ready = true; break }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready, `Vite did not start: ${serverOutput}`)
  const chrome = process.env.CHROME_PATH ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)
  assert.ok(chrome, 'Set CHROME_PATH to a Chromium or Chrome executable')
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] })
})

after(async () => {
  await browser?.close()
  server?.kill('SIGTERM')
})

async function pageWith(document = fixture) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  page.setDefaultTimeout(3_000)
  await page.route('**/api/trajectory', route => route.fulfill({ json: document }))
  await page.goto(baseURL)
  await page.locator('tr[data-record-index]').first().waitFor()
  return page
}

test('the API document renders each record and its timeline', async () => {
  const page = await pageWith()
  try {
    const rows = page.locator('tr[data-record-index]')
    assert.equal(await rows.count(), cells.length)
    assert.equal(await page.locator('[data-timeline-span]').count(), cells.length)
    assert.match(await page.locator('tr[data-record-index="6"]').innerText(), /run tests/)
    assert.ok(await page.locator('[data-kind="tool"][data-error="true"]').count())
    assert.ok(await page.getByText('Earlier history compacted').count())
  } finally { await page.close() }
})

test('folding and searching change the visible ledger', async () => {
  const page = await pageWith()
  try {
    await page.getByRole('button', { name: 'Collapse turns' }).click()
    assert.equal(await page.locator('tr[data-record-index]').count(), 4)
    assert.equal(await page.locator('tr[data-record-index="6"]').count(), 0)
    await page.getByRole('button', { name: 'Expand turns' }).click()
    assert.equal(await page.locator('tr[data-record-index]').count(), cells.length)
    await page.getByRole('searchbox', { name: 'Search trajectory' }).fill('missing fixture')
    const matches = page.locator('tr[data-record-index]')
    assert.ok((await matches.count()) > 0)
    assert.ok((await matches.count()) < cells.length)
    assert.equal(await page.locator('tr[data-record-index="3"]').count(), 0)
    await page.getByRole('searchbox', { name: 'Search trajectory' }).fill('no such trajectory record')
    assert.equal(await matches.count(), 0)
  } finally { await page.close() }
})

test('assistant and request inspectors show the matching cache verdict', async () => {
  const page = await pageWith()
  try {
    await page.locator('tr[data-record-index="2"]').click()
    assert.ok(await page.getByText('Cache hit 87%', { exact: true }).isVisible())
    await page.locator('tr[data-record-index="5"]').click()
    assert.ok(await page.getByText('Cache hit 75%', { exact: true }).isVisible())
    assert.ok(await page.getByText('Cache miss after: Context Ledger update', { exact: true }).isVisible())
    await page.getByRole('tabpanel', { name: 'Summary' }).getByRole('button', { name: 'Request #2', exact: true }).click()
    assert.ok(await page.getByText('Cache hit 75%', { exact: true }).isVisible())
    await page.locator('tr[data-record-index="13"]').click()
    assert.ok(await page.getByText('Cache hit 0%', { exact: true }).isVisible())
    assert.ok(await page.getByText('Cache miss after: compaction', { exact: true }).isVisible())
  } finally { await page.close() }
})

test('the API response, not the sample, supplies rows', async () => {
  const custom = { ...fixture, turns: [{ turn: 99, groups: [{ title: 'Message', cells: [{ index: 77, kind: 'user', text: 'From the API only', timeSeconds: null }] }] }], requestNumbers: [] }
  const page = await pageWith(custom)
  try {
    assert.equal(await page.locator('tr[data-record-index]').count(), 1)
    assert.ok(await page.getByText('From the API only').isVisible())
    assert.equal(await page.locator('tr[data-record-index="6"]').count(), 0)
  } finally { await page.close() }
})

test('request usage adds disjoint output and reasoning buckets', async () => {
  const page = await pageWith()
  try {
    await page.getByRole('button', { name: 'Request #1', exact: true }).click()
    await page.getByRole('tab', { name: 'Usage' }).click()
    const panel = page.getByRole('tabpanel', { name: 'Usage' })
    assert.match(await panel.innerText(), /Output\s+102 tok/)
    assert.match(await panel.innerText(), /Reasoning\s+12 tok/)
    assert.match(await panel.innerText(), /Content\s+90 tok/)
  } finally { await page.close() }
})

test('call and subcall controls fold only their descendants', async () => {
  const page = await pageWith()
  try {
    await page.getByRole('button', { name: 'Collapse subcalls' }).click()
    assert.equal(await page.locator('tr[data-record-index="4"]').count(), 0)
    assert.equal(await page.locator('tr[data-record-index="3"]').count(), 1)
    await page.getByRole('button', { name: 'Expand subcalls' }).click()
    await page.getByRole('button', { name: 'Collapse calls' }).click()
    assert.equal(await page.locator('tr[data-record-index="3"]').count(), 0)
    assert.equal(await page.locator('tr[data-record-index="4"]').count(), 0)
    assert.equal(await page.locator('tr[data-record-index="2"]').count(), 1)
    await page.getByRole('button', { name: 'Expand calls' }).click()
    assert.equal(await page.locator('tr[data-record-index]').count(), cells.length)
  } finally { await page.close() }
})

test('timeline dragging filters rows, right-click clears, and the wheel zooms', async () => {
  const page = await pageWith()
  try {
    const track = page.getByLabel('Timeline overview; drag horizontally to focus events')
    const box = await track.boundingBox()
    assert.ok(box)
    const y = box.y + box.height - 2
    await page.mouse.move(box.x + box.width * 0.10, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.30, y, { steps: 5 })
    await page.mouse.up()
    await page.waitForFunction(total => document.querySelectorAll('tr[data-record-index]').length < total, cells.length)
    assert.ok(await page.locator('tr[data-record-index]').count() > 0)
    await page.mouse.click(box.x + box.width * 0.5, y, { button: 'right' })
    await page.waitForFunction(total => document.querySelectorAll('tr[data-record-index]').length === total, cells.length)
    const domain = page.locator('[data-timeline-domain]')
    const before = await domain.evaluate(node => node.getBoundingClientRect().width)
    await page.mouse.move(box.x + box.width * 0.5, y)
    await page.mouse.wheel(0, -500)
    await page.waitForFunction(width => document.querySelector('[data-timeline-domain]').getBoundingClientRect().width > width, before)
  } finally { await page.close() }
})

test('the current turn stays visible while the ledger scrolls', async () => {
  const page = await pageWith()
  try {
    await page.setViewportSize({ width: 1000, height: 240 })
    const ledger = page.locator('[data-trajectory-scroll]')
    await ledger.evaluate(node => { node.scrollTop = 60 })
    await page.locator('[data-sticky-turn]').waitFor({ state: 'visible' })
    assert.match(await page.locator('[data-sticky-turn]').innerText(), /Turn 1/)
    await ledger.evaluate(node => { node.scrollTop = 260 })
    await page.waitForFunction(() => document.querySelector('[data-sticky-turn]')?.textContent?.includes('Turn 2'))
    const bounds = await page.locator('[data-sticky-turn]').boundingBox()
    const ledgerBounds = await ledger.boundingBox()
    assert.ok(bounds && ledgerBounds && Math.abs(bounds.y - ledgerBounds.y) < 2)
  } finally { await page.close() }
})

test('development falls back to the sample when the API is absent', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/trajectory', route => route.fulfill({ status: 404, body: '' }))
    await page.goto(baseURL)
    await page.locator('tr[data-record-index]').first().waitFor()
    assert.equal(await page.locator('tr[data-record-index]').count(), cells.length)
  } finally { await page.close() }
})

test('unrecorded values do not imply a running call or a complete token total', async () => {
  const custom = { version: 1, threadId: 'missing-values', turns: [{ turn: 1, groups: [
    { title: 'Message', cells: [{ index: 1, kind: 'user', text: 'Check this', timeSeconds: null }] },
    { title: 'Step 1', cells: [
      { index: 2, kind: 'message', text: 'Checking', timeSeconds: null, output: 50 },
      { index: 3, kind: 'tool', text: 'tool with no recorded result', timeSeconds: null }
    ] }
  ] }], requestNumbers: [{ number: 1, turn: 1, step: 1, group: 'Step 1', usage: { input: 200, cacheRead: 100, output: 50 } }] }
  const page = await pageWith(custom)
  try {
    await page.locator('tr[data-record-index="2"]').click()
    assert.match(await page.locator('aside').innerText(), /Output\s+50 tok/)
    assert.doesNotMatch(await page.locator('aside').innerText(), /Tokens\s+50 tok/)
    assert.equal(await page.getByText(/Cache hit/).count(), 0)
    await page.locator('tr[data-record-index="3"]').click()
    assert.match(await page.locator('aside').innerText(), /Status\s+Not recorded/)
    assert.doesNotMatch(await page.locator('aside').innerText(), /Pending/)
    await page.getByRole('button', { name: 'Request #1', exact: true }).click()
    await page.getByRole('tab', { name: 'Usage' }).click()
    const usage = await page.getByRole('tabpanel', { name: 'Usage' }).innerText()
    assert.doesNotMatch(usage, /Input\s+300 tok/)
    assert.match(usage, /Uncached input\s+200 tok/)
    assert.match(usage, /Cached\s+100 tok/)
    assert.match(usage, /Session cumulative\s+Usage not reported/)
  } finally { await page.close() }
})

test('large ledgers retain virtual scrolling and can reach both ends', async () => {
  const many = { version: 1, threadId: 'large', turns: [{ turn: 1, groups: [{ title: 'Step 1', cells: Array.from({ length: 250 }, (_, i) => ({ index: i + 1, kind: 'message', text: `Entry ${i + 1}`, timeSeconds: 1 })) }] }], requestNumbers: [] }
  const page = await pageWith(many)
  try {
    const rows = page.locator('tr[data-record-index]')
    assert.ok((await rows.count()) < 100)
    const ledger = page.locator('[data-trajectory-scroll]')
    await ledger.evaluate(node => { node.scrollTop = 0 })
    await page.locator('tr[data-record-index="1"]').waitFor()
    await ledger.evaluate(node => { node.scrollTop = node.scrollHeight })
    await page.locator('tr[data-record-index="250"]').waitFor()
    assert.ok((await rows.count()) < 100)
  } finally { await page.close() }
})

test('the sample covers turns, three call steps, failures, subtools, compaction and cache changes', () => {
  assert.equal(fixture.version, 1)
  assert.ok(fixture.turns.filter(turn => turn.turn !== null).length >= 3)
  const firstTurn = fixture.turns.find(turn => turn.turn === 1)
  assert.equal(firstTurn.groups.filter(group => /^Step /.test(group.title) && group.cells.some(cell => cell.kind === 'tool')).length, 3)
  assert.ok(cells.some(cell => cell.kind === 'tool' && cell.isError))
  assert.ok(cells.some(cell => cell.kind === 'subtool'))
  assert.ok(fixture.turns.some(turn => turn.turn === null && turn.groups.some(group => group.cells.some(cell => cell.kind === 'compacted'))))
  assert.ok(fixture.requestNumbers.some(request => request.usage?.cacheRead > 0 && request.usage?.cacheWrite > 0))
  assert.ok(fixture.requestNumbers.some(request => request.cache?.cause))
  assert.equal(new Set(cells.map(cell => cell.index)).size, cells.length)
  assert.ok(cells.every(cell => 'timeSeconds' in cell))
})

test('every request remains inspectable when requests share a group or have no record', async () => {
  const custom = {
    version: 1, threadId: 'request-boundaries',
    turns: [{ turn: 1, groups: [
      { title: 'Step 1', cells: [{ index: 1, kind: 'message', text: 'Only response', timeSeconds: 1 }] },
      { title: 'Step 2', cells: [] }
    ] }],
    requestNumbers: [
      { number: 1, turn: 1, step: 1, group: 'Step 1', cache: { hitPercent: 10 } },
      { number: 2, turn: 1, step: 1, group: 'Step 1', cache: { hitPercent: 80 } },
      { number: 3, turn: 1, step: 2, group: 'Step 2', cache: { hitPercent: 0, cause: 'model change' } }
    ]
  }
  const page = await pageWith(custom)
  try {
    await page.locator('tr[data-record-index="1"]').click()
    assert.equal(await page.getByText(/Cache hit/).count(), 0)
    for (const [number, verdict] of [[1, 'Cache hit 10%'], [2, 'Cache hit 80%'], [3, 'Cache hit 0%']]) {
      await page.getByRole('button', { name: `Request #${number}`, exact: true }).click()
      assert.ok(await page.getByText(verdict, { exact: true }).isVisible())
    }
    assert.ok(await page.getByText('Cache miss after: model change', { exact: true }).isVisible())
  } finally { await page.close() }
})
