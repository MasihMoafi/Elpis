// A turn's folded work says "Worked for 4s" when its times were recorded (Masih's chatgpt-superior-chat-design screenshots,
// 20 October); otherwise it says what it holds, counted by kind, in the activity rows' words ("2 messages, browsed the web,
// ran a command"). Masih, 29 Oct, on "6 previous messages" for searches and commands: "I think it's wrong."
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const step = id => ({ id, type: 'commandExecution', command: `npm run ${id}`, cwd: '/tmp', status: 'completed', exitCode: 0, aggregatedOutput: 'ok', durationMs: 900, commandActions: [{ type: 'unknown', command: `npm run ${id}` }] });

test('a turn without recorded times says what its fold holds; a timed turn still says how long it worked', async () => {
  const said = (id, text) => ({ id, type: 'agentMessage', text });
  const web = id => ({ id, type: 'webSearch', query: 'elpis', status: 'completed' });
  const chat = [['t1', 'Timed question', 'Timed answer', [step('a'), step('b')]], ['t2', 'Untimed question', 'Untimed answer', [step('c'), step('d'), step('e')], null],
    ['t3', 'Mixed question', 'Mixed answer', [said('m1', 'Looking it up.'), web('w1'), said('m2', 'Now checking.'), step('f')], null]];
  const f = await fixture({ chat, width: 1280, height: 900 });
  try {
    await f.open('chat-a');
    const folds = f.page.locator('.worked-for > summary');
    await folds.nth(1).waitFor();
    assert.match(await folds.nth(0).innerText(), /^Worked for \d+s$/, 'the timed turn');
    assert.equal(await folds.nth(1).innerText(), 'Ran 3 commands', 'the untimed turn: three commands, not "3 previous messages"');
    assert.equal(await folds.nth(2).innerText(), '2 messages, browsed the web, ran a command', 'messages and work, each counted by kind');
    await folds.nth(1).click();
    await f.page.locator('.worked-for[open] .worked-for-body').first().waitFor();
    assert.match(await f.page.locator('.worked-for').nth(1).innerText(), /3 commands/, 'opening it shows the folded work');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
