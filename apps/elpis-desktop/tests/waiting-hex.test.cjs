const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

for (const colorScheme of ['light', 'dark']) {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    test(`waiting hexagon: ${colorScheme}, ${reducedMotion}`, async () => {
      const f = await fixture({ colorScheme, ...(process.env.ELPIS_HEX_STATIC_DIR ? { staticDir: process.env.ELPIS_HEX_STATIC_DIR } : {}) });
      try {
        const { page } = f;
        await page.emulateMedia({ reducedMotion });
        await f.open('chat-a');
        assert.ok(f.listening() > 0);
        f.emit('message', { method: 'turn/started', params: { threadId: 'chat-a', turn: { id: 'hex-eval', status: 'inProgress', items: [] } } });
        const mark = page.locator('.turn-working .elpis-working-mark').last();
        await mark.waitFor();
        const state = await mark.evaluate(el => {
          const rotor = el.querySelector('.elpis-working-rotor');
          const dot = el.querySelector('.elpis-working-dot');
          const box = el.getBoundingClientRect();
          return { width: box.width, height: box.height, fill: getComputedStyle(el.querySelector('path')).fill, dot: !!dot, rotation: getComputedStyle(rotor).animationDuration, blink: dot && getComputedStyle(dot).animationDuration };
        });
        assert.equal(state.width, 18);
        assert.equal(state.height, 18);
        assert.equal(state.fill, 'none');
        assert.equal(state.dot, true);
        assert.equal(state.rotation, '4s');
        assert.equal(state.blink, '2s');
        const motion = await mark.evaluate(el => {
          const rotor = el.querySelector('.elpis-working-rotor'), dot = el.querySelector('.elpis-working-dot');
          const animations = el.getAnimations({ subtree: true });
          for (const a of animations) { a.pause(); a.currentTime = 0; }
          const first = { rotation: getComputedStyle(rotor).transform, opacity: Number(getComputedStyle(dot).opacity) };
          for (const a of animations) a.currentTime = 1000;
          return { first, second: { rotation: getComputedStyle(rotor).transform, opacity: Number(getComputedStyle(dot).opacity) } };
        });
        assert.notEqual(motion.first.rotation, motion.second.rotation);
        assert.ok(motion.first.opacity > .95 && motion.second.opacity < .2, JSON.stringify(motion));
        const dir = path.resolve(__dirname, '../../../.tmp/waiting-hex');
        await fs.mkdir(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, `${colorScheme}-${reducedMotion}.png`) });
        f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-a', turn: { id: 'hex-eval', status: 'completed', items: [] } } });
        await mark.waitFor({ state: 'detached' });
        await f.composer.fill('Ordinary composer still works');
        assert.equal(await f.composer.inputValue(), 'Ordinary composer still works');
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    });
  }
}
