// A turn's folded work is labelled as ChatGPT labels it (Masih's chatgpt-superior-chat-design screenshots, 20 October):
// "Worked for 4s" when its times were recorded, otherwise "3 previous messages".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const step = id => ({ id, type: 'commandExecution', command: `npm run ${id}`, cwd: '/tmp', status: 'completed', exitCode: 0, aggregatedOutput: 'ok', durationMs: 900, commandActions: [{ type: 'unknown', command: `npm run ${id}` }] });

test('a turn without recorded times folds into "N previous messages"; a timed turn still says how long it worked', async () => {
  const chat = [['t1', 'Timed question', 'Timed answer', [step('a'), step('b')]], ['t2', 'Untimed question', 'Untimed answer', [step('c'), step('d'), step('e')], null]];
  const f = await fixture({ chat, width: 1280, height: 900 });
  try {
    await f.open('chat-a');
    const folds = f.page.locator('.worked-for > summary');
    await folds.nth(1).waitFor();
    assert.match(await folds.nth(0).innerText(), /^Worked for \d+s$/, 'the timed turn');
    assert.equal(await folds.nth(1).innerText(), '3 previous messages', 'the untimed turn');
    await folds.nth(1).click();
    await f.page.locator('.worked-for[open] .worked-for-body').first().waitFor();
    assert.match(await f.page.locator('.worked-for').nth(1).innerText(), /3 commands/, 'opening it shows the folded work');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
