const { guardDesktopStore, leaveSettings, openSettings } = require('./controls.cjs');
// Exported desktop UI, synthetic history/approvals, no engine or provider calls.
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http: typeof import('node:http') = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const staticOut = process.env.ELPIS_DRAFT_TEST_OUT || path.join(__dirname, '../out');
type Locator = { inputValue(): Promise<string>; count(): Promise<number>; allTextContents(): Promise<string[]>; isEnabled(): Promise<boolean>; isDisabled(): Promise<boolean> };
type StorageWrite = { kind: string; key: string; value: string | null };
async function eventually<T>(check: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}
const expect = (locator: Locator) => ({
  toHaveValue: (value: string) => eventually(async () => assert.equal(await locator.inputValue(), value)),
  toHaveCount: (count: number) => eventually(async () => assert.equal(await locator.count(), count)),
  toContainText: (text: string) => eventually(async () => assert.ok((await locator.allTextContents()).join('\n').includes(text))),
  toBeEnabled: () => eventually(async () => assert.equal(await locator.isEnabled(), true)),
  toBeDisabled: () => eventually(async () => assert.equal(await locator.isDisabled(), true)),
});
expect.poll = <T,>(read: () => T | Promise<T>) => ({ toBe: (value: T) => eventually(async () => assert.equal(await read(), value)) });

async function fixture(t: import('node:test').TestContext) {
  const clients = new Set<import('node:http').ServerResponse>(), posts: { path: string; body: unknown }[] = [];
  const threads = ['a', 'b'].map(id => ({ id, name: `Draft chat ${id.toUpperCase()}`, model: 'sol', modelProvider: 'openai', cwd: '/tmp/draft-fixture', status: { type: 'idle' }, desktopAccess: { mode: 'direct', writable: true } }));
  const settings = { version: 'fixture-v1', main: { model: 'sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }], write: { available: true }, background: { model: 'sol', provider: 'openai' }, memory: { generate: true, use: true, extractionModel: 'sol', consolidationModel: null }, smartPrune: { enabled: true, explicitOverride: { available: false } } };
  const control: { failEdits: boolean; failAnswers: boolean; holdEdit?: boolean; holdAnswer?: boolean; releaseEdit?: () => void; releaseAnswer?: () => void; sharedIds?: boolean; bodyA?: string; bodyB?: string } = { failEdits: true, failAnswers: true };
  const emit = (type: string, data: unknown) => { for (const client of clients) client.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  const server = http.createServer(async (req, res) => {
    assert.ok(req.url); const url = new URL(req.url, 'http://fixture'), pathname = url.pathname;
    const json = (data: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {}; posts.push({ path: pathname, body });
      if (pathname.endsWith('/resume')) return json({ thread: threads.find(thread => pathname.includes(`/threads/${thread.id}/`)), activeTurnId: null });
      if (pathname.endsWith('/revert')) {
        if (control.holdEdit) { control.holdEdit = false; await new Promise<void>(resolve => { control.releaseEdit = resolve; }); }
        if (control.failEdits) return json({ error: 'Fixture edit failed' }, 503);
        const threadId = pathname.split('/')[3], turn = { id: `replacement-${threadId}` };
        emit('message', { method: 'turn/completed', params: { threadId, turn: { ...turn, status: 'completed' } } });
        return json({ turn });
      }
      if (pathname.startsWith('/api/approvals/')) {
        if (control.holdAnswer) { control.holdAnswer = false; await new Promise<void>(resolve => { control.releaseAnswer = resolve; }); }
        return control.failAnswers ? json({ error: 'Fixture answer failed' }, 503) : json({ resolved: true });
      }
      return json({});
    }
    if (pathname === '/api/health') return json({ connected: true, cwd: '/tmp/draft-fixture' });
    if (pathname === '/api/models') return json({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol' }], nextCursor: null });
    if (pathname === '/api/settings') return json(settings);
    if (pathname === '/api/providers') return json({ openai: { auth: { state: 'signedIn', method: 'ChatGPT', email: 'fixture@example.invalid' }, usage: [], usageError: null }, claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [], local: [] });
    if (pathname === '/api/providers/settings') return json({ version: 'fixture-v1', write: { available: false }, managed: {}, providers: [] });
    if (pathname === '/api/mcp') return json({ version: 'fixture-v1', write: { available: false }, servers: [] });
    if (pathname === '/api/tools/transcription') return json({ available: false });
    if (pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : threads, nextCursor: null });
    if (pathname.startsWith('/api/threads/')) {
      const thread = threads.find(item => item.id === pathname.split('/')[3]); assert.ok(thread);
      const suffix = control.sharedIds ? 'shared' : thread.id;
      return json({ thread, data: [{ turnId: `turn-${suffix}`, turnStatus: 'completed', item: { id: `reply-${suffix}`, type: 'agentMessage', text: `Reply ${thread.id.toUpperCase()}` } }, { turnId: `turn-${suffix}`, turnStatus: 'completed', item: { id: `user-${suffix}`, type: 'userMessage', content: [{ type: 'text', text: control[`body${thread.id.toUpperCase()}` as 'bodyA' | 'bodyB'] || `Original ${thread.id.toUpperCase()}` }] } }], nextCursor: null });
    }
    const file = path.join(staticOut, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let browser: { close(): Promise<void> } | undefined;
  t.after(async () => { control.releaseEdit?.(); control.releaseAnswer?.(); await browser?.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  const launched = await chromium.launch({ headless: true, executablePath: process.env.ELPIS_CHROMIUM || undefined }); browser = launched;
  const page = await launched.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error: Error) => t.diagnostic(error.stack || error.message));
  page.setDefaultTimeout(4000);
  await guardDesktopStore(page);
  await page.addInitScript(() => {
    const writes: StorageWrite[] = []; Reflect.set(window, '__draftStorageWrites', writes);
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { writes.push({ kind: 'web', key, value }); return write.call(this, key, value); };
    const saved = new Map<string, string>();
    Reflect.set(window, 'elpisDesktop', { storage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem(key: string, value: string) { writes.push({ kind: 'desktop', key, value }); saved.set(key, value); },
      removeItem(key: string) { writes.push({ kind: 'desktop', key, value: null }); saved.delete(key); },
      onError: () => () => {},
    } });
  });
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await expect(page.getByRole('textbox', { name: 'Message Elpis', exact: true })).toBeEnabled();
  const open = async (id: string) => { await leaveSettings(page); await page.locator('.thread-link').filter({ hasText: `Draft chat ${id.toUpperCase()}` }).click(); await expect(page.getByRole('button', { name: 'Refresh conversation', exact: true })).toBeEnabled(); await expect(page.locator('.chat-view .message.user')).toHaveCount(1); };
  const settingsPage = () => openSettings(page);
  return { page, open, settingsPage, posts, emit, control };
}

test('unsent inline edits survive navigation, failures and chat switches; cancel and acknowledged success clear only their draft', async t => {
  const { page, open, settingsPage, posts, control } = await fixture(t);
  const edit = page.getByRole('textbox', { name: 'Edited message', exact: true });
  const form = page.getByRole('form', { name: 'Edit message', exact: true });
  await open('a'); await page.getByRole('button', { name: 'Edit message', exact: true }).click(); await edit.fill('Revision A');
  await settingsPage(); await open('a'); await expect(edit).toHaveValue('Revision A');
  await open('b'); await expect(edit).toHaveCount(0); await page.getByRole('button', { name: 'Edit message', exact: true }).click(); await expect(edit).toHaveValue('Original B'); await edit.fill('Revision B');
  await page.getByRole('button', { name: 'Lab', exact: true }).click(); await open('a'); await expect(edit).toHaveValue('Revision A');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await settingsPage(); await open('a'); await expect(edit).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit message', exact: true }).click(); await expect(edit).toHaveValue('Original A'); await edit.fill('Failed revision A');
  await form.getByRole('button', { name: 'Send', exact: true }).click(); await expect(form.getByRole('alert')).toContainText('Fixture edit failed');
  await settingsPage(); await open('a'); await expect(edit).toHaveValue('Failed revision A');
  control.failEdits = false; await form.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => posts.filter(post => post.path === '/api/threads/a/revert').length).toBe(2);
  assert.deepEqual(posts.filter(post => post.path === '/api/threads/a/revert').map(post => post.body), Array(2).fill({ beforeTurnId: 'turn-a', text: 'Failed revision A' }));
  await expect(edit).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click(); await expect(page.locator('.user-turn')).toContainText('Original A'); await expect(edit).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit message', exact: true }).click(); await expect(edit).toHaveValue('Original A');
  await open('b'); await expect(edit).toHaveValue('Revision B');
  assert.equal(posts.filter(post => post.path.endsWith('/turns')).length, 0);
});

test('question answers survive chat and Needs-input navigation, retain failures and clear on acknowledgement/resolution without storing secrets', async t => {
  const { page, open, settingsPage, posts, emit, control } = await fixture(t);
  const approval = (id: string, threadId: string) => ({ id, ownerThreadId: threadId, method: 'item/tool/requestUserInput', params: { threadId, questions: [{ id: 'answer', header: 'Answer', question: 'What should happen?' }, { id: 'secret', header: 'Secret', question: 'Private fixture answer', isSecret: true }] } });
  const card = page.locator('.chat-view .approval'), inputs = card.locator('input');
  await open('a'); emit('approval', approval('approval-a', 'a')); await expect(card).toHaveCount(1);
  await inputs.nth(0).fill('Answer A'); await inputs.nth(1).fill('synthetic-secret-a');
  await settingsPage(); await page.getByRole('button', { name: /^Needs input \(/ }).click();
  const pending = page.locator('#pending-input-panel .approval'); await expect(pending.locator('input').nth(0)).toHaveValue('Answer A'); await expect(pending.locator('input').nth(1)).toHaveValue('synthetic-secret-a');
  await page.getByRole('button', { name: 'Close pending input', exact: true }).click(); await open('b'); emit('approval', approval('approval-b', 'b'));
  await expect(inputs.nth(0)).toHaveValue(''); await expect(inputs.nth(1)).toHaveValue(''); await inputs.nth(0).fill('Answer B'); await inputs.nth(1).fill('synthetic-secret-b');
  await page.getByRole('button', { name: 'Lab', exact: true }).click(); await open('a'); await expect(inputs.nth(0)).toHaveValue('Answer A'); await expect(inputs.nth(1)).toHaveValue('synthetic-secret-a');
  await card.getByRole('button', { name: 'Submit', exact: true }).click(); await expect(card.getByRole('alert')).toContainText('Fixture answer failed');
  await settingsPage(); await open('a'); await expect(inputs.nth(0)).toHaveValue('Answer A'); await expect(inputs.nth(1)).toHaveValue('synthetic-secret-a');
  control.failAnswers = false; control.holdAnswer = true; await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => posts.filter(post => post.path === '/api/approvals/approval-a').length).toBe(2);
  await open('b'); await expect(inputs.nth(0)).toHaveValue('Answer B'); await expect(inputs.nth(0)).toBeEnabled();
  await open('a'); await expect(inputs.nth(0)).toHaveValue('Answer A'); await expect(inputs.nth(0)).toBeDisabled(); await expect(inputs.nth(1)).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: 'Submit', exact: true }).evaluate((button: HTMLElement) => button.click());
  assert.equal(posts.filter(post => post.path === '/api/approvals/approval-a').length, 2);
  await open('b'); await inputs.nth(0).fill('Newer answer B');
  const answerResponse = page.waitForResponse((response: { url(): string; status(): number }) => response.url().endsWith('/api/approvals/approval-a') && response.status() === 200);
  assert.ok(control.releaseAnswer); control.releaseAnswer(); await answerResponse; await expect(inputs.nth(0)).toHaveValue('Newer answer B'); await expect(inputs.nth(1)).toHaveValue('synthetic-secret-b');
  await open('a'); await expect(card).toHaveCount(0);
  emit('approval', approval('approval-a', 'a')); await expect(inputs.nth(0)).toHaveValue(''); await expect(inputs.nth(1)).toHaveValue('');
  emit('approvalResolved', { id: 'approval-a' }); await expect(card).toHaveCount(0);
  await open('b'); await expect(inputs.nth(0)).toHaveValue('Newer answer B'); await expect(inputs.nth(1)).toHaveValue('synthetic-secret-b');
  emit('approvalResolved', { id: 'approval-b' }); await expect(card).toHaveCount(0); emit('approval', approval('approval-b', 'b'));
  await expect(inputs.nth(0)).toHaveValue(''); await expect(inputs.nth(1)).toHaveValue('');
  assert.equal(posts.filter(post => post.path.startsWith('/api/approvals/')).length, 2);
  assert.deepEqual(posts.filter(post => post.path === '/api/approvals/approval-a').map(post => post.body), Array(2).fill({ answers: { answer: ['Answer A'], secret: ['synthetic-secret-a'] } }));
  assert.equal(await page.evaluate(() => (Reflect.get(window, '__draftStorageWrites') as StorageWrite[]).some(write => JSON.stringify(write).includes('synthetic-secret-'))), false);
  assert.equal(await page.evaluate(() => (Reflect.get(window, '__draftStorageWrites') as StorageWrite[]).some(write => write.kind === 'desktop' && write.key === 'elpis-last-chat')), true);
});

test('a delayed edit stays disabled across navigation and preserves the other chat even when item IDs match', async t => {
  const { page, open, control, posts } = await fixture(t);
  control.sharedIds = true; control.failEdits = false; control.holdEdit = true;
  const edit = page.getByRole('textbox', { name: 'Edited message', exact: true });
  await open('a'); await page.getByRole('button', { name: 'Edit message', exact: true }).click(); await edit.fill('Submitted revision A');
  await page.getByRole('form', { name: 'Edit message', exact: true }).getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => posts.filter(post => post.path === '/api/threads/a/revert').length).toBe(1);
  await expect(edit).toBeDisabled(); await open('b'); await expect(edit).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit message', exact: true }).click(); await expect(edit).toHaveValue('Original B'); await edit.fill('Revision B');
  await open('a'); await expect(edit).toHaveValue('Submitted revision A'); await expect(edit).toBeDisabled();
  await expect(page.getByRole('form', { name: 'Edit message', exact: true }).getByRole('button', { name: 'Sending…', exact: true })).toBeDisabled();
  await page.getByRole('form', { name: 'Edit message', exact: true }).evaluate((form: HTMLElement) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(posts.filter(post => post.path === '/api/threads/a/revert').length, 1);
  await open('b'); await expect(edit).toHaveValue('Revision B'); await expect(edit).toBeEnabled(); await edit.fill('Newer revision B');
  const response = page.waitForResponse((result: { url(): string; status(): number }) => result.url().endsWith('/api/threads/a/revert') && result.status() === 200);
  assert.ok(control.releaseEdit); control.releaseEdit(); await response; await expect(edit).toHaveValue('Newer revision B');
  await open('a'); await expect(edit).toHaveCount(0); await page.getByRole('button', { name: 'Edit message', exact: true }).click(); await expect(edit).toHaveValue('Original A'); await edit.fill('Unsent after acknowledgement');
  control.bodyA = 'Fresh source A'; await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click(); await expect(edit).toHaveValue('Unsent after acknowledgement');
  assert.deepEqual(posts.filter(post => post.path.endsWith('/revert')), [{ path: '/api/threads/a/revert', body: { beforeTurnId: 'turn-shared', text: 'Submitted revision A' } }]);
});
