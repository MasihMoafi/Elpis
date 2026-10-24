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

for (const colorScheme of ['light', 'dark']) {
  test(`a chat whose earliest part is missing says so where its history begins · ${colorScheme}`, async () => {
    // His rust-obsidian chat (24 Oct): the engine opens what remains and marks every page (earliestHistoryMissing).
    const chat = Array.from({ length: 12 }, (_, index) => [`t${index}`, `Remaining prompt ${index}`, `Remaining reply ${index}`]);
    const entries = chat.flatMap(([turnId, prompt, reply]) => [
      { turnId, item: { id: `u-${turnId}`, type: 'userMessage', content: [{ type: 'text', text: prompt }] } },
      { turnId, item: { id: `a-${turnId}`, type: 'agentMessage', text: reply } },
    ]);
    const page = (id, missing) => (_body, url) => {
      const cursor = Number(url.searchParams.get('cursor') ?? 0), data = [...entries].reverse().slice(cursor, cursor + 10);
      return { thread: { id, name: id, cwd: '/history', model: 'gpt-5.5' }, data, nextCursor: cursor + data.length < entries.length ? String(cursor + data.length) : null, ...(missing ? { earliestHistoryMissing: true } : {}) };
    };
    const f = await fixture({ desktop: true, width: 1440, height: 900, colorScheme, chat, routes: { '/api/threads/chat-a': page('chat-a', true) } });
    try {
      await f.open('chat-a');
      const note = f.page.getByRole('note').filter({ hasText: 'The earliest part of this chat is missing' });
      const earlier = f.page.getByRole('button', { name: 'Load earlier messages', exact: true });
      await earlier.waitFor();
      assert.equal(await note.count(), 0, 'not before the start of what remains is shown');
      while (await earlier.count()) { await earlier.click(); await f.page.waitForFunction(() => !document.querySelector('.load-earlier-messages:disabled')); }
      await note.waitFor();
      assert.equal(await note.count(), 1);
      const [noteTop, firstTop] = await Promise.all([note.boundingBox(), f.page.getByText('Remaining prompt 0', { exact: true }).boundingBox()]);
      assert.ok(noteTop.y < firstTop.y, 'the note sits above the first message that remains');
      await note.scrollIntoViewIfNeeded();
      const shots = path.join(process.env.HOME, '.cache/elpis-shots');
      await fs.mkdir(shots, { recursive: true });
      await f.page.screenshot({ path: path.join(shots, `history-missing-earlier-${colorScheme}.png`) });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}

test('a complete chat shows no missing-history note', async () => {
  const chat = [['t0', 'Whole prompt', 'Whole reply']];
  const entries = [{ turnId: 't0', item: { id: 'u-t0', type: 'userMessage', content: [{ type: 'text', text: 'Whole prompt' }] } }, { turnId: 't0', item: { id: 'a-t0', type: 'agentMessage', text: 'Whole reply' } }];
  const f = await fixture({ desktop: true, width: 1440, height: 900, chat, routes: { '/api/threads/chat-a': () => ({ thread: { id: 'chat-a', name: 'Whole', cwd: '/history', model: 'gpt-5.5' }, data: [...entries].reverse(), nextCursor: null }) } });
  try {
    await f.open('chat-a');
    await f.page.getByText('Whole reply', { exact: true }).waitFor();
    assert.equal(await f.page.getByText('The earliest part of this chat is missing').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
