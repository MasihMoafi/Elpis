const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');
const { checkAgentsIcon } = require('./agents-icon-check.cjs');
const { AGENTS_ARTWORK } = require('../components/agents-artwork.ts');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

test('Agents artwork matches Users in size and ink at 16, 20 and 24 px', async () => {
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const samples = await page.evaluate(async artwork => {
      // Lucide Users is the B reference in the comparison sheet.
      const users = '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.128a4 4 0 0 1 0 7.744M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>';
      const results = [];
      for (const size of [16, 20, 24]) {
        const metrics = {};
        for (const name of ['agents', 'users']) {
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${name === 'agents' ? artwork.viewBox : '0 0 24 24'}" ${name === 'agents' ? 'fill="black"' : 'fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${name === 'agents' ? `<path fill-rule="evenodd" d="${artwork.d}"/>` : users}</svg>`;
          const image = new Image();
          image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, size, size).data;
          let x0 = size, y0 = size, x1 = -1, y1 = -1, ink = 0, peak = 0;
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const alpha = pixels[(y * size + x) * 4 + 3] / 255;
            ink += alpha;
            peak = Math.max(peak, alpha);
            if (alpha >= 0.5) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
          }
          metrics[name] = { width: x1 - x0 + 1, height: y1 - y0 + 1, ink, peak, centreX: (x0 + x1 + 1) / 2, centreY: (y0 + y1 + 1) / 2 };
        }
        results.push({ size, ...metrics });
      }
      return results;
    }, AGENTS_ARTWORK);
    for (const { size, agents, users } of samples) {
      for (const dimension of ['width', 'height', 'ink', 'peak']) assert.ok(agents[dimension] >= users[dimension] * 0.95, `${size}px Agents ${dimension} ${agents[dimension].toFixed(2)} must match Users ${users[dimension].toFixed(2)}`);
      assert.ok(Math.abs(agents.centreX - size / 2) <= 0.5 && Math.abs(agents.centreY - size / 2) <= 0.5, `${size}px artwork stays centred`);
      assert.ok(agents.width < size && agents.height < size, `${size}px artwork retains an unclipped margin`);
    }
  } finally { await browser.close(); }
});

const parent = { id: 'chat-a', name: 'Agents icon acceptance', cwd: CWD, status: { type: 'idle' } };
const children = Array.from({ length: 16 }, (_, i) => ({ id: `agent-${i}`, name: i === 0 ? 'Agent 1 · inspect' : i === 8 ? 'An agent with a very long descriptive name '.repeat(8) : `Agent ${i + 1}`, ...(i === 0 ? { agentNickname: 'Agent 1' } : {}), cwd: CWD, model: 'gpt-6-luna', modelProvider: 'openai', reasoningEffort: 'max', parentThreadId: parent.id, source: { subAgent: { thread_spawn: { agent_path: `/root/agent-${i}` } } }, status: { type: i === 1 ? 'active' : ['idle', 'notLoaded', 'systemError'][i % 3] } }));

for (const theme of ['light', 'dark']) test(`Agents shares the selected agents artwork in ${theme}, open, closed and after reload`, async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1440, height: 1000, routes: {
    '/api/threads': (_, url) => ({ data: url.searchParams.has('ancestorThreadId') ? children : [parent, ...children], nextCursor: null }),
    ...Object.fromEntries(children.flatMap(thread => [
      [`/api/threads/${thread.id}`, () => thread.id === 'agent-7' ? { __http: 409, error: 'Recorded agent request refused' } : { thread, data: [], nextCursor: null }],
      [`/api/threads/${thread.id}/resume`, () => ({ thread, activeTurnId: null })],
    ])),
  } });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    if (theme === 'dark') await chooseTheme(page, theme);
    await f.open('chat-a');
    const { path: artwork } = await checkAgentsIcon(page);
    const identityRow = page.locator('.team-row[data-thread-id="agent-0"]');
    const teamMark = await identityRow.locator('.agent-mark').getAttribute('aria-label');
    assert.equal(await identityRow.locator('.agent-name').innerText(), 'Agent 1 · inspect', 'the task name appears once without the duplicate nickname');
    assert.equal(await identityRow.getByText('Agent 1', { exact: true }).count(), 0, 'the nickname is not repeated as a second label');
    assert.equal(await identityRow.locator('.agent-model').count(), 1, 'the row keeps one runtime line inside the shared identity');
    assert.equal(await identityRow.locator('small').count(), 0, 'the separate runtime line does not duplicate the identity');
    assert.equal(await page.locator('.team-row[data-thread-id="agent-1"] .team-state').getAttribute('aria-label'), 'Working', 'the live status indicator remains visible');
    if (process.env.ELPIS_A103_SHOTS) {
      await fs.mkdir(process.env.ELPIS_A103_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ELPIS_A103_SHOTS, `renderer-${theme}-100.png`) });
    }
    assert.equal(await page.locator('.team-row').count(), 17, 'all sixteen agents and parent stay listed');
    const sidebarParent = page.locator('.thread-row[data-thread-id="chat-a"]');
    const expand = sidebarParent.getByRole('button', { name: /^Expand agents/ });
    if (await expand.count() && await expand.getAttribute('aria-expanded') !== 'true') await expand.click();
    const sidebarAgent = page.locator('.thread-row[data-thread-id="agent-0"]');
    await sidebarAgent.waitFor();
    assert.equal(await sidebarAgent.locator('.agent-mark').getAttribute('aria-label'), teamMark, 'the Agents pane uses the same ID-stable mark as the sidebar');
    for (const index of [0, 8, 15]) {
      await page.locator('.team-row:not(.root)').nth(index).click();
      await checkAgentsIcon(page);
    }
    await page.locator('.team-row:not(.root)').nth(7).click();
    await page.getByText('Error: Recorded agent request refused', { exact: true }).waitFor();
    await checkAgentsIcon(page);
    await page.locator('.team-row.root').click();
    await page.reload();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.open('chat-a');
    await checkAgentsIcon(page);
    assert.equal(await page.locator('.team-row[data-thread-id="agent-0"] .agent-mark').getAttribute('aria-label'), teamMark, 'the generated identity stays stable after reload');
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const workflowPanel = page.getByRole('button', { name: 'Side panel', exact: true });
    await workflowPanel.waitFor();
    assert.equal(await workflowPanel.locator('svg[data-icon="agents"] path').getAttribute('d'), artwork, 'workflow agents panel shares the artwork');
    assert.equal(await workflowPanel.locator('.lucide-panel-right, .lucide-panel-right-close').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a chat without agents has no Agents button or panel', async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT });
  try {
    await f.open('chat-a');
    assert.equal(await f.page.getByRole('button', { name: /^(Show|Hide) agents panel$/ }).count(), 0);
    assert.equal(await f.page.locator('.team-panel').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
