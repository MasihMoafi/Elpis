// Real packaged app only: no mocked endpoints, engine or bridge. Start with the handoff's e2e/app.sh.
// ELPIS_WF1_CDP=http://127.0.0.1:9461 ELPIS_WF1_HOME="$h" node --test --test-name-pattern='W3|A27' tests/workflows-wf1.test.cjs
// The same variables with `node tests/workflows-wf1-real.cjs` check an actual filesystem refusal at the bottom.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme } = require('./controls.cjs');

async function openCanvas({ graph, width = 1440, height = 900 }) {
  const home = await fs.realpath(process.env.ELPIS_WF1_HOME || '/not-a-throwaway-home');
  assert.match(home, /^\/tmp\/e2e-[A-Za-z0-9_-]+$/, 'only an app.sh throwaway home is allowed');
  const cdp = process.env.ELPIS_WF1_CDP || '';
  assert.match(cdp, /^http:\/\/127\.0\.0\.1:94[2-9][0-9]$/, 'only the handoff acceptance ports are allowed');
  assert.ok((await fs.readFile(path.join(home, 'app.log'), 'utf8')).includes(`ws://127.0.0.1:${new URL(cdp).port}/`), 'the DevTools endpoint belongs to this throwaway app');
  const cwd = await fs.mkdtemp(path.join(home, 'wf1-project-'));
  const browser = await chromium.connectOverCDP(cdp);
  try {
    const findPage = () => browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1:'));
    let page = findPage();
    for (let tries = 0; !page && tries < 50; tries++) { await new Promise(resolve => setTimeout(resolve, 100)); page = findPage(); }
    assert.ok(page, 'the real Elpis window is open'); page.setDefaultTimeout(10000);
    await page.waitForFunction(() => Boolean(window.elpisDesktop?.storage?.saveItem));
    await page.setViewportSize({ width, height });
    await page.evaluate(async ({ cwd, graph }) => {
      const store = window.elpisDesktop.storage;
      if (!store?.saveItem) throw Error('The real desktop workspace store is required');
      await store.saveItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'wf1', name: 'wf1', cwd }], selectedId: 'wf1' }));
      await store.saveItem('elpis-workflow-draft-v1', JSON.stringify(graph));
      await store.saveItem('elpis-canvas-panel', 'open');
    }, { cwd, graph });
    await page.reload(); await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true }); await canvas.waitFor();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    return { page, canvas, cwd, errors,
      fit: async () => { await canvas.getByRole('button', { name: /fit view/i }).click(); await page.waitForTimeout(400); },
      saved: async () => { await page.waitForTimeout(400); return page.evaluate(() => JSON.parse(window.elpisDesktop.storage.getItem('elpis-workflow-draft-v1'))); },
      close: () => browser.close(),
    };
  } catch (error) { await browser.close(); throw error; }
}

async function refusedWrite() {
  const shots = process.env.ELPIS_SHOTS || '/tmp/wf1-shots/real'; await fs.mkdir(shots, { recursive: true });
  for (const color of ['light', 'dark']) {
    const f = await openCanvas({ graph: { name: 'A30 refused write', nodes: [{ id: 'writer', type: 'agent', position: { x: 0, y: 0 }, data: { title: 'Writer', instruction: 'Write your report.', model: null, provider: null, effort: null, writeScopes: [], acceptanceCriteria: ['Report exists'] } }], edges: [] } });
    try {
      if (await f.page.locator('html').evaluate(el => el.classList.contains('dark')) !== (color === 'dark')) await chooseTheme(f.page, color);
      assert.deepEqual(await fs.readdir(f.cwd), [], 'the project starts empty');
      await fs.chmod(f.cwd, 0o500);
      await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
      const error = f.canvas.getByRole('alert').filter({ hasText: /EACCES|permission|write/i }); await error.waitFor({ timeout: 30000 });
      await f.page.screenshot({ path: `${shots}/A30-${color}-real-refused.png` });
      assert.equal(await f.canvas.locator('.canvas-header').getByRole('alert').count(), 0, 'the real write refusal leaves the toolbar clear');
      const box = await error.boundingBox(), workspace = await f.canvas.boundingBox();
      assert.ok(box.x >= workspace.x && box.x + box.width <= workspace.x + workspace.width + 1, 'the real refusal stays inside its workspace');
      assert.ok(Math.abs(box.y + box.height - workspace.y - workspace.height) <= 14, 'the real refusal appears at the bottom');
      assert.ok(await error.getAttribute('id'), 'the real refusal has an accessible id');
      assert.equal(await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).getAttribute('aria-describedby'), await error.getAttribute('id'), 'Run describes its real refusal');
      assert.match(await error.innerText(), /choose|allow|try/i, 'the person can act on the reason');
      assert.deepEqual(f.errors, []);
      console.log(`PASS A30 real refused write: ${color}`);
    } finally { await fs.chmod(f.cwd, 0o700); await f.close(); }
  }
}

module.exports = { openCanvas };
if (require.main === module) refusedWrite().catch(error => { console.error(error); process.exitCode = 1; });
