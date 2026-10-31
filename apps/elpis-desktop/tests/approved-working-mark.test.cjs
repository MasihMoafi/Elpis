// Masih, 31 Oct: shrink the window, restore full size, open the right sidebar;
// Working must keep its approved place above the composer. A fixed viewport X
// was the wrong guard: it drifted from the composer after responsive layout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, THREADS, CWD } = require('./parity-fixture.cjs');

for (const colorScheme of ['light', 'dark']) test(`Working stays with the composer through resize, restore and both right panels (${colorScheme})`, async t => {
  const child = { id: 'anchor-agent', name: 'Anchor helper', cwd: CWD, parentThreadId: 'chat-a', source: { subAgent: { thread_spawn: { agent_path: '/root/anchor' } } }, status: { type: 'idle' } };
  const f = await fixture({ colorScheme, running: true, width: 1600, height: 900, threads: [...THREADS, child] });
  t.after(() => f.close());
  const { page } = f;
  await f.open('chat-a');
  const hide = page.getByRole('button', { name: 'Hide agents panel', exact: true });
  if (await hide.count()) await hide.click();
  const check = async label => {
    await page.locator('.turn-working').last().waitFor();
    const m = await page.evaluate(() => {
      const w = document.querySelector('.turn-working'), c = document.querySelector('form.composer');
      const a = w.getBoundingClientRect(), b = c.getBoundingClientRect();
      const mark = w.querySelector('.elpis-working-mark'), icon = mark.getBoundingClientRect();
      return { width: innerWidth, x: a.x, composerX: b.x, gap: b.y - a.bottom, icon: [icon.width, icon.height], count: document.querySelectorAll('.turn-working').length, transform: getComputedStyle(w).transform,
        hollow: getComputedStyle(mark.querySelector('path')).fill, stroke: getComputedStyle(mark.querySelector('path')).strokeWidth, rotation: getComputedStyle(mark.querySelector('.elpis-working-rotor')).animationDuration, blink: getComputedStyle(mark.querySelector('.elpis-working-dot')).animationDuration };
    });
    assert.ok(Math.abs(m.x - m.composerX) <= 1, `${label}: horizontal drift ${JSON.stringify(m)}`);
    assert.ok(Math.abs(m.gap - 14) <= 1, `${label}: vertical drift ${JSON.stringify(m)}`);
    assert.equal(m.count, 1, `${label}: exactly one live status`);
    assert.equal(m.transform, 'none', `${label}: the status row never rotates or translates`);
    assert.ok(m.icon.every(n => Math.abs(n - 18) < 1), `${label}: the approved mark stays 18px`);
    assert.equal(m.hollow, 'none'); assert.notEqual(m.stroke, '0px');
    assert.equal(m.rotation, '4s'); assert.equal(m.blink, '2s');
    if (process.env.ELPIS_PARITY_SHOTS && /wide|restore|closed/.test(label)) {
      await fs.mkdir(process.env.ELPIS_PARITY_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ELPIS_PARITY_SHOTS, `working-${colorScheme}-${label}.png`) });
    }
  };
  await check('wide');
  await page.waitForTimeout(2200); await check('timer');
  for (const width of [1440, 1205, 1004, 900, 820, 760, 680, 1004, 1600]) {
    await page.setViewportSize({ width, height: 900 }); await check(`resize-${width}`);
  }
  await page.getByRole('button', { name: 'Show agents panel', exact: true }).click();
  await page.locator('.team-panel').waitFor(); await check('restored-agents');
  for (const width of [1205, 1004, 820, 1600]) { await page.setViewportSize({ width, height: 900 }); await check(`agents-${width}`); }
  await page.getByRole('button', { name: 'Hide agents panel', exact: true }).click();
  await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
  await page.getByRole('region', { name: 'Side panel' }).waitFor(); await check('restored-sidebar');
  for (const width of [1205, 1004, 820, 1600]) { await page.setViewportSize({ width, height: 900 }); await check(`sidebar-${width}`); }
  await page.getByRole('button', { name: 'Close side panel', exact: true }).click(); await check('closed-sidebar');
  for (const reducedMotion of ['reduce', 'no-preference']) { await page.emulateMedia({ reducedMotion }); await check(reducedMotion); }
  assert.deepEqual(f.errors, []);
});

test('an idle composer has no Working status or reserved status space', async t => {
  const f = await fixture({ running: false }); t.after(() => f.close());
  await f.open('chat-a');
  assert.equal(await f.page.locator('.turn-working').count(), 0);
  assert.equal(await f.page.locator('.composer-working').evaluate(el => el.getBoundingClientRect().height), 0);
  assert.deepEqual(f.errors, []);
});
