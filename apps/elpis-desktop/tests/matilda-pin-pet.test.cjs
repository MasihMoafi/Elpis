// Pinned Matilda works like a pinned pet (1 Nov, Masih: "Matilda is disabled from our pin, it shouldn't be … it shouldn't
// show previous messages in the pop-up version; unless we want to click on an icon which is designated for this"; later:
// "disabling it shouldn't disrupt me from using the pinned version").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { FACE_DATA_URL } = require('../bridge/matilda-face.cts');

test('her pinned chat works while she is off on the board; her pop-up hides earlier messages until its history icon is pressed', { timeout: 60000 }, async t => {
  let pinned = false, settings = { replies: false, model: null, provider: null };
  const old = { turnId: 'old', item: { id: 'old-q', type: 'userMessage', content: [{ type: 'text', text: 'An old question' }] } };
  const oldReply = { turnId: 'old', item: { id: 'old-a', type: 'agentMessage', text: 'An old answer.' } };
  let entries = [old, oldReply];
  const f = await fixture({ width: 1000, height: 800, routes: {
    '/api/love-spot/companion': body => {
      if (body?.action === 'pin') pinned = true;
      if (body?.action === 'unpin') pinned = false;
      return { pinned, face: FACE_DATA_URL, threadId: 'chat-a', favorite: null, music: null, reason: '' };
    },
    '/api/love-spot/matilda': body => { if (body) settings = { ...settings, ...body }; return body ? { matilda: settings } : settings; },
    '/api/love-spot/talk': body => {
      if (body) entries = [...entries, { turnId: 'new', item: { id: 'new-q', type: 'userMessage', content: [{ type: 'text', text: body.text }] } }, { turnId: 'new', item: { id: 'new-a', type: 'agentMessage', text: 'Here now.' } }];
      return { entries, busy: false };
    },
  } });
  t.after(() => f.close());
  await f.open('chat-a');
  const page = f.page;
  await page.getByRole('button', { name: 'Pin Matilda', exact: true }).click();
  const presence = page.getByRole('region', { name: 'Pinned Matilda', exact: true }); await presence.waitFor();
  assert.equal(settings.replies, false, 'pinning leaves her board on/off alone');

  await presence.getByRole('button', { name: 'Chat with Matilda', exact: true }).click();
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true }); await mini.waitFor();
  const field = mini.getByRole('textbox', { name: 'Message Matilda', exact: true });
  assert.equal(await field.isEnabled(), true, 'her message field works once pinned');
  const history = mini.getByRole('button', { name: 'Show earlier messages', exact: true });
  await history.waitFor();
  assert.equal(await mini.getByText('An old question', { exact: true }).count(), 0, 'no earlier messages in the pop-up');
  await field.fill('Hello'); await mini.getByRole('button', { name: 'Send to Matilda', exact: true }).click();
  await mini.getByText('Here now.', { exact: true }).waitFor();
  assert.equal(f.posts.filter(post => post.path === '/api/love-spot/talk').at(-1).body.pinned, true, 'sent as her pinned chat, which works while she is off');
  assert.equal(await mini.getByText('An old answer.', { exact: true }).count(), 0, 'what is said now shows; earlier stays hidden');
  await history.click();
  await mini.getByText('An old question', { exact: true }).waitFor();
  assert.equal(await mini.getByRole('button', { name: 'Hide earlier messages', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape'); await mini.waitFor({ state: 'hidden' });
  await presence.getByRole('button', { name: 'Chat with Matilda', exact: true }).click(); await mini.waitFor();
  assert.equal(await mini.getByText('An old question', { exact: true }).count(), 0, 'reopening starts without earlier messages again');
  await page.keyboard.press('Escape'); await mini.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Unpin Matilda', exact: true }).click();
  await page.getByRole('button', { name: 'Pin Matilda', exact: true }).waitFor();
  assert.deepEqual(f.errors, []);
});
