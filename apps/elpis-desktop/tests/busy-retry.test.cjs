// S17: the bridge refuses a second action on one chat while another runs (before doing anything); a send that meets it waits and asks again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
async function eventually(check) {
  const end = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 30)); } }
}
const busy = { __http: 409, error: 'Another operation on this conversation is pending' };

test('a message sent while the chat is busy goes through once the other action ends, with no error shown', async () => {
  let asked = 0;
  const f = await fixture({ routes: { '/api/threads/chat-a/turns': () => ++asked <= 2 ? busy : { turn: { id: 't-new' } } } });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await f.composer.fill('Make the heading bigger'); await f.composer.press('Enter');
    await eventually(() => assert.equal(asked, 3, 'asked again after each refusal, and no more once it went through'));
    await f.page.getByText('Make the heading bigger', { exact: true }).first().waitFor();
    assert.equal(await f.page.getByText(/Another operation on this conversation/).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a chat that stays busy shows the refusal after a few tries, and the message is kept', async () => {
  let asked = 0;
  const f = await fixture({ routes: { '/api/threads/chat-a/turns': () => (++asked, busy) } });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await f.composer.fill('Make the heading bigger'); await f.composer.press('Enter');
    await f.page.getByText(/Another operation on this conversation is pending/).first().waitFor();
    assert.equal(asked, 6, 'one try and five more, then the refusal');
    assert.equal(await f.composer.inputValue(), 'Make the heading bigger', 'the message is kept to send again');
  } finally { await f.close(); }
});
