const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

for (const colorScheme of ['light', 'dark']) {
  test(`earlier messages remain reachable across compaction and a refused page · ${colorScheme}`, async () => {
    const chat = Array.from({ length: 26 }, (_, index) => [`t${index}`, `History prompt ${index}`, `History reply ${index}`]);
    chat[12] = ['t12', '/compact', '', [{ id: 'compact', type: 'commandExecution', command: 'Compact conversation', status: 'completed' }]];
    chat[15] = ['t15', '/compact keep the code', 'Compaction failed: try again.', [{ id: 'failed-compact', type: 'commandExecution', command: 'Compact conversation', status: 'failed' }]];
    chat[19][3] = [{ id: 'automatic-compact', type: 'contextCompaction' }];
    const entries = chat.flatMap(([turnId, prompt, reply, work = []], index) => [
      { turnId, item: { id: `u-${turnId}`, type: 'userMessage', content: [{ type: 'text', text: prompt }] } },
      ...work.map(item => ({ turnId, item })),
      ...(reply ? [{ turnId, item: { id: `a-${turnId}`, type: 'agentMessage', text: reply } }] : []),
    ].map((entry, position) => ({ ...entry, startedAtMs: 1700000000000 + index * 10000 + position })));
    let rejectNext = true;
    const reads = [];
    const f = await fixture({ desktop: true, width: 1440, height: 900, colorScheme, chat, routes: {
      '/api/threads/chat-a': (_body, url) => {
        const cursor = Number(url.searchParams.get('cursor') ?? 0);
        reads.push(cursor);
        if (cursor && rejectNext) { rejectNext = false; return { __http: 503, error: 'Earlier page temporarily unavailable' }; }
        const data = [...entries].reverse().slice(cursor, cursor + 8);
        return { thread: { id: 'chat-a', name: 'History', cwd: '/history', model: 'claude/opus' }, data, nextCursor: cursor + data.length < entries.length ? String(cursor + data.length) : null };
      },
    } });
    try {
      await f.open('chat-a');
      await f.page.locator('.prompt-rail[data-indexed="true"]').waitFor();
      const earlier = f.page.getByRole('button', { name: 'Load earlier messages', exact: true });
      assert.equal(await earlier.isVisible(), true, 'the prompt rail must not hide history pagination');
      assert.equal(await f.page.getByText('History prompt 0', { exact: true }).count(), 0, 'opening shows only the latest page');
      const latest = await f.page.locator('.message.user').allTextContents();
      await earlier.click();
      await f.page.getByText('Error: Earlier page temporarily unavailable', { exact: true }).waitFor();
      assert.deepEqual(await f.page.locator('.message.user').allTextContents(), latest, 'a refused page preserves loaded messages');
      assert.equal(await earlier.isEnabled(), true, 'a refused page can be retried');
      for (let page = 0; page < 4 && await earlier.count(); page++) {
        await earlier.click();
        await f.page.waitForFunction(() => !document.querySelector('.load-earlier-messages:disabled'));
      }
      assert.equal(await earlier.count(), 0, 'the control disappears only at the first page');
      assert.equal(await f.page.getByText('History prompt 0', { exact: true }).isVisible(), true);
      assert.deepEqual((await f.page.locator('.message.user').allTextContents()).map(text => text.trim()), chat.filter((_, index) => index !== 12).map(turn => turn[1]));
      const markers = f.page.locator('.context-event').filter({ hasText: 'Compacted the context' });
      assert.equal(await markers.count(), 2);
      for (const marker of await markers.all()) assert.equal(await marker.isVisible(), true, 'manual and automatic compactions stay outside collapsed activity');
      assert.equal(await f.page.locator('.message.user').filter({ hasText: '/compact' }).count(), 1, 'a failed compact keeps its prompt and failure, rather than reporting success');
      assert.equal(reads.filter(cursor => cursor === 8).length, 2, 'retry starts at the failed cursor');
      await f.page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0; });
      await f.page.getByText('History prompt 0', { exact: true }).scrollIntoViewIfNeeded();
      await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const shots = path.join(process.env.HOME, '.cache/elpis-shots');
      await fs.mkdir(shots, { recursive: true });
      await f.page.screenshot({ path: path.join(shots, `history-paging-${colorScheme}.png`) });
      await markers.first().scrollIntoViewIfNeeded();
      await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await f.page.screenshot({ path: path.join(shots, `history-compact-${colorScheme}.png`) });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
