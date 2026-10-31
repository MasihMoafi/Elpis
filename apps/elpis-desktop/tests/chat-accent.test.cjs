const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, THREADS } = require('./parity-fixture.cjs');
const { openSettings, leaveSettings, chooseOption } = require('./controls.cjs');

for (const colorScheme of ['light', 'dark']) test(`chat indicators follow their owner at every context level (${colorScheme})`, async t => {
  const threads = [{ ...THREADS[0], name: 'Love Spot' }, { ...THREADS[1], name: 'Love Spot · Newton' }, THREADS[2]];
  let used = 100;
  const routes = {
    '/api/context/switches': () => ({ version: 'test', write: { available: true }, smartPrune: true, subagents: true, rag: false }),
    ...Object.fromEntries(threads.map(thread => [`/api/threads/${thread.id}/context`, () => ({ threadId: thread.id, ledger: { used, window: 1000, categories: [], basis: 'engine' }, compact: { available: true } })])),
  };
  const f = await fixture({ colorScheme, width: 1440, height: 900, threads, routes });
  t.after(() => f.close()); const { page } = f;
  await f.open('chat-a'); await openSettings(page);
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: colorScheme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
  await chooseOption(page.getByLabel('Accent colour', { exact: true }), 'teal'); await leaveSettings(page);
  for (const percent of [10, 75, 96]) {
    used = percent * 10;
    for (const thread of threads) {
      await f.open(thread.id);
      await page.waitForFunction(percent => document.querySelector('.context-ring')?.getAttribute('aria-label')?.includes(`${percent}%`), percent);
      const colours = await page.evaluate(id => {
        const main = document.querySelector('.workspace'), probe = document.createElement('span'); main.append(probe);
        probe.style.color = id === 'chat-c' ? 'var(--primary)' : 'var(--love-red)';
        const expected = getComputedStyle(probe).color; probe.remove();
        const row = document.querySelector(`.thread-row[data-thread-id="${id}"]`);
        row.append(probe); probe.style.color = 'var(--primary)'; const rowAccent = getComputedStyle(probe).color; probe.remove();
        return { expected, main: getComputedStyle(main).getPropertyValue('--primary').trim(), rings: [...main.querySelectorAll('.context-ring-fill')].map(node => getComputedStyle(node).stroke), dots: [...main.querySelectorAll('.feature-chip[aria-pressed="true"] .feature-dot')].map(node => getComputedStyle(node).backgroundColor), row: rowAccent };
      }, thread.id);
      assert.equal(colours.rings.length, 1, 'the composer retains the one context-ring control');
      assert.equal(await page.getByRole('button', { name: 'Ledger', exact: true }).count(), 0, 'there is no duplicate Ledger button');
      assert.ok(colours.dots.length >= 2, 'enabled feature controls are present');
      for (const colour of [...colours.rings, ...colours.dots, colours.row]) assert.equal(colour, colours.expected, `${thread.name} at ${percent}% uses its own accent`);
    }
  }
  assert.deepEqual(f.errors, []);
});
