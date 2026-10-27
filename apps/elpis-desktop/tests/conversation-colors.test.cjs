const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

const thread = (id, name, active = false) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: active ? 'active' : 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const threads = [thread('chat-a', 'Fix the parser'), thread('workflow-root', 'Legal review'), thread('workflow-agent', 'Workflows · Evidence', true), thread('love-chat', 'Love Spot')];
const run = { id: 'legal-run', rootThreadId: 'workflow-root', name: 'Legal review', status: 'failed', tasks: [{ id: 'evidence', title: 'Evidence', assignedThreadId: 'workflow-agent', status: 'running' }] };
const row = (page, id) => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`);
const popup = page => page.getByRole('dialog', { name: 'Conversation colour', exact: true });
async function open(colorScheme = 'light') {
  return fixture({ width: 1280, height: 900, colorScheme, threads,
    storage: { 'elpis-sidebar-folds-v1': JSON.stringify({ sections: { workflows: false, love: false }, projects: {} }) },
    routes: { '/api/workflows/history': () => ({ data: [run] }) } });
}
async function expand(page) {
  await row(page, 'workflow-root').getByRole('button', { name: 'Expand agents in Legal review', exact: true }).click();
  await row(page, 'workflow-agent').waitFor();
}

for (const colorScheme of ['light', 'dark']) test(`conversation colours apply to ordinary, agent, workflow and Love Spot rows without opening them (${colorScheme})`, async () => {
  const f = await open(colorScheme), { page } = f;
  const choices = [['chat-a', 'Fix the parser', 'Blue'], ['workflow-root', 'Legal review', 'Rose'], ['workflow-agent', 'Evidence', 'Green'], ['love-chat', 'Love Spot', 'Violet']];
  try {
    await f.open('chat-a'); await expand(page);
    const agentMark = await row(page, 'workflow-agent').getByRole('img', { name: /^Agent mark / }).getAttribute('aria-label');
    assert.match(await row(page, 'workflow-agent').innerText(), /openai · sol/);
    for (const [id, name, colour] of choices) {
      const trigger = row(page, id).getByRole('button', { name: `Colour for ${name}`, exact: true });
      const [dot, link] = await Promise.all([trigger.boundingBox(), row(page, id).locator('.thread-link').boundingBox()]);
      assert.ok(dot.x + dot.width <= link.x + 1, `${name}: colour action is left of the conversation`);
      await trigger.focus(); await trigger.press('Enter');
      await popup(page).getByRole('radio', { name: colour, exact: true }).click();
      await popup(page).waitFor({ state: 'hidden' });
      assert.equal(await trigger.getAttribute('title'), `Conversation colour: ${colour.toLowerCase()}`);
      assert.equal(await f.shown(), 'chat-a', 'assigning colour must not select the target conversation');
    }
    assert.equal(await row(page, 'workflow-agent').getByRole('img', { name: /^Agent mark / }).getAttribute('aria-label'), agentMark);
    assert.equal(await row(page, 'workflow-root').locator('.thread-dot[data-state="error"]').count(), 1, 'failure status stays separate from manual colour');
    assert.equal(await row(page, 'chat-a').locator('.thread-dot[data-state="idle"]').count(), 0, 'idle has no redundant status dot');
    const trigger = row(page, 'workflow-root').getByRole('button', { name: 'Colour for Legal review', exact: true });
    await trigger.click();
    if (process.env.ELPIS_PARITY_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_PARITY_SHOTS}/conversation-colours-${colorScheme}.png` });
    await popup(page).press('Escape');
    await popup(page).waitFor({ state: 'hidden' });
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'Escape restores trigger focus');
    await trigger.click(); await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).click();
    await popup(page).waitFor({ state: 'hidden' });
    await page.reload(); await row(page, 'chat-a').waitFor(); await expand(page);
    for (const [id, name, colour] of choices) assert.equal(await row(page, id).getByRole('button', { name: `Colour for ${name}`, exact: true }).getAttribute('title'), `Conversation colour: ${colour.toLowerCase()}`, 'colour persists after reload');
    await trigger.click(); await popup(page).getByRole('button', { name: 'Reset colour', exact: true }).click();
    await popup(page).waitFor({ state: 'hidden' });
    assert.equal(await trigger.getAttribute('title'), 'Choose conversation colour');
    assert.equal(await row(page, 'workflow-agent').getByRole('button', { name: 'Colour for Evidence', exact: true }).getAttribute('title'), 'Conversation colour: green', 'reset changes only its own conversation');
    await row(page, 'workflow-agent').locator('.thread-link').click();
    assert.equal(await f.shown(), 'workflow-agent', 'ordinary chat opening still works');
    assert.equal(f.posts.some(post => /\/(?:name|turns|interrupt)$/.test(post.path)), false, 'colours never rename, send to or stop an agent');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a failed conversation colour save stays beside the picker and keeps the prior colour', async () => {
  const f = await open(), { page } = f;
  try {
    await f.open('chat-a');
    await page.evaluate(() => { window.elpisDesktop.storage.saveItem = async () => { throw Error('Disk unavailable'); }; });
    const trigger = row(page, 'chat-a').getByRole('button', { name: 'Colour for Fix the parser', exact: true });
    await trigger.click(); await popup(page).getByRole('radio', { name: 'Blue', exact: true }).click();
    await popup(page).getByRole('alert').filter({ hasText: 'Could not save conversation colour' }).waitFor();
    assert.equal(await trigger.getAttribute('title'), 'Choose conversation colour');
    assert.equal(await f.shown(), 'chat-a');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
