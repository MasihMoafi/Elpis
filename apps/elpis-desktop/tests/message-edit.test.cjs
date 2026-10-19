// Sent-message pencil against the exported UI. Only the earlier page is missing;
// a visible previous-turn boundary proves that the selected later turn is complete.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

const PROMPT = 'Private pencil verdict 714\n\nمتن فارسی';
const user = (turnId, id, text) => ({ turnId, item: { id, type: 'userMessage', content: [{ type: 'text', text }] } });
const reply = (turnId, text) => ({ turnId, item: { id: `reply-${turnId}`, type: 'agentMessage', text } });
const thread = { id: 'chat-a', name: 'Fix the parser', cwd: CWD, model: 'claude-opus-5-5', modelProvider: 'anthropic-credits', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
const eventually = async check => {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 40)); } }
};
async function using(t, extra, run) {
  const history = [user('earlier', 'earlier-user', 'Earlier input'), reply('earlier', 'Earlier reply'), user('latest', 'latest-user', PROMPT)];
  let fail = true;
  const f = await fixture({
    ...(process.env.ELPIS_MESSAGE_EDIT_STATIC_DIR ? { staticDir: process.env.ELPIS_MESSAGE_EDIT_STATIC_DIR } : {}),
    chat: [['earlier', 'Earlier input', 'Earlier reply']], height: 900,
    routes: {
      '/api/threads/chat-a/resume': () => ({ thread, activeTurnId: null }),
      '/api/threads/chat-a': () => ({ thread, data: [...history].reverse(), nextCursor: 'older-page' }),
      '/api/threads/chat-a/revert': () => fail ? { __http: 503, error: 'Private replacement refused' } : { turn: { id: 'edited-turn' } },
      ...extra,
    },
  });
  t.after(() => f.close());
  await f.open('chat-a');
  await run(f, { history, allow: () => { fail = false; } });
  assert.deepEqual(f.errors, []);
}

test('a complete recent Claude turn edits with an older cursor; Cancel/Escape and failed Send preserve input', t => using(t, {}, async (f, control) => {
  const { page, composer } = f;
  const turn = page.locator('.user-turn').filter({ hasText: PROMPT });
  const edit = page.getByRole('textbox', { name: 'Edited message', exact: true });
  const form = page.getByRole('form', { name: 'Edit message', exact: true });
  const replacements = () => f.posts.filter(post => post.path.endsWith('/revert'));
  await composer.fill('Unrelated composer draft');
  await turn.getByRole('button', { name: 'Edit message', exact: true }).click();
  assert.equal(await edit.inputValue(), PROMPT);
  await edit.fill('Cancelled revision');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await composer.inputValue(), 'Unrelated composer draft');
  assert.equal(replacements().length, 0);
  assert.equal(await turn.locator('.message.user').innerText(), PROMPT);

  await turn.getByRole('button', { name: 'More message actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit and retry', exact: true }).click();
  assert.equal(await edit.inputValue(), PROMPT);
  await edit.press('Escape');
  assert.equal(await edit.count(), 0);
  assert.equal(replacements().length, 0);

  await turn.getByRole('button', { name: 'Edit message', exact: true }).click();
  await edit.fill('Deliberate revised verdict 715');
  await form.getByRole('button', { name: 'Send', exact: true }).click();
  await form.getByRole('alert').filter({ hasText: 'Private replacement refused' }).waitFor();
  assert.equal(await edit.inputValue(), 'Deliberate revised verdict 715');
  assert.equal(await composer.inputValue(), 'Unrelated composer draft');
  assert.equal(await page.getByText('Earlier reply', { exact: true }).count(), 1);
  control.allow();
  await form.getByRole('button', { name: 'Send', exact: true }).click();
  await eventually(async () => assert.equal(await edit.count(), 0));
  assert.deepEqual(replacements().map(post => post.body), [
    { beforeTurnId: 'latest', text: 'Deliberate revised verdict 715' },
    { beforeTurnId: 'latest', text: 'Deliberate revised verdict 715' },
  ]);
  assert.equal(await page.getByText('Earlier reply', { exact: true }).count(), 1, 'older visible history survives the replacement');
  assert.equal(await composer.inputValue(), 'Unrelated composer draft');
}));

test('the potentially incomplete first turn and a complete turn with delivered follow-ups stay blocked', t => using(t, {}, async (f, { history }) => {
  const { page } = f;
  const first = page.locator('.user-turn').filter({ hasText: 'Earlier input' });
  assert.equal(await first.getByRole('button', { name: 'Edit message', exact: true }).count(), 0);
  await first.getByRole('button', { name: 'Why editing is unavailable', exact: true }).click();
  await first.getByRole('status').filter({ hasText: /Load .*earlier messages/ }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Edited message', exact: true }).count(), 0);
  history.push(user('latest', 'delivered-user', 'Delivered instruction must stay'));
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  const delivered = page.locator('.user-turn').filter({ hasText: 'Delivered instruction must stay' });
  await delivered.getByRole('button', { name: 'Why editing is unavailable', exact: true }).click();
  await delivered.getByRole('status').filter({ hasText: /\S/ }).waitFor();
  assert.equal(await delivered.getByRole('button', { name: 'Edit message', exact: true }).count(), 0);
  assert.equal(f.posts.filter(post => post.path.endsWith('/revert')).length, 0);
  assert.equal(await page.locator('.user-turn').count(), 3, 'the restriction never changes history');
}));
