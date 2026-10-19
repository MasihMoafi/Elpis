// Agent work worded as Claude's desktop app words it (its ion-dist source): a running step is the model's own sentence
// with a ticking timer ("1m 2s") and animated dots; a finished group lists what was done in the order it began, with the
// failure count on its own phrase ("Edited and read app.ts, used rag, ran 2 commands (1 failed)"); one described step
// reads as its sentence. Local fixture of the bridge (parity-fixture); no engine, no model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { oranges } = require('./controls.cjs');

const SENTENCE = 'Stopping local site and moving worktree and running setup into legal';
const unknown = command => [{ type: 'unknown', command }];
const command = (id, extra = {}) => ({ id, type: 'commandExecution', command: `npm run ${id}`, cwd: CWD, status: 'completed', exitCode: 0, aggregatedOutput: 'ok', durationMs: 900, commandActions: unknown(`npm run ${id}`), ...extra });
const read = (id, name) => command(id, { command: `sed -n 1,40p src/${name}`, commandActions: [{ type: 'read', command: `sed -n 1,40p src/${name}`, name, path: `${CWD}/src/${name}` }] });
const change = (id, kind, path) => ({ id, type: 'fileChange', status: 'completed', changes: [{ path, kind: { type: kind }, diff: '- a\n+ b' }] });
const CHAT = [
  ['t1', 'Tidy the build folder.', 'Tidied.', [command('c1', { command: 'ls -la /tmp/build', description: 'Listed everything created outside the legal folder' })]],
  ['t2', 'Fix the parser.', 'Parser fixed.', [change('f1', 'update', 'src/app.ts'), read('r1', 'app.ts'),
    { id: 'm1', type: 'mcpToolCall', server: 'rag', tool: 'search', status: 'completed', arguments: { query: 'parser' }, result: { content: [{ type: 'text', text: '2 hits' }] } },
    command('c2'), command('c3', { status: 'failed', exitCode: 1, aggregatedOutput: 'Error: expected 2, got 3' })]],
  ['t3', 'Survey the repo.', 'Surveyed.', [command('s1', { commandActions: [{ type: 'search', command: 'rg TODO', query: 'TODO', path: null }] }), command('l1', { commandActions: [{ type: 'listFiles', command: 'ls src', path: 'src' }] }),
    read('r2', 'a.ts'), read('r3', 'b.ts'), change('f2', 'add', 'notes/new.md'), change('f3', 'delete', 'notes/old.md')]],
  // The running turn is always t4 in the fixture.
  ['t4', 'Restart the local site.', 'Restarting.', [command('c4', { command: 'pkill -f dev && git worktree move a b', description: SENTENCE, status: 'inProgress', exitCode: null, aggregatedOutput: '', durationMs: null })]],
];
const seconds = text => { const m = text.match(/^(?:(\d+)m )?(\d+)s$/); assert.ok(m, `a timer reads "39s" or "1m 2s", not "${text}"`); return Number(m[1] ?? 0) * 60 + Number(m[2]); };
const captures = process.env.ELPIS_APP_SCREENSHOTS || '/tmp';

async function using(run) {
  const f = await fixture({ running: true, chat: CHAT, height: 760 });
  try { await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []); } finally { await f.close(); }
}

test('finished groups read as Claude words them, and a described step reads as its sentence', () => using(async ({ page }) => {
  for (const fold of await page.locator('.worked-for > summary').all()) await fold.click();
  const rows = (await page.locator('.activity-group:not(:has(.live-timer)) > summary .activity-group-label').allInnerTexts()).map(text => text.trim());
  assert.deepEqual(rows, [
    'Listed everything created outside the legal folder',
    'Edited and read app.ts, used rag, ran 2 commands (1 failed)',
    'Searched code, listed files, read 2 files, created a file, deleted a file',
  ]);
  // The failure count sits on its phrase, in red, and nothing else is red in the row.
  const mixed = page.locator('.activity-group > summary').filter({ hasText: /^Edited and read app\.ts/ });
  const mark = mixed.locator('.activity-group-failed');
  assert.equal((await mark.innerText()).trim(), '(1 failed)');
  assert.equal(await mixed.locator('.live-timer').count(), 0, 'a finished row has no timer');
  await mixed.click();
  const mixedGroup = mixed.locator('..');
  assert.equal(await mixedGroup.getByText('2 hits', { exact: true }).count(), 0, 'tool output stays lazy until its own row opens');
  await mixedGroup.locator('.step-title').filter({ hasText: /rag/i }).click();
  await mixedGroup.getByText('2 hits', { exact: true }).waitFor();
  // Opened, the described command is titled by its sentence and still shows its script.
  const single = page.locator('.activity-group').filter({ hasText: /^Listed everything created/ });
  await single.locator('> summary').click();
  assert.equal((await single.locator('.step-title').innerText()).trim(), 'Listed everything created outside the legal folder');
  assert.match(await single.locator('.step-script').innerText(), /ls -la \/tmp\/build/);
}));

test('a running step is the model\'s sentence with a ticking timer and moving dots, in both themes and under reduced motion', () => using(async ({ page }) => {
  const live = page.locator('.activity-group').filter({ has: page.locator('.live-dots') });
  await live.locator('.live-timer').waitFor();
  assert.equal((await live.locator('.live-label').innerText()).trim(), SENTENCE, 'the sentence, not "Running <command>"');
  assert.doesNotMatch(await live.locator('> summary').innerText(), /pkill|worktree move/, 'the raw command stays inside the opened step');
  const timer = live.locator('.live-timer');
  const first = seconds((await timer.innerText()).trim());
  assert.ok(first >= 119 && first <= 130, `the timer counts from the step's start (${first}s)`);
  await page.waitForTimeout(2300);
  const later = seconds((await timer.innerText()).trim());
  assert.ok(later >= first + 2, `the timer ticks (${first}s, then ${later}s)`);
  assert.equal(await page.locator('.turn-working').count(), 0, 'one live line: the running step, not a second "Working"');
  const dot = live.locator('.live-dots i').first();
  assert.notEqual(await dot.evaluate(node => getComputedStyle(node).animationName), 'none', 'the dots move');
  // Light, then dark: the row is fully inside the chat column and legible.
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(200);
    const box = await live.locator('> summary').boundingBox(), column = await page.locator('.turn').last().boundingBox();
    assert.ok(box.x >= column.x - 8 && box.x + box.width <= column.x + column.width + 1, `${scheme}: the row fits the chat column`);
    if (scheme === 'light') assert.deepEqual(await oranges(page), [], 'light: no orange');
    await fs.mkdir(captures, { recursive: true });
    await page.screenshot({ path: path.join(captures, `step-sentences-${scheme}.png`) });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(100);
  assert.equal(await dot.evaluate(node => getComputedStyle(node).animationName), 'none', 'reduced motion: the dots stay still');
}));

for (const value of [
  { name: 'recorded', summary: ['The recorded fixture summary.'], content: [], expected: 'The recorded fixture summary.' },
  { name: 'missing', summary: [], content: [], expected: 'No reasoning summary was recorded for this step.' },
]) for (const input of ['pointer', 'keyboard']) {
  test(`Thought exposes ${value.name} reasoning with one ${input} activation`, async () => {
    const f = await fixture({ running: true, chat: [['t4', 'Check the recorded step.', 'I will check the record.',
      [{ id: 'reasoning-fixture', type: 'reasoning', status: 'completed', summary: value.summary, content: value.content }]]] });
    try {
      await f.open('chat-a');
      const group = f.page.locator('.activity-group'), head = group.locator('> summary');
      assert.equal(await group.count(), 1); assert.equal((await head.innerText()).trim(), 'Thought');
      for (const scheme of ['light', 'dark']) {
        await f.page.emulateMedia({ colorScheme: scheme });
        if (input === 'keyboard') { await head.focus(); await head.press('Enter'); } else await head.click();
        await group.locator('> summary[aria-expanded="true"]').waitFor();
        if (input === 'pointer') {
          await fs.mkdir(captures, { recursive: true });
          await f.page.screenshot({ path: path.join(captures, `thought-${value.name}-${scheme}.png`) });
        }
        assert.equal(await group.getByText(value.expected, { exact: true }).isVisible(), true, `${scheme}: the first activation exposes recorded text or its honest absence`);
        if (input === 'keyboard') await head.press('Space'); else await head.click();
        await group.locator('> summary[aria-expanded="false"]').waitFor();
        assert.equal(await group.getByText(value.expected, { exact: true }).isVisible(), false, 'closing the outer group hides its contents');
      }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
