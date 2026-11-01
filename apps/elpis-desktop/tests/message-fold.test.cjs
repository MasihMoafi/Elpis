// A long message of his folds to its first lines with a chevron in the message; a short one has no chevron (27 Oct:
// "when a message is too long there should be an option to collapse it").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long pasted brief.`).join('\n');
const user = (turnId, id, text) => ({ turnId, item: { id, type: 'userMessage', content: [{ type: 'text', text }] } });
const reply = (turnId, text) => ({ turnId, item: { id: `reply-${turnId}`, type: 'agentMessage', text } });
const thread = { id: 'chat-a', name: 'Long brief', cwd: CWD, model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };

test('a long message folds and opens with its chevron; a short one does not fold', async t => {
  const history = [user('short', 'short-user', 'A short question'), reply('short', 'A short answer'), user('long', 'long-user', LONG), reply('long', 'Read it.')];
  const f = await fixture({ chat: [['short', 'A short question', 'A short answer']], height: 900, routes: {
    '/api/threads/chat-a/resume': () => ({ thread, activeTurnId: null }),
    '/api/threads/chat-a': () => ({ thread, data: [...history].reverse(), nextCursor: null }),
  } });
  t.after(() => f.close());
  await f.open('chat-a');
  const { page } = f;
  const long = page.locator('.message.user').filter({ hasText: 'Line 1 of a long' }), short = page.locator('.message.user').filter({ hasText: 'A short question' });
  const fold = long.getByRole('button', { name: 'Show the whole message', exact: true });
  await fold.waitFor();
  assert.equal(await short.getByRole('button', { name: /whole message|Collapse message/ }).count(), 0, 'a short message has no chevron');
  const body = long.locator('.message-body');
  const folded = (await body.boundingBox()).height;
  assert.ok(folded <= 290, `folded to about twelve lines, was ${folded}px`);
  await fold.click();
  const opened = (await body.boundingBox()).height;
  assert.ok(opened > folded + 200, `opens to the whole message: ${folded} → ${opened}`);
  await long.getByRole('button', { name: 'Collapse message', exact: true }).click();
  assert.ok((await body.boundingBox()).height <= 290, 'folds again');
  assert.deepEqual(f.errors, []);
});
