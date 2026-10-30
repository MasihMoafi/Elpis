const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');
const shots = '/home/masih/.cache/elpis-briefs/20261030/shots/quota-card';

async function using(run, options = {}) {
  const f = await fixture({ width: 1280, height: 800, ...options, routes: {
    '/api/threads/chat-a/revert': () => ({ turn: { id: 'retry-turn' }, rewound: true }),
    ...options.routes,
  } });
  try {
    await f.page.addInitScript(() => {
      const Original = window.EventSource;
      window.__streams = [];
      window.EventSource = class extends Original { constructor(...args) { super(...args); window.__streams.push(this); } };
    });
    await f.page.route('**/api/models*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'sol', model: 'sol', displayName: 'GPT-6.1-Sol' }, { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] }) }));
    await f.page.reload(); await f.open('chat-a');
    await f.page.waitForFunction(() => window.__streams?.length);
    const fail = (error, turnId = 't4') => f.page.evaluate(({ error, turnId }) => {
      for (const stream of window.__streams) stream.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'turn/completed', params: { threadId: 'chat-a', turn: { id: turnId, status: 'failed', error } } }) }));
    }, { error, turnId });
    await run({ ...f, fail }); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}
const card = page => page.getByRole('alert').filter({ has: page.getByRole('heading', { name: /Turn failed|Model overloaded|Rate limited/ }) });
const eventually = async check => { for (let i = 0; ; i++) { try { return await check(); } catch (e) { if (i >= 50) throw e; await new Promise(resolve => setTimeout(resolve, 60)); } } };

test('failed turns show inline and Try again resends once, preserving the draft', () => using(async ({ page, composer, posts, fail }) => {
  await composer.fill('Keep this draft');
  await fail({ message: 'The connection ended.', codexErrorInfo: 'other' });
  const notice = card(page); await notice.waitFor();
  assert.equal(await page.locator('.chat-content').getByRole('heading', { name: 'Turn failed', exact: true }).count(), 1);
  assert.match(await notice.innerText(), /The connection ended/);
  assert.equal(await notice.getByRole('button', { name: /Dismiss|Close/ }).count(), 0);
  assert.equal(await notice.getByRole('button', { name: /Switch model/ }).count(), 0);
  await notice.getByRole('button', { name: 'Try again', exact: true }).dblclick();
  await eventually(() => assert.equal(posts.filter(p => p.path.endsWith('/revert')).length, 1));
  assert.deepEqual(posts.find(p => p.path.endsWith('/revert')).body, { beforeTurnId: 't4', text: 'Run them.' });
  assert.equal(await composer.inputValue(), 'Keep this draft');
}));

for (const codexErrorInfo of ['serverOverloaded', { httpConnectionFailed: { httpStatusCode: 529 } }, 'usageLimitExceeded']) test(`a ${JSON.stringify(codexErrorInfo)} failure can switch model and retry`, () => using(async ({ page, posts, fail }) => {
  await fail({ message: 'Please try later.', codexErrorInfo });
  const notice = card(page); await notice.waitFor();
  const usage = codexErrorInfo === 'usageLimitExceeded';
  assert.match(await notice.innerText(), usage ? /Rate limited/ : /Model overloaded/);
  await notice.getByRole('button', { name: usage ? 'Switch model' : 'Switch model and retry', exact: true }).click();
  await page.getByRole('menuitem', { name: 'GPT-6-Luna', exact: true }).click();
  await eventually(() => assert.equal(posts.filter(p => p.path.endsWith('/revert')).length, 1));
  assert.deepEqual(posts.find(p => p.path.endsWith('/revert')).body, { beforeTurnId: 't4', text: 'Run them.', model: 'gpt-6-luna' });
}));

test('rate limits have no overload switch; unsafe input explains why retry is unavailable', () => using(async ({ page, fail }) => {
  await fail({ message: 'Wait a moment.', codexErrorInfo: 'rateLimitExceeded' });
  await card(page).getByRole('heading', { name: 'Rate limited', exact: true }).waitFor();
  assert.equal(await card(page).getByRole('button', { name: /Switch model/ }).count(), 0);
  await fail({ message: 'Missing input.', codexErrorInfo: 'other' }, 'not-loaded');
  await card(page).getByText(/original|complete input/i).waitFor();
  assert.equal(await card(page).getByRole('button', { name: 'Try again', exact: true }).count(), 0);
  await page.locator('.thread-row[data-thread-id="chat-b"] .thread-link').click();
  assert.equal(await card(page).count(), 0);
  await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
  await card(page).waitFor();
}));

for (const colorScheme of ['light', 'dark']) test(`${colorScheme} quota reset time is readable and changing the composer model clears the stale card`, () => using(async ({ page, fail }) => {
  await fs.mkdir(shots, { recursive: true });
  await fail({ message: 'Gemini (ACP) error: Individual quota reached. Resets in 17h3m6s.', codexErrorInfo: 'usageLimitExceeded' });
  const notice = card(page);
  await notice.getByText('Gemini (ACP) error: Individual quota reached. Resets in 17 hours, 3 minutes, and 6 seconds.', { exact: true }).waitFor();
  await page.screenshot({ path: `${shots}/${colorScheme}-quota-card.png` });
  await page.getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('option', { name: /GPT-6-Luna/ }).click();
  await eventually(async () => assert.equal(await card(page).count(), 0));
  assert.equal(await page.getByRole('combobox', { name: 'Model' }).getAttribute('data-value'), 'gpt-6-luna');
  await page.screenshot({ path: `${shots}/${colorScheme}-model-switched.png` });
}, { colorScheme }));

test('a refused retry shows the refusal and allows another deliberate attempt', () => using(async ({ page, fail }) => {
  await fail({ message: 'Disconnected.', codexErrorInfo: 'other' });
  const notice = card(page); await notice.getByRole('button', { name: 'Try again', exact: true }).click();
  await notice.getByText('Cannot replace this turn.', { exact: true }).waitFor();
  assert.equal(await notice.getByRole('button', { name: 'Try again', exact: true }).isEnabled(), true);
}, { routes: { '/api/threads/chat-a/revert': () => ({ __http: 409, error: { message: 'Cannot replace this turn.' } }) } }));

test('successful completion clears both a failed card and a temporary runtime notice', () => using(async ({ page, fail }) => {
  await fail({ message: 'The connection ended.', codexErrorInfo: 'other' });
  await card(page).waitFor();
  await page.evaluate(() => {
    for (const stream of window.__streams) stream.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'error', params: { threadId: 'chat-a', error: { message: 'Temporary transport failure' }, willRetry: true } }) }));
  });
  await page.locator('.workspace-notices').getByText(/Temporary transport failure/).waitFor();
  await page.evaluate(() => {
    for (const stream of window.__streams) stream.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'turn/completed', params: { threadId: 'chat-a', turn: { id: 't4', status: 'completed' } } }) }));
  });
  await eventually(async () => {
    assert.equal(await card(page).count(), 0);
    assert.equal(await page.locator('.workspace-notices').getByText(/Temporary transport failure/).count(), 0);
  });
}));
