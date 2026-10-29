// Masih, 29 Oct, on an agent turn: "too much empty space here." Between a reply's last line and the next row ("Ran a
// command", "Thought", the next reply) the space is the same above and below each row, and tight; a reply's hover
// actions never cover the row after it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

const shots = process.env.ELPIS_PARITY_SHOTS;
const said = (id, text) => ({ id, type: 'agentMessage', text });
const step = id => ({ id, type: 'commandExecution', command: `npm run ${id}`, cwd: '/tmp', status: 'completed', exitCode: 0, aggregatedOutput: 'ok', durationMs: 900, commandActions: [{ type: 'unknown', command: `npm run ${id}` }] });
const thought = id => ({ id, type: 'reasoning', summary: ['Weighing the order of the release steps.'], content: [] });
const chat = [['t1', 'Plan the release.', 'The release is ready to tag.', [
  said('m1', 'First I read the release notes.'), step('notes'), said('m2', 'Now the changelog.'), thought('r1'),
  said('m3', 'Then the tag.'), said('m4', 'And the announcement.'),
]]];

/** Every text row of the open turn, top to bottom: replies (their text only) and activity rows (their label). */
const rows = page => page.evaluate(() => {
  const ink = element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    return { top: Math.min(...rects.map(rect => rect.top)), bottom: Math.max(...rects.map(rect => rect.bottom)) };
  };
  const turn = document.querySelector('.turn:has(.worked-for[open])');
  return [...turn.querySelectorAll('.message.agent .message-body, .activity-group > summary, .worked-for > summary')].map(element => ({
    name: element.matches('.message-body') ? `reply "${element.textContent.trim().slice(0, 18)}"` : `row "${element.textContent.trim()}"`,
    ...ink(element),
  }));
});

for (const colorScheme of ['light', 'dark']) test(`rows in a turn sit at even, tight gaps and hover actions cover nothing (${colorScheme})`, async () => {
  const f = await fixture({ colorScheme, chat, width: 1130, height: 900 }), { page } = f;
  try {
    await f.open('chat-a');
    await page.locator('.worked-for > summary').click();
    await page.locator('.worked-for[open] .activity-group').first().waitFor();
    const list = await rows(page);
    const gaps = list.slice(1).map((row, i) => ({ between: `${list[i].name} → ${row.name}`, gap: +(row.top - list[i].bottom).toFixed(1) }));
    if (shots) {
      await fs.mkdir(shots, { recursive: true });
      const turn = await page.locator('.turn').last().boundingBox();
      await page.screenshot({ path: path.join(shots, `turn-spacing-${colorScheme}.png`), clip: { x: turn.x, y: turn.y, width: turn.width, height: Math.min(turn.height, 900 - turn.y) } });
    }
    const report = gaps.map(item => `${item.between}: ${item.gap}`).join('\n');
    const values = gaps.map(item => item.gap);
    assert.ok(Math.max(...values) - Math.min(...values) <= 2, `even gaps:\n${report}`);
    assert.ok(Math.max(...values) <= 20, `tight gaps:\n${report}`);
    // A reply's actions, shown on hover, stay clear of the next row.
    for (const [index, reply] of (await page.locator('.turn .message.agent').all()).entries()) {
      await reply.hover();
      const actions = reply.locator('.message-actions');
      if (!await actions.isVisible()) continue;
      const [a, next] = [await actions.boundingBox(), await reply.evaluate(element => {
        const all = [...element.closest('.turn').querySelectorAll('.message.agent .message-body, .activity-group > summary, .worked-for > summary')];
        const after = all.find(other => element.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING && !element.contains(other));
        if (!after) return null; const rect = after.getBoundingClientRect(); return { top: rect.top };
      })];
      if (next) assert.ok(a.y + a.height <= next.top, `reply ${index + 1}: its actions (bottom ${a.y + a.height}) stay above the next row (top ${next.top})`);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
