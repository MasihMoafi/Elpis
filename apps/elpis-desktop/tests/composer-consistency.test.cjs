const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

// The composer's toolbar is one layout whatever the chat, provider or neighbouring pane: the model button names the model
// only (the provider never rides inside it), the permission label is the full "Approve for me" until the workspace itself
// is narrow, the box's inset follows the workspace's width (not the window's), and nothing leaves the box.
const probe = page => page.evaluate(() => {
  const q = selector => document.querySelector(selector), box = element => element.getBoundingClientRect();
  const workspace = box(q('.workspace-body')), composer = box(q('.composer')), wrap = q('.composer-wrap');
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const controls = [...q('.composer-controls').querySelectorAll('button, select, [role="combobox"]')].filter(visible).map(box);
  return {
    shown: composer.width > 0 && composer.height > 0, workspace: Math.round(workspace.width), inset: getComputedStyle(wrap).paddingLeft,
    permission: q('.composer-pill .pill-long').offsetParent ? q('.composer-pill .pill-long').textContent : q('.composer-pill .pill-short').textContent,
    model: q('.model-picker-trigger').innerText, providerLabel: !!q('.composer .model-trigger-provider') && visible(q('.composer .model-trigger-provider')),
    leaks: controls.filter(rect => rect.left < composer.left - 0.5 || rect.right > composer.right + 0.5).length,
    page: document.documentElement.scrollWidth > innerWidth,
  };
});

for (const model of ['sol', 'claude/claude-sonnet-5-5']) for (const running of [false, true]) {
  test(`toolbar is stable across widths and a browser split (${model}, ${running ? 'running' : 'idle'})`, async t => {
    const provider = model.startsWith('claude/') ? 'claude' : 'openai';
    const chat = { id: 'chat-a', name: 'Fix the parser', preview: 'x', cwd: '/tmp/parity-fixture', model, modelProvider: provider, status: { type: running ? 'active' : 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
    const f = await fixture({ width: 1100, height: 700, colorScheme: 'dark', running, routes: {
      '/api/threads/chat-a/resume': () => ({ thread: chat, activeTurnId: running ? 't4' : null }),
      '/api/threads/chat-a/permissions': () => ({ permissions: 'auto' }),
    } });
    t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
    const { page } = f;
    await f.open('chat-a');
    await page.locator('.composer-pill').first().click(); await page.getByRole('menuitem', { name: /Approve for me/ }).click();
    await page.mouse.click(5, 5);
    for (const split of [false, true]) for (const width of [1100, 760, 500, 390]) {
      await page.setViewportSize({ width, height: 700 });
      if (split && width === 1100) { await page.keyboard.press('Control+`'); await page.getByRole('button', { name: 'New side panel tab' }).click(); await page.getByRole('menuitem', { name: 'Browser tab' }).click(); }
      await page.waitForTimeout(300);
      const m = await probe(page), where = `${split ? 'split' : 'solo'} ${width}px (workspace ${m.workspace}px)`;
      // On a narrow screen the browser replaces the chat pane; its hidden controls are not an on-screen toolbar.
      if (!m.shown) continue;
      assert.equal(m.providerLabel, false, `no provider label inside the model button, ${where}`);
      assert.ok(!/\|/.test(m.model) && !/OpenAI|Anthropic|Configured provider/.test(m.model), `model button names the model only: "${m.model}", ${where}`);
      assert.equal(m.permission, m.workspace > 560 ? 'Approve for me' : 'Auto', `permission label by workspace width, ${where}`);
      assert.equal(m.leaks, 0, `every toolbar control stays inside the box, ${where}`);
      assert.equal(m.page, false, `no horizontal page overflow, ${where}`);
      assert.equal(m.inset, m.workspace > 640 ? '32px' : m.workspace > 520 ? '22px' : '12px', `box inset by workspace width, ${where}`);
    }
  });
}
