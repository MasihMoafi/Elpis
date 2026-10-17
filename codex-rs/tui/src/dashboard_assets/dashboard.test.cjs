'use strict';

// Run with node --test dashboard.test.cjs after npm run build.
// Provide Playwright via the normal Node resolution or ELPIS_PLAYWRIGHT_PACKAGE.
// ELPIS_CHROMIUM can select an already-installed Chromium; no browser is downloaded.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

const assets = process.env.ELPIS_DASHBOARD_ASSETS || __dirname;
const token = 'a'.repeat(32);
const failure = "Provider authentication failed. Check the selected provider's sign-in or API key.";

async function readableContrast(page, selectors) {
  const ratios = await page.evaluate(selectors => {
    const ctx = document.createElement('canvas').getContext('2d');
    const rgba = css => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).map(x => x / 255);
    };
    const over = (front, back) => front.slice(0, 3).map((x, i) => x * front[3] + back[i] * (1 - front[3])).concat(1);
    const background = node => node ? over(rgba(getComputedStyle(node).backgroundColor), background(node.parentElement)) : [1, 1, 1, 1];
    const luminance = color => color.slice(0, 3).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
    return selectors.map(selector => {
      const node = document.querySelector(selector);
      const bg = background(node);
      const fg = over(rgba(getComputedStyle(node).color), bg);
      const a = luminance(fg), b = luminance(bg);
      return { selector, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
  }, selectors);
  for (const { selector, ratio } of ratios) assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)} < 4.5`);
  return ratios;
}

for (const colorScheme of ['dark', 'light']) {
  for (const width of [1440, 1024, 768, 390, 320]) {
    test(`pruning state and controls: ${colorScheme}, ${width}px`, async () => {
      const browser = await chromium.launch({
        executablePath: process.env.ELPIS_CHROMIUM || undefined,
        headless: true,
      });
      try {
        const page = await browser.newPage({ viewport: { width, height: 1100 }, colorScheme });
        page.setDefaultTimeout(5_000);
        const errors = [];
        const requests = [];
        const saves = [];
        let disconnected = false;
        page.on('pageerror', error => errors.push(error.message));
        const envelope = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/activity-state.json')));
        envelope.heartbeat_at = Date.now();
        envelope.state.context.model = 'gpt-6.1-sol';
        envelope.state.context.models = {
          chat: { provider: 'openai', model: 'gpt-6.1-sol' },
          background: null,
          pruner: { provider: 'openai', model: 'gpt-6-luna' },
        };
        Object.assign(envelope.state.smart_prune.latest_attempt, {
          status: 'model_error', model: 'deepseek/deepseek-v4.1-flash', failure_reason: failure,
        });
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          requests.push(url.pathname);
          if (url.pathname === '/data.json') return route.fulfill(disconnected ? { status: 503, body: 'Unavailable' } : { json: envelope });
          if (url.pathname === '/agents.json') return route.fulfill({ json: { agents: [] } });
          if (url.pathname === `/models/${token}`) {
            if (route.request().method() === 'POST') {
              saves.push(route.request().postDataJSON());
              return route.fulfill({ json: { message: 'Saved', models: envelope.state.context.models } });
            }
            return route.fulfill({ json: { providers: [{ id: 'openai', name: 'OpenAI' }] } });
          }
          if (url.pathname === `/models/${token}/openai`) {
            return route.fulfill({ json: { models: [{ id: 'gpt-6-luna', name: 'Luna' }, { id: 'gpt-6.1-sol', name: 'Sol' }] } });
          }
          if (url.pathname.startsWith('/pruner/')) return route.fulfill({ json: { system_prompt: 'Keep facts.' } });
          if (url.pathname.startsWith('/provider-keys/')) return route.fulfill({ json: { providers: [] } });
          if (url.pathname.startsWith('/evidence/')) return route.fulfill({ status: 404, body: '' });
          if (!['/', '/dashboard.js', '/dashboard.css', '/dashboard_workflows.js'].includes(url.pathname)) return route.fulfill({ status: 404, body: '' });
          return route.fulfill({
            body: readFileSync(path.join(assets, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))),
            contentType: url.pathname === '/' ? 'text/html' : url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript',
          });
        });
        await page.goto(`http://fixture.test/#evidence=${token}`);
        const header = await page.evaluate(() => {
          const glyph = document.querySelector('.brand-glyph').getBoundingClientRect();
          const title = document.querySelector('.brand-title').getBoundingClientRect();
          return { iconGap: title.left - glyph.right, iconWidth: glyph.width };
        });
        assert.ok(header.iconGap >= 12, `Icon/text gap ${header.iconGap}px < 12px`);
        assert.ok(header.iconWidth >= 30, `Brand icon shrank to ${header.iconWidth}px`);
        await page.locator('#tab-smart-prune').click();
        await page.locator('#attempt-model').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#attempt-model').textContent(), 'deepseek/deepseek-v4.1-flash');
        assert.match(await page.locator('#smart-configured-model').textContent(), /gpt-6-luna/);
        assert.ok(await page.locator('#attempt-warning').isVisible());
        assert.equal(await page.locator('#attempt-failure-reason').textContent(), failure);
        assert.equal(requests.includes('/claude.json'), false);
        assert.equal(await page.locator('[id^="claude-"]').count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const contrast = await readableContrast(page, ['#attempt-failure-reason', '#smart-configured-model', '.prune-explainer', '#attempt-model', '#panel-smart-prune .section-kicker', '#panel-smart-prune .model-help', '#tab-models']);
        if (process.env.ELPIS_DASHBOARD_SCREENSHOTS) {
          await page.screenshot({ path: path.join(process.env.ELPIS_DASHBOARD_SCREENSHOTS, `prune-${colorScheme}-${width}.png`), fullPage: true });
          await page.locator('.dashboard-navbar').screenshot({ path: path.join(process.env.ELPIS_DASHBOARD_SCREENSHOTS, `header-${colorScheme}-${width}.png`) });
          writeFileSync(path.join(process.env.ELPIS_DASHBOARD_SCREENSHOTS, `header-${colorScheme}-${width}.json`), JSON.stringify(header, null, 2) + '\n');
        }
        // Success and missing attempts must not retain an earlier failure.
        await page.evaluate(() => renderAttempt({ status: 'admitted', model: 'gpt-6-luna', approx_saved_tokens: 2048 }));
        assert.equal(await page.locator('#attempt-warning').isVisible(), false);
        await page.evaluate(() => renderAttempt(null));
        assert.ok(await page.locator('#attempt-empty').isVisible());
        assert.equal(await page.locator('#attempt-model').isVisible(), false);
        // Older runtimes have no failure_reason. Never reuse a prior reason.
        await page.evaluate(() => renderAttempt({ status: 'model_error', model: 'gpt-6-luna' }));
        assert.match(await page.locator('#attempt-warning').textContent(), /did not report a reason/);
        await page.evaluate(() => renderModels({ chat: { model: 'gpt-6.1-sol' }, background: { model: 'gpt-6-luna' }, pruner: null }));
        assert.match(await page.locator('#smart-configured-model').textContent(), /inherited from Background/);
        await page.evaluate(() => renderModels(null));
        assert.equal(await page.locator('#smart-configured-model').textContent(), 'Unavailable');
        await page.evaluate(models => renderModels(models), envelope.state.context.models);
        await page.locator('#pruner-change-model').click();
        assert.ok(await page.locator('#panel-models').isVisible());
        contrast.push(...await readableContrast(page, ['#panel-models .model-help', 'label[for="model-provider-pruner"]']));
        if (process.env.ELPIS_DASHBOARD_SCREENSHOTS) {
          writeFileSync(path.join(process.env.ELPIS_DASHBOARD_SCREENSHOTS, `contrast-${colorScheme}-${width}.json`), JSON.stringify(contrast, null, 2) + '\n');
        }
        await page.evaluate(() => scrollTo(0, 0));
        if (process.env.ELPIS_DASHBOARD_SCREENSHOTS) {
          await page.screenshot({ path: path.join(process.env.ELPIS_DASHBOARD_SCREENSHOTS, `models-${colorScheme}-${width}.png`), fullPage: true });
        }
        await page.locator('#model-list-pruner').selectOption('gpt-6-luna');
        await page.locator('#model-save-pruner').click();
        await page.waitForFunction(() => document.getElementById('models-feedback').textContent.includes('Saved'));
        assert.deepEqual(saves, [{ role: 'pruner', provider: 'openai', model: 'gpt-6-luna' }]);
        disconnected = true;
        await page.evaluate(() => poll(true));
        assert.ok(await page.locator('#connection-warning').isVisible());
        assert.match(await page.locator('#transport-status').textContent(), /not answering/);
        assert.match(await page.locator('#freshness-status').textContent(), /Last contact/);
        disconnected = false;
        await page.evaluate(() => poll(true));
        assert.equal(await page.locator('#connection-warning').isVisible(), false);
        assert.equal(await page.locator('#transport-status').textContent(), 'Live');
        const before = await page.locator('html').getAttribute('data-theme');
        await page.locator('#theme-toggle').click();
        assert.notEqual(await page.locator('html').getAttribute('data-theme'), before);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}

test('agent map draws recorded lineage only, keeping unrelated conversations separate', async () => {
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (['/', '/dashboard.js', '/dashboard.css', '/dashboard_workflows.js'].includes(pathname)) return route.fulfill({
        body: readFileSync(path.join(assets, pathname === '/' ? 'index.html' : pathname.slice(1))),
        contentType: pathname === '/' ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : 'application/javascript',
      });
      return route.fulfill({ status: 503, body: 'Unavailable' });
    });
    await page.goto('http://fixture.test');
    await page.evaluate(() => renderAgents({ agents: [
      { id: 'root-a', parent_id: null, title: 'Conversation A', status: 'working' },
      { id: 'child-a', parent_id: 'root-a', title: '<script>unsafe()</script>', status: 'ready' },
      { id: 'root-b', parent_id: null, title: 'Unrelated conversation', status: 'inactive' },
      { id: 'orphan', parent_id: 'not-loaded', title: 'Parent unavailable', status: 'ready' },
    ] }));
    const edges = await page.locator('#agent-map path').evaluateAll(nodes => nodes.map(n => [n.dataset.parentId, n.dataset.childId]));
    assert.deepEqual(edges, [['root-a', 'child-a']]);
    assert.equal(await page.locator('#agent-map [data-agent-id="you"]').count(), 0);
    assert.equal(await page.locator('#agent-map [data-agent-id="root-b"]').count(), 0);
    await page.locator('#tab-agents').click();
    await page.locator('#agents-conversation').selectOption('root-b');
    assert.equal(await page.locator('#agent-map path').count(), 0);
    await page.locator('#agents-conversation').selectOption('orphan');
    assert.equal(await page.locator('#agent-map path').count(), 0);
    await page.locator('#agent-map [data-agent-id="orphan"]').click();
    assert.match(await page.locator('#agent-details').innerText(), /not-loaded/);
    await page.locator('#agents-conversation').selectOption('root-a');
    await page.locator('#agent-map [data-agent-id="child-a"]').click();
    assert.match(await page.locator('#agent-details').innerText(), /root-a/);
    assert.equal(await page.locator('#agent-map script').count(), 0);
  } finally { await browser.close(); }
});

test('agent chat reads the selected child, pages history, and rejects a mismatched thread', async () => {
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage();
    let mismatched = false;
    const reads = [];
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['/', '/dashboard.js', '/dashboard.css', '/dashboard_workflows.js'].includes(url.pathname)) return route.fulfill({
        body: readFileSync(path.join(assets, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))),
        contentType: url.pathname === '/' ? 'text/html' : url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript',
      });
      if (url.pathname.startsWith('/threads/')) {
        reads.push({ path: url.pathname, method: route.request().method() });
        const older = url.searchParams.has('cursor');
        return route.fulfill({ json: { thread: { id: mismatched ? 'wrong-thread' : 'child-a' }, nextCursor: older ? null : 'older-page', data: [{ item: { type: 'agentMessage', text: older ? 'Earlier child message' : '<script>Latest child answer</script>' } }] } });
      }
      return route.fulfill({ status: 503, body: 'Unavailable' });
    });
    await page.goto(`http://fixture.test/#evidence=${token}`);
    await page.evaluate(() => renderAgents({ agents: [
      { id: 'root-a', title: 'Parent', parent_id: null }, { id: 'child-a', title: 'Child', parent_id: 'root-a' },
    ] }));
    await page.locator('#agent-map [data-agent-id="child-a"]').click();
    await page.getByText('<script>Latest child answer</script>', { exact: true }).waitFor();
    assert.equal(await page.locator('#agent-chat-items script').count(), 0);
    await page.locator('#agent-chat-older').click();
    await page.getByText('Earlier child message', { exact: true }).waitFor();
    assert.match(await page.locator('#agent-chat-items').innerText(), /Earlier child message[\s\S]*Latest child answer/);
    mismatched = true;
    await page.locator('#agent-chat-refresh').click();
    await page.waitForFunction(() => document.querySelector('#agent-chat-status').textContent.includes('different conversation'));
    assert.ok(reads.length >= 3);
    assert.ok(reads.every(read => read.method === 'GET' && read.path === `/threads/${token}/child-a`));
  } finally { await browser.close(); }
});

test('workflow drafts start empty, persist explicit dependencies, and reject invalid imports without running agents', async () => {
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const writes = [];
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') writes.push(pathname);
      if (['/', '/dashboard.js', '/dashboard.css', '/dashboard_workflows.js'].includes(pathname)) return route.fulfill({
        body: readFileSync(path.join(assets, pathname === '/' ? 'index.html' : pathname.slice(1))),
        contentType: pathname === '/' ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : 'application/javascript',
      });
      return route.fulfill({ status: 503, body: 'Unavailable' });
    });
    await page.goto('http://fixture.test');
    await page.locator('#tab-workflows').click();
    assert.equal(await page.locator('#workflow-canvas button').count(), 0);
    await page.locator('#workflow-name').fill('My workflow');
    await page.locator('#workflow-add-task').click();
    await page.locator('#workflow-task-title').fill('Inspect sources');
    await page.locator('#workflow-task-instruction').fill('Read the supplied sources.');
    await page.locator('#workflow-task-acceptance-criteria').fill('Identify supported claims.');
    await page.locator('#workflow-add-task').click();
    await page.locator('#workflow-task-title').fill('Review evidence');
    await page.locator('#workflow-task-instruction').fill('Review the first task results.');
    await page.locator('#workflow-task-acceptance-criteria').fill('Each claim has a source.');
    await page.locator('#workflow-dependencies input').check();
    assert.equal(await page.locator('#workflow-canvas path[data-from="task_1"][data-to="task_2"]').count(), 1);
    await page.locator('#workflow-save').click();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1')));
    assert.deepEqual(saved.draft.tasks[1].depends_on, ['task_1']);
    await page.reload(); await page.locator('#tab-workflows').click(); await page.locator('#workflow-reload').click();
    assert.equal(await page.locator('#workflow-canvas button').count(), 2);
    const originalX = await page.locator('#workflow-canvas [data-task-id="task_1"]').evaluate(el => el.style.left);
    await page.locator('#workflow-canvas [data-task-id="task_1"]').focus();
    await page.keyboard.press('Alt+ArrowRight');
    assert.notEqual(await page.locator('#workflow-canvas [data-task-id="task_1"]').evaluate(el => el.style.left), originalX);
    const invalid = structuredClone(saved.draft); invalid.tasks[0].depends_on = ['task_2'];
    await page.getByText('Import a workflow draft', { exact: true }).click();
    await page.locator('#workflow-import-json').fill(JSON.stringify(invalid)); await page.locator('#workflow-import').click();
    assert.match(await page.locator('#workflow-feedback').innerText(), /rejected.*cycle/i);
    assert.equal(await page.locator('#workflow-canvas path[data-from][data-to]').count(), 1);
    await page.evaluate(() => { const original = URL.createObjectURL.bind(URL); URL.createObjectURL = blob => { window.exportedWorkflowBlob = blob; return original(blob); }; });
    const downloadPromise = page.waitForEvent('download'); await page.locator('#workflow-export').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'elpis-workflow-draft.json');
    const exported = JSON.parse(await page.evaluate(() => window.exportedWorkflowBlob.text()));
    assert.deepEqual(exported.tasks[1].depends_on, ['task_1']);
    assert.equal('positions' in exported, false);
    assert.deepEqual(writes, []);
  } finally { await browser.close(); }
});

test('polling clears a removed conversation and rejects its pending transcript', async () => {
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage();
    let pending;
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (['/', '/dashboard.js', '/dashboard.css', '/dashboard_workflows.js'].includes(pathname)) return route.fulfill({
        body: readFileSync(path.join(assets, pathname === '/' ? 'index.html' : pathname.slice(1))),
        contentType: pathname === '/' ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : 'application/javascript',
      });
      if (pathname.startsWith('/threads/')) { pending = route; return; }
      return route.fulfill({ status: 503, body: 'Unavailable' });
    });
    await page.goto(`http://fixture.test/#evidence=${token}`);
    await page.evaluate(() => renderAgents({ agents: [{ id: 'root-a', title: 'A' }, { id: 'root-b', title: 'B' }] }));
    const requested = page.waitForRequest(request => new URL(request.url()).pathname.startsWith('/threads/'));
    await page.locator('#agent-map [data-agent-id="root-a"]').click();
    await requested;
    assert.equal(await page.locator('#agent-chat').isVisible(), true);
    await page.evaluate(() => renderAgents({ agents: [{ id: 'root-b', title: 'B' }] }));
    assert.equal(await page.locator('#agent-chat').isVisible(), false);
    await pending.fulfill({ json: { thread: { id: 'root-a' }, data: [{ item: { type: 'agentMessage', text: 'Removed conversation response' } }] } });
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#agent-chat').isVisible(), false);
    assert.doesNotMatch(await page.locator('#agent-chat-items').innerText(), /Removed conversation response/);
  } finally { await browser.close(); }
});
