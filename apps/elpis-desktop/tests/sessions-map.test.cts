const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cts');

const graph = {
  nodes: [
    { id: 'thread:chat-a', threadId: 'chat-a', title: 'Elpis', kind: 'router', state: 'working', model: 'sol' },
    { id: 'thread:chat-b', threadId: 'chat-b', title: 'Ticket worker', kind: 'worker', state: 'done' },
    { id: 'thread:chat-c', threadId: 'chat-c', title: 'Research chat', kind: 'chat', state: 'idle' },
    { id: 'thread:agent', threadId: 'agent', title: 'Research agent', kind: 'agent', state: 'failed' },
    { id: 'workflow:run', threadId: 'chat-c', title: 'Review workflow', kind: 'workflow', state: 'working' },
    { id: 'thread:review', threadId: 'review', title: 'Review agent', kind: 'agent', state: 'working' },
  ],
  edges: [
    { source: 'thread:chat-a', target: 'thread:chat-b' },
    { source: 'thread:chat-c', target: 'thread:agent' },
    { source: 'workflow:run', target: 'thread:review' },
  ],
};

for (const colorScheme of ['light', 'dark']) test(`sessions map navigation and readability (${colorScheme})`, async () => {
  let currentGraph = graph;
  const f = await fixture({ width: 1100, height: 750, colorScheme, storage: { 'elpis-workflows-view-v1': 'map' }, routes: {
    '/api/sessions-map': () => currentGraph, '/api/workflows/workspace': () => ({ cwd: '/tmp/parity-fixture' }),
  } });
  const { page } = f;
  try {
    await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    assert.equal(await page.getByRole('radio', { name: 'Map', exact: true }).getAttribute('aria-checked'), 'true');
    const map = page.getByRole('region', { name: 'Sessions map' });
    await map.getByText('Ticket worker', { exact: true }).waitFor();
    assert.equal(await map.locator('.react-flow__node').count(), 6);
    // Wires are drawn once their cards are measured, a moment after the cards.
    await map.locator('.react-flow__edge').nth(2).waitFor({ state: 'attached' });
    assert.equal(await map.locator('.react-flow__edge').count(), 3);
    const boxes = await map.locator('.agent-node').evaluateAll((items: HTMLElement[]) => items.map(item => {
      const box = item.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) {
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
    const size = await map.locator('.agent-node-title').first().evaluate((el: HTMLElement) => {
      const transform = el.closest('.react-flow__viewport');
      if (!transform) throw Error('Map viewport missing');
      return parseFloat(getComputedStyle(el).fontSize) * new DOMMatrix(getComputedStyle(transform).transform).a;
    });
    // The map opens zoomed out (11 Nov, Masih: "more zoomed-out"), and its controls zoom further out and back in.
    assert.ok(size > 9 && size < 12, `the map opens zoomed out: card text renders at ${size}px`);
    const scale = () => map.locator('.react-flow__viewport').evaluate((el: HTMLElement) => new DOMMatrix(getComputedStyle(el).transform).a);
    const opened = await scale();
    await map.getByRole('button', { name: /zoom out/i }).click();
    await page.waitForTimeout(350);
    const out = await scale();
    assert.ok(out < opened, `zoom out shows more: ${opened} to ${out}`);
    await map.getByRole('button', { name: /zoom in/i }).click();
    await page.waitForTimeout(350);
    assert.ok((await scale()) > out, 'zoom in comes back');
    if (colorScheme === 'light') {
      // A re-reading never hides the cards, not for a moment: a hidden card that misses its re-measuring stays
      // hidden (GitHub, 11 Nov: "Ticket worker" was hidden for 6 s after two readings landed together).
      await page.evaluate(() => {
        const seen = window as unknown as { hiddenCards: number };
        seen.hiddenCards = 0;
        new MutationObserver(records => {
          for (const { target } of records) {
            const card = target as HTMLElement;
            if (card.classList.contains('react-flow__node') && card.style.visibility === 'hidden') seen.hiddenCards++;
          }
        }).observe(document.querySelector('.react-flow__viewport')!, { subtree: true, attributes: true, attributeFilter: ['style'] });
      });
      currentGraph = { ...graph, nodes: graph.nodes.map(node =>
        node.id === 'thread:chat-b' ? { ...node, state: 'failed' } : node) };
      await map.locator('[data-id="thread:chat-b"]').getByRole('img', { name: 'failed' }).waitFor({ timeout: 9000 });
      assert.equal(await page.evaluate(() => (window as unknown as { hiddenCards: number }).hiddenCards), 0,
        'a re-reading does not hide the cards');
    }
    const pane = map.locator('.react-flow__pane');
    const box = await pane.boundingBox(); assert.ok(box);
    // The map opens with its newest group at the top, so drag it down: the cards stay inside the pane.
    await page.mouse.move(box.x + 30, box.y + 320); await page.mouse.down();
    await page.mouse.move(box.x + 30, box.y + 450, { steps: 5 }); await page.mouse.up();
    await fs.mkdir('/tmp/elpis-map-shots', { recursive: true });
    await page.screenshot({ path: `/tmp/elpis-map-shots/${colorScheme}.png` });
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(250);
    const transform = await map.locator('.react-flow__viewport').getAttribute('style');
    assert.ok(transform, 'the map keeps a place and a zoom');
    await map.getByText('Ticket worker', { exact: true }).click();
    await page.locator('.thread-row.active[data-thread-id="chat-b"]').waitFor();
    await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await map.getByText('Ticket worker', { exact: true }).waitFor();
    assert.equal(await map.locator('.react-flow__viewport').getAttribute('style'), transform);
    await page.getByRole('radio', { name: 'Board', exact: true }).click();
    await page.getByRole('region', { name: 'Workflows', exact: true }).waitFor();
    await page.getByRole('radio', { name: 'Scheduled', exact: true }).click();
    assert.equal(await page.getByRole('radio', { name: 'Scheduled', exact: true }).getAttribute('aria-checked'), 'true');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('empty map keeps its switch and can show independent chats', async () => {
  const f = await fixture({ storage: { 'elpis-workflows-view-v1': 'map' }, routes: { '/api/sessions-map': (_body: unknown, url: URL) =>
    url.searchParams.get('all') ? { nodes: [graph.nodes[2]], edges: [] } : { nodes: [], edges: [] } } });
  try {
    await f.page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.page.getByText('No chats with agents yet. Start a workflow on the Board, or ask Elpis to run something.').waitFor();
    await f.page.getByRole('switch', { name: 'Show all chats' }).click();
    await f.page.getByText('Research chat', { exact: true }).waitFor();
  } finally { await f.close(); }
});
