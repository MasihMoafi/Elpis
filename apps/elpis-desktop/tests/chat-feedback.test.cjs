// Exercise the renderer with delayed bridge acknowledgements; no model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const gate = () => { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; };
const bubble = (page, text) => page.locator('.message.user').filter({ hasText: text });
const echo = (f, text) => f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 't-new', item: { id: 'u-new', type: 'userMessage', content: [{ type: 'text', text }] } } });

for (const earlyEcho of [false, true]) test(`Enter shows the prompt while its request is held; one copy after acknowledgement (echo first: ${earlyEcho})`, async () => {
  const held = gate();
  const f = await fixture({ routes: { '/api/threads/chat-a/turns': async () => { await held.wait; return { turn: { id: 't-new' } }; } } });
  try {
    await f.open('chat-a'); await f.composer.fill('Immediate visible prompt'); await f.composer.press('Enter');
    await bubble(f.page, 'Immediate visible prompt').waitFor({ timeout: 1500 });
    assert.equal(await f.composer.inputValue(), '');
    assert.equal(f.posts.filter(post => post.path.endsWith('/turns')).length, 1);
    const original = await bubble(f.page, 'Immediate visible prompt').elementHandle();
    if (earlyEcho) echo(f, 'Immediate visible prompt');
    held.release();
    await f.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    if (!earlyEcho) echo(f, 'Immediate visible prompt');
    await f.page.waitForTimeout(200);
    assert.equal(await bubble(f.page, 'Immediate visible prompt').count(), 1);
    assert.equal(await original.evaluate(element => element.isConnected), true, 'the visible bubble survives the recorded echo');
    assert.deepEqual(f.errors, []);
  } finally { held.release(); await f.close(); }
});

test('a refused send restores its text and file, and Enter can retry it', async () => {
  let refuse = true;
  const f = await fixture({ routes: { '/api/threads/chat-a/turns': () => refuse ? { __http: 503, error: 'The model is unavailable.' } : { turn: { id: 't-new' } } } });
  try {
    await f.open('chat-a');
    await f.page.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('some notes') });
    await f.page.locator('.composer').getByText('notes.txt').waitFor();
    await f.composer.fill('Read these notes'); await f.composer.press('Enter');
    await f.page.getByText('The model is unavailable.', { exact: true }).waitFor();
    assert.equal(await f.composer.inputValue(), 'Read these notes');
    assert.equal(await f.page.locator('.composer').getByText('notes.txt').count(), 1);
    assert.equal(await bubble(f.page, 'Read these notes').count(), 0);
    refuse = false; await f.composer.press('Enter');
    await bubble(f.page, 'Read these notes').waitFor();
    const calls = f.posts.filter(post => post.path.endsWith('/turns'));
    assert.equal(calls.length, 2); assert.equal(calls[1].body.attachments[0].name, 'notes.txt');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Stop response names itself and interrupts; queued follow-ups stay in their tray', async () => {
  const f = await fixture({ running: true });
  try {
    await f.open('chat-a');
    const stop = f.page.getByRole('button', { name: 'Stop response', exact: true });
    assert.equal(await stop.innerText(), 'Stop response');
    await f.composer.fill('Do this later'); await f.composer.press('Control+Enter');
    await f.page.getByRole('list', { name: 'Queued follow-ups', exact: true }).getByText('Do this later', { exact: true }).waitFor();
    assert.equal(await bubble(f.page, 'Do this later').count(), 0);
    await stop.click(); assert.equal(f.posts.filter(post => post.path.endsWith('/interrupt')).length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('message actions have room above the next Thought or prompt row', async () => {
  const f = await fixture();
  try {
    await f.open('chat-a');
    const gaps = await f.page.evaluate(() => [...document.querySelectorAll('.turn .user-turn')].map(turn => {
      const actions = turn.querySelector('.message-actions').getBoundingClientRect(), next = turn.nextElementSibling?.getBoundingClientRect() ?? turn.parentElement.nextElementSibling?.getBoundingClientRect();
      return next ? next.top - actions.bottom : 99;
    }));
    assert.ok(gaps.length > 0 && gaps.every(gap => gap >= 8), `gaps under actions: ${gaps}`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
