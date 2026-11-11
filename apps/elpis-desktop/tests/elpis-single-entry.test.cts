// SPEC item 87: Elpis has one entry in the sidebar, the navigation's; the router's chat is never a second row among the chats.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');

const chat = (id: string, name: string, extra: object = {}) => ({
  id, name, preview: name, cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' },
  desktopAccess: { writable: true, mode: 'direct' }, ...extra,
});

test('the router chat opens from the Elpis entry and is not a row among the chats', async () => {
  const f = await fixture({
    threads: [chat('elpis', 'Elpis', { motherAgent: true }), chat('chat-a', 'Fix the parser')], readyThreadId: 'chat-a',
  });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const rows = page.locator('aside.sidebar .thread-row');
    await rows.filter({ hasText: 'Fix the parser' }).waitFor();
    assert.equal(await rows.filter({ hasText: /^Elpis$/ }).count(), 0, 'no Elpis row among the chats');
    assert.equal(await page.locator('aside.sidebar nav[aria-label="Workspace"]').getByRole('button', { name: 'Elpis', exact: true }).count(), 1);
    await page.locator('aside.sidebar nav[aria-label="Workspace"]').getByRole('button', { name: 'Elpis', exact: true }).click();
    await page.getByRole('tab', { name: 'Elpis', exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

// 11 Nov, Masih: "the elpis chat should have a different more attractive look I think so it's different from the rest".
// The Elpis chat is the assistant's own place: a band says what his chats are doing, the page carries a wash of the
// accent, and the message box invites what Elpis is for. An ordinary chat has none of it.
test('the Elpis chat has its own look: a band on what his chats are doing and its own invitation to write', async () => {
  const f = await fixture({
    threads: [
      chat('elpis', 'Elpis', { motherAgent: true }),
      chat('chat-a', 'Fix the parser', { status: { type: 'active', activeFlags: [] } }),
      chat('chat-b', 'Deploy site', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } }),
      chat('chat-c', 'Old notes'),
    ],
    readyThreadId: 'chat-c',
  });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const band = page.getByRole('status', { name: 'Your chats', exact: true });
    await page.locator('aside.sidebar .thread-row').filter({ hasText: 'Old notes' }).click();
    await page.getByRole('tab', { name: 'Old notes', exact: true }).waitFor();
    assert.equal(await band.count(), 0, 'an ordinary chat has no band');
    assert.equal(await page.locator('main.workspace.elpis-chat').count(), 0);
    await page.locator('aside.sidebar nav[aria-label="Workspace"]').getByRole('button', { name: 'Elpis', exact: true }).click();
    await band.waitFor();
    assert.equal((await band.innerText()).replace(/\s+/g, ' ').trim(), 'Elpis 1 needs you · 1 working · 3 chats');
    await page.locator('main.workspace.elpis-chat').waitFor();
    assert.equal(await page.locator('main textarea').first().getAttribute('placeholder'), 'Ask Elpis about your chats, or hand it a job');
    const wash = await page.locator('main.workspace.elpis-chat .chat-view').evaluate((el: HTMLElement) => getComputedStyle(el).backgroundImage);
    assert.match(wash, /gradient/, 'the page carries a wash of the accent');
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/elpis-chat.png` });
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

// 11 Nov, Masih: "I tried to go back and it didn't work. This is exactly the kind of shadow or silent errors I've
// begged you to solve." Edit in the Elpis chat failed in the bridge. Now Edit sends the message again, and what the
// Elpis chat cannot do (rewind, delete from here, fork, a folder, permissions) is not offered there.
test('in the Elpis chat Edit sends the message again, and what cannot work there is not offered', async () => {
  const sent: { beforeTurnId: string; text: string }[] = [];
  const mine = { turnId: 'router-1', item: { id: 'm1', type: 'userMessage', content: [{ type: 'text', text: 'send it this', text_elements: [] }] }, startedAtMs: 1794009600000 };
  const reply = { turnId: 'router-2', item: { id: 'm2', type: 'agentMessage', text: 'I can only send text.', phase: 'final_answer' }, startedAtMs: 1794009601000 };
  const later = { turnId: 'router-3', item: { id: 'm3', type: 'userMessage', content: [{ type: 'text', text: 'thanks', text_elements: [] }] }, startedAtMs: 1794009602000 };
  const f = await fixture({
    threads: [chat('elpis', 'Elpis', { motherAgent: true }), chat('chat-a', 'Fix the parser')],
    readyThreadId: 'chat-a',
    routes: {
      // The desktop returns the newest first.
      '/api/threads/elpis': () => ({ thread: chat('elpis', 'Elpis', { motherAgent: true }), data: [later, reply, mine], nextCursor: null }),
      '/api/threads/elpis/revert': (body: { beforeTurnId: string; text: string }) => { sent.push(body); return { turn: { id: 'router-4' }, routed: true, kept: true }; },
    },
  });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.locator('aside.sidebar nav[aria-label="Workspace"]').getByRole('button', { name: 'Elpis', exact: true }).click();
    const first = page.locator('main .message.user').filter({ hasText: 'send it this' });
    await first.waitFor();
    await first.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await menu.getByRole('menuitem', { name: /^Edit/ }).waitFor();
    const offered = (await menu.getByRole('menuitem').allInnerTexts()).map((name: string) => name.replace(/\s+/g, ' ').trim());
    assert.ok(!offered.some((name: string) => /Rewind|Delete|Fork/.test(name)), `no rewind, delete or fork: ${offered.join(', ')}`);
    await menu.getByRole('menuitem', { name: /^Edit/ }).click();
    await page.getByText('Sending puts this to Elpis as a new message; the messages above stay.', { exact: true }).waitFor();
    const box = page.getByRole('textbox', { name: 'Edited message', exact: true });
    await box.fill('send the note chat this');
    await page.locator('main form').filter({ has: box }).getByRole('button', { name: 'Send', exact: true }).click();
    await box.waitFor({ state: 'detached' });
    assert.deepEqual(sent, [{ beforeTurnId: 'router-1', text: 'send the note chat this' }]);
    await page.locator('main .message.user').filter({ hasText: 'thanks' }).waitFor();
    await page.locator('main .message.agent').filter({ hasText: 'I can only send text.' }).waitFor();
    await page.locator('main .message.agent').filter({ hasText: 'I can only send text.' }).click({ button: 'right' });
    const replyMenu = (await page.getByRole('menu').getByRole('menuitem').allInnerTexts()).join(', ');
    assert.ok(!/Fork|Rewind/.test(replyMenu), `a reply offers no fork or rewind: ${replyMenu}`);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Change folder' }).count(), 0, 'no folder to change');
    assert.equal(await page.locator('main .composer').getByRole('button', { name: /access|approval/i }).count(), 0, 'no permission choice');
    assert.equal(await page.locator('main .composer').getByRole('button', { name: 'Fast mode', exact: true }).count(), 0, 'no Fast mode');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
