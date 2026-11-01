// Pinned Matilda works like a pinned pet (1 Nov, Masih: "Matilda is disabled from our pin, it shouldn't be … it shouldn't
// show previous messages in the pop-up version; unless we want to click on an icon which is designated for this").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { FACE_DATA_URL } = require('../bridge/matilda-face.cjs');

test('pinning turns an off Matilda on; her pop-up hides earlier messages until its history icon is pressed', { timeout: 60000 }, async t => {
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
  for (let i = 0; i < 50 && settings.replies !== true; i++) await page.waitForTimeout(100);
  assert.equal(settings.replies, true, 'pinning her turns her on');

  await presence.getByRole('button', { name: 'Chat with Matilda', exact: true }).click();
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true }); await mini.waitFor();
  const field = mini.getByRole('textbox', { name: 'Message Matilda', exact: true });
  assert.equal(await field.isEnabled(), true, 'her message field works once pinned');
  const history = mini.getByRole('button', { name: 'Show earlier messages', exact: true });
  await history.waitFor();
  assert.equal(await mini.getByText('An old question', { exact: true }).count(), 0, 'no earlier messages in the pop-up');
  await field.fill('Hello'); await mini.getByRole('button', { name: 'Send to Matilda', exact: true }).click();
  await mini.getByText('Here now.', { exact: true }).waitFor();
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

test('an off Matilda\'s pop-up offers to turn her on', { timeout: 60000 }, async t => {
  let settings = { replies: false, model: null, provider: null };
  const f = await fixture({ width: 1000, height: 800, routes: {
    '/api/love-spot/companion': () => ({ pinned: true, face: FACE_DATA_URL, threadId: 'chat-a', favorite: null, music: null, reason: '' }),
    '/api/love-spot/matilda': body => { if (body) settings = { ...settings, ...body }; return body ? { matilda: settings } : settings; },
    '/api/love-spot/talk': () => ({ entries: [], busy: false }),
  } });
  t.after(() => f.close());
  await f.open('chat-a');
  const page = f.page;
  await page.getByRole('button', { name: 'Chat with Matilda', exact: true }).click();
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true }); await mini.waitFor();
  assert.equal(await mini.getByRole('button', { name: 'Show earlier messages', exact: true }).count(), 0, 'no history icon when there is nothing earlier');
  await mini.getByRole('button', { name: 'Turn Matilda on', exact: true }).click();
  await mini.getByRole('textbox', { name: 'Message Matilda', exact: true }).and(page.locator(':enabled')).waitFor();
  assert.equal(settings.replies, true);
  assert.equal(await mini.getByRole('button', { name: 'Turn Matilda on', exact: true }).count(), 0);
  assert.deepEqual(f.errors, []);
});
