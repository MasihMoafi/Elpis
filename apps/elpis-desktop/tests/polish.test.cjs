// CI renderer regression gate. Real bridge acceptance uses polish.runtime.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { leaveSettings } = require('./controls.cjs');
const { PAGES, settingsFixture, visit } = require('./settings-row-audit.cjs');
const { scanDisclosures, modelSpacing, cornerWidths, checkWidths, shot } = require('./polish-check.cjs');
const evidence = process.env.ELPIS_POLISH_EVIDENCE;

for (const theme of ['light', 'dark']) {
  test(`POLISH R30: every page and opened disclosure has no triangle markers (${theme})`, async () => {
    const f = await settingsFixture(theme), problems = [], visited = [];
    try {
      for (const name of PAGES) {
        await visit(f.page, name);
        problems.push(...(await scanDisclosures(f.page)).map(hit => `${name}: ${hit}`)); visited.push(name);
      }
      await leaveSettings(f.page);
      await f.open('chat-a');
      problems.push(...(await scanDisclosures(f.page)).map(hit => `Chat: ${hit}`)); visited.push('Chat');
      for (const name of ['Lab', 'Workflows', 'Love Spot', 'Customize']) {
        await f.page.getByRole('button', { name, exact: true }).first().click();
        await f.page.waitForTimeout(150);
        problems.push(...(await scanDisclosures(f.page)).map(hit => `${name}: ${hit}`)); visited.push(name);
      }
      if (evidence) { await fs.mkdir(evidence, { recursive: true }); await fs.writeFile(path.join(evidence, `${theme}-markers.json`), JSON.stringify({ visited, problems }, null, 2)); }
      assert.deepEqual(problems, []);
    } finally { await f.close(); }
  });

  test(`POLISH R31: model labels, hints and fields share Settings spacing (${theme})`, async () => {
    const f = await settingsFixture(theme), measurements = [];
    try {
      for (const name of ['Models & accounts', 'Configuration', 'Personalization']) {
        await visit(f.page, name);
        const closed = f.page.locator('details:not([open]) > summary').filter({ hasText: 'Advanced: custom model', visible: true });
        while (await closed.count()) await closed.first().click();
        measurements.push(...await f.page.evaluate(modelSpacing));
        if (evidence) await shot(f.page.locator('.settings-page'), path.join(evidence, 'shots'), `${theme}-${name.replace(/\W+/g, '-').toLowerCase()}`);
      }
      assert.ok(measurements.length >= 2, 'main and background model fields are exercised (the memory models show once Memories is on)');
      const cramped = measurements.flatMap(m => ['selectToLabel', 'labelToHint', 'hintToField'].filter(key => m[key] !== null && m[key] + .5 < m.rowGap).map(key => `${m.label}: ${key} ${m[key]}px < Settings ${m.rowGap}px`));
      if (evidence) await fs.writeFile(path.join(evidence, `${theme}-spacing.json`), JSON.stringify(measurements, null, 2));
      assert.deepEqual(cramped, []);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`POLISH R32: actual corner strokes match card borders in idle, focused and running states (${theme})`, async () => {
    const f = await fixture({ width: 1600, height: 1000, colorScheme: theme, storage: { 'elpis-theme': theme } });
    const measurements = [], problems = [];
    try {
      await f.page.locator('.startup-splash').waitFor({ state: 'detached' }); // The start-up screen holds a moment; measure the card, not it.
      const cdp = await f.page.context().newCDPSession(f.page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 4, mobile: false });
      await f.composer.evaluate(el => el.blur());
      for (const state of ['idle', 'focused', 'running']) {
        if (state === 'focused') await f.composer.focus();
        if (state === 'running') { await f.open('chat-a'); f.emit('message', { method: 'turn/started', params: { threadId: 'chat-a', turn: { id: 'polish-running' } } }); await f.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor(); }
        for (const selector of ['.composer-tray', '.composer']) {
          const card = f.page.locator(selector).filter({ visible: true }); if (!await card.count()) continue;
          const measured = await cornerWidths(card); measurements.push({ state, selector, ...measured });
          try { checkWidths(measured, `${theme} ${state} ${selector}`); } catch (error) { problems.push(error.message); }
          if (evidence) await shot(card, path.join(evidence, 'shots'), `${theme}-${state}-${selector.slice(1)}`);
        }
      }
      if (evidence) { await fs.mkdir(evidence, { recursive: true }); await fs.writeFile(path.join(evidence, `${theme}-corners.json`), JSON.stringify(measurements, null, 2)); }
      assert.deepEqual(problems, []);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`POLISH R32: shared cut cards, fields and the isometric HUD keep their own border widths (${theme})`, async () => {
    const f = await settingsFixture(theme), measurements = [], problems = [];
    try {
      const cdp = await f.page.context().newCDPSession(f.page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 4, mobile: false });
      for (const [name, selectors] of [
        ['Models & accounts', ['.settings-card']],
        ['Configuration', ['.settings-rows', '[data-slot="select-trigger"]']],
        ['Personalization', ['textarea']],
      ]) {
        await visit(f.page, name);
        const closed = f.page.locator('details:not([open]) > summary').filter({ hasText: 'Advanced: custom model', visible: true });
        while (await closed.count()) await closed.first().click();
        for (const selector of selectors) {
          const card = f.page.locator(`.settings-page ${selector}`).filter({ visible: true }).first();
          assert.ok(await card.count(), `${name} must exercise ${selector}`);
          const measured = await cornerWidths(card); measurements.push({ name, selector, ...measured });
          try { checkWidths(measured, `${theme} ${name} ${selector}`); } catch (error) { problems.push(error.message); }
        }
      }
      await leaveSettings(f.page);
      await f.page.getByRole('button', { name: 'Workflows', exact: true }).first().click();
      await f.page.getByRole('radio', { name: 'Isometric', exact: true }).click();
      const card = f.page.locator('.iso-status'); await card.waitFor();
      const measured = await cornerWidths(card); measurements.push({ name: 'Isometric status', ...measured });
      if (measured.cssWidth <= 0) problems.push('isometric cards must draw a real border rather than a wider clipped background');
      else try { checkWidths(measured, `${theme} isometric status`); } catch (error) { problems.push(error.message); }
      if (evidence) { await fs.writeFile(path.join(evidence, `${theme}-shared-corners.json`), JSON.stringify(measurements, null, 2)); await shot(card, path.join(evidence, 'shots'), `${theme}-isometric-status`); }
      assert.deepEqual(problems, []);
    } finally { await f.close(); }
  });
}
