const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

const thread = (id, name, active = false) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: active ? 'active' : 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const longName = 'Review the complete source evidence and prepare the final implementation report';
const threads = [thread('chat-a', 'Fix the parser'), thread('long-chat', longName), thread('workflow-root', 'Legal review'), thread('workflow-agent', 'Workflows · Evidence', true), thread('love-chat', 'Love Spot')];
const run = { id: 'legal-run', rootThreadId: 'workflow-root', name: 'Legal review', status: 'failed', tasks: [{ id: 'evidence', title: 'Evidence', assignedThreadId: 'workflow-agent', status: 'running' }] };
const row = (page, id) => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`);
async function choose(page, id, colour, waitForSave = true) {
  await row(page, id).locator('.thread-link').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Colour', exact: true }).hover();
  await page.getByRole(colour === 'Reset colour' ? 'menuitem' : 'menuitemradio', { name: colour, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Colour', exact: true }).waitFor({ state: 'hidden' });
  if (waitForSave) await page.waitForFunction(({ id, colour }) => document.querySelector(`aside.sidebar .thread-row[data-thread-id="${id}"]`)?.getAttribute('data-conversation-colour') === colour, { id, colour: colour === 'Reset colour' ? null : colour.toLowerCase() });
}
async function open(colorScheme = 'light', sidebarWidth = 256) {
  return fixture({ staticDir: process.env.ELPIS_GEOMETRY_STATIC_DIR, width: sidebarWidth === 200 ? 820 : 1280, height: 900, colorScheme, threads,
    storage: { 'elpis-sidebar-width': String(sidebarWidth), 'elpis-sidebar-folds-v1': JSON.stringify({ sections: { workflows: false, love: false }, projects: {} }) },
    routes: { '/api/workflows/history': () => ({ data: [run] }) } });
}
async function expand(page) {
  await row(page, 'workflow-root').getByRole('button', { name: 'Expand agents in Legal review', exact: true }).click();
  await row(page, 'workflow-agent').waitFor();
}

function near(actual, expected, label) {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) <= 1, `${label}: ${key} moved from ${expected[key]} to ${actual[key]}`);
}
async function unfocus(f) { await f.composer.focus(); await f.page.mouse.move(700, 70); }

for (const colorScheme of ['light', 'dark']) for (const sidebarWidth of [256, 200]) test(`right-click colours tint and persist across conversation rows without moving their actions (${colorScheme}, ${sidebarWidth}px)`, async () => {
  const f = await open(colorScheme, sidebarWidth), { page } = f;
  const choices = [['chat-a', 'Fix the parser', 'Blue'], ['workflow-root', 'Legal review', 'Rose'], ['workflow-agent', 'Evidence', 'Green'], ['love-chat', 'Love Spot', 'Violet']];
  try {
    await f.open('chat-a'); await expand(page);
    const agentMark = await row(page, 'workflow-agent').getByRole('img', { name: /^Agent mark / }).getAttribute('aria-label');
    assert.match(await row(page, 'workflow-agent').innerText(), /openai · sol/);
    for (const [id, name, colour] of choices) {
      const target = row(page, id), menu = target.locator('.thread-actions'), link = target.locator('.thread-link');
      await target.scrollIntoViewIfNeeded(); await unfocus(f);
      const before = { menu: await menu.boundingBox(), link: await link.boundingBox(), status: await target.locator('.conversation-state-slot').boundingBox(), background: await target.evaluate(element => getComputedStyle(element).backgroundColor) };
      await target.hover(); near(await menu.boundingBox(), before.menu, `${name}: hover menu`); near(await link.boundingBox(), before.link, `${name}: hover title`);
      await menu.focus(); await page.mouse.move(700, 70); near(await menu.boundingBox(), before.menu, `${name}: focused menu`);
      await menu.press('Enter'); await page.getByRole('menuitem', { name: 'Colour', exact: true }).waitFor();
      near(await menu.boundingBox(), before.menu, `${name}: open menu`);
      await page.keyboard.press('Escape');
      assert.equal(await target.getByRole('button', { name: /^Colour for / }).count(), 0, 'colour has no dedicated row icon');
      assert.equal(await target.getByRole('button', { name: /^(?:Pin |Bookmark |Archive )/ }).count(), 0, 'organization actions stay in the shared menu');
      await choose(page, id, colour); await unfocus(f);
      assert.equal(await target.getAttribute('data-conversation-colour'), colour.toLowerCase());
      assert.notEqual(await target.evaluate(element => getComputedStyle(element).backgroundColor), before.background, 'the chosen colour tints the actual row');
      near(await target.locator('.conversation-state-slot').boundingBox(), before.status, `${name}: unchanged automatic status`);
      assert.equal(await f.shown(), 'chat-a', 'assigning colour must not select the target conversation');
    }
    assert.equal(await row(page, 'workflow-agent').getByRole('img', { name: /^Agent mark / }).getAttribute('aria-label'), agentMark);
    assert.equal(await row(page, 'workflow-root').locator('.thread-dot[data-state="error"]').count(), 1, 'failure status stays separate from manual colour');
    const long = row(page, 'long-chat'); await unfocus(f);
    const title = await long.locator('.thread-title').evaluate(element => ({ width: element.clientWidth, overflow: getComputedStyle(element).textOverflow, clipped: element.scrollWidth > element.clientWidth }));
    assert.ok(title.width >= 60, 'a narrow idle row keeps usable title width'); assert.equal(title.overflow, 'ellipsis'); assert.equal(title.clipped, true);
    await row(page, 'chat-a').locator('.thread-actions').focus(); await page.keyboard.press('Enter');
    for (const name of ['Pin', 'Bookmark', 'Archive']) await page.getByRole('menuitem', { name, exact: true }).waitFor();
    await page.getByRole('menuitem', { name: 'Colour', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    await page.getByRole('menuitemradio', { name: 'Blue', exact: true }).waitFor();
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    if (process.env.ELPIS_PARITY_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_PARITY_SHOTS}/conversation-colours-${colorScheme}.png` });
    await page.reload(); await row(page, 'chat-a').waitFor(); await expand(page);
    for (const [id, , colour] of choices) assert.equal(await row(page, id).getAttribute('data-conversation-colour'), colour.toLowerCase(), 'colour persists after reload');
    await choose(page, 'workflow-root', 'Reset colour');
    assert.equal(await row(page, 'workflow-root').getAttribute('data-conversation-colour'), null);
    assert.equal(await row(page, 'workflow-agent').getAttribute('data-conversation-colour'), 'green', 'reset changes only its own conversation');
    await row(page, 'workflow-agent').locator('.thread-link').click();
    assert.equal(await f.shown(), 'workflow-agent', 'ordinary chat opening still works');
    assert.equal(f.posts.some(post => /\/(?:name|turns|interrupt)$/.test(post.path)), false, 'colours never rename, send to or stop an agent');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a failed right-click colour save reports the error and preserves the prior row colour', async () => {
  const f = await open(), { page } = f;
  try {
    await f.open('chat-a');
    await page.evaluate(() => { window.elpisDesktop.storage.saveItem = async () => { throw Error('Disk unavailable'); }; });
    await choose(page, 'chat-a', 'Blue', false);
    await page.getByRole('alert').filter({ hasText: 'Could not save conversation colour' }).first().waitFor();
    assert.equal(await row(page, 'chat-a').getAttribute('data-conversation-colour'), null);
    assert.equal(await f.shown(), 'chat-a');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
