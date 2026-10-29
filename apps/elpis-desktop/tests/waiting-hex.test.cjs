const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

for (const colorScheme of ['light', 'dark']) {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    test(`waiting gauge: ${colorScheme}, ${reducedMotion}`, async () => {
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
          const rotor = el.querySelector('.elpis-working-rotor'), box = el.getBoundingClientRect();
          return { width: box.width, height: box.height, segments: rotor.querySelectorAll('path').length, core: !!el.querySelector('.elpis-working-core'), rotation: getComputedStyle(rotor).animationDuration, name: getComputedStyle(rotor).animationName };
        });
        assert.equal(state.width, 18);
        assert.equal(state.height, 18);
        assert.equal(state.segments, 6, "the collection gauge's six ring segments");
        assert.equal(state.core, true);
        assert.equal(state.name, reducedMotion === 'reduce' ? 'none' : 'elpis-orbit');
        if (reducedMotion !== 'reduce') assert.equal(state.rotation, '8s');
        if (reducedMotion !== 'reduce') {
          const motion = await mark.evaluate(el => {
            const rotor = el.querySelector('.elpis-working-rotor'), animations = el.getAnimations({ subtree: true });
            for (const a of animations) { a.pause(); a.currentTime = 0; }
            const first = getComputedStyle(rotor).transform;
            for (const a of animations) a.currentTime = 1000;
            return { first, second: getComputedStyle(rotor).transform };
          });
          assert.notEqual(motion.first, motion.second);
        }
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
