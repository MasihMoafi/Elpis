// Agent work in the chat as Claude's desktop app shows it: finished tool activity folds into one muted row
// ("Ran 2 commands (1 failed)"), each command opens to a coloured shell block and its output (failures in red),
// a running step counts its seconds, inline code is a red chip, and while a turn runs Enter and Ctrl+Enter
// choose between steering and queueing. Local fixture of the bridge; no runtime or model calls.
import type { BrowserType } from 'playwright-core';

type HistoryEntry = { turnId: string; item: object; startedAtMs?: number; completedAtMs?: number };
type RgbWindow = typeof window & { __rgb(value: string): string };
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http: typeof import('node:http') = require('node:http');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const path: typeof import('node:path') = require('node:path');
const { chromium }: { chromium: BrowserType } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

const thread = { id: 'work', name: 'Agent work', cwd: '/tmp/demo', model: 'sol', modelProvider: 'openai', status: { type: 'active' }, desktopAccess: { writable: true, mode: 'direct' } };
const unknown = (command: string) => [{ type: 'unknown', command }];
/** One finished turn (two groups around a reply) and one running turn, in the order they happened. */
function history(now: number): HistoryEntry[] {
  const t1 = now - 600_000;
  const entry = (turnId: string, item: object, startedAtMs: number, completedAtMs = startedAtMs) => ({ turnId, item, startedAtMs, completedAtMs });
  const shell = `/bin/bash -lc 'rg -n "TODO" src && echo $HOME | wc -l'`;
  return [
    entry('t1', { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Tidy the build folder.' }] }, t1),
    entry('t1', { id: 'c1', type: 'commandExecution', command: shell, cwd: '/tmp/demo', status: 'completed', exitCode: 0, aggregatedOutput: '3\n', durationMs: 400, commandActions: unknown(shell) }, t1 + 1000),
    entry('t1', { id: 'c2', type: 'commandExecution', command: 'npm test', cwd: '/tmp/demo', status: 'failed', exitCode: 1, aggregatedOutput: '1 test failed\nError: expected 2, got 3', durationMs: 2100, commandActions: unknown('npm test') }, t1 + 2000),
    entry('t1', { id: 'a1', type: 'agentMessage', text: 'Now the leftovers in `/tmp`. They cannot go to the Trash from there.' }, t1 + 3000),
    entry('t1', { id: 'f1', type: 'fileChange', status: 'completed', changes: [{ path: 'src/app.ts', kind: { type: 'update' }, diff: '- a\n+ b' }] }, t1 + 4000),
    entry('t1', { id: 'm1', type: 'mcpToolCall', server: 'rag', tool: 'search', status: 'completed', arguments: { query: 'leftovers' }, result: { content: [{ type: 'text', text: '2 hits' }] } }, t1 + 5000),
    entry('t1', { id: 'c3', type: 'commandExecution', command: 'sed -n 1,40p src/app.ts', cwd: '/tmp/demo', status: 'completed', exitCode: 0, aggregatedOutput: 'export const app = 1;', durationMs: 30, commandActions: [{ type: 'read', command: 'sed -n 1,40p src/app.ts', name: 'app.ts', path: '/tmp/demo/src/app.ts' }] }, t1 + 6000),
    entry('t1', { id: 'c4', type: 'commandExecution', command: 'ls -la build', cwd: '/tmp/demo', status: 'completed', exitCode: 0, aggregatedOutput: 'total 0', durationMs: 20, commandActions: unknown('ls -la build') }, t1 + 7000),
    entry('t1', { id: 'a2', type: 'agentMessage', text: 'Everything is moved. Test files: `legal/evals/test-files/`.' }, t1 + 8000),
    entry('t2', { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'Restart the local site.' }] }, now - 90_000),
    entry('t2', { id: 'a3', type: 'agentMessage', text: 'Restarting the site from its new place.' }, now - 80_000),
    // Sent while t2 ran (steered into it): it belongs after the work it followed, not at the top of the turn.
    entry('t2', { id: 'u3', type: 'userMessage', content: [{ type: 'text', text: 'Use port 8088.' }] }, now - 78_000),
    entry('t2', { id: 'c5', type: 'commandExecution', command: 'npm run build', cwd: '/tmp/demo', status: 'completed', exitCode: 0, aggregatedOutput: 'built', durationMs: 9000, commandActions: unknown('npm run build') }, now - 75_000, now - 66_000),
    // Running for 62 seconds when the page loads: the timer reads 1:02 and keeps counting.
    { turnId: 't2', item: { id: 'c6', type: 'commandExecution', command: 'npm run dev -- --port 8088', cwd: '/tmp/demo', status: 'inProgress', exitCode: null, aggregatedOutput: '', durationMs: null, commandActions: unknown('npm run dev -- --port 8088') }, startedAtMs: now - 62_000 },
  ];
}

async function fixture({ longGroup = false } = {}) {
  const steered: { text: string }[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = (value: object) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : [thread], nextCursor: null });
    // Newest first, as the bridge pages history.
    if (url.pathname === '/api/threads/work' && req.method === 'GET') {
      const entries = history(Date.now());
      if (longGroup) entries.splice(2, 0, ...Array.from({ length: 24 }, (_, index) => ({ turnId: 't1', item: { id: `long-${index}`, type: 'commandExecution', command: `node inspect-${index}.mjs`, cwd: '/tmp/demo', status: 'completed', exitCode: 0, aggregatedOutput: 'Inspection complete.', commandActions: unknown(`node inspect-${index}.mjs`) } })));
      return json({ thread, data: entries.reverse(), nextCursor: null });
    }
    if (url.pathname === '/api/threads/work/resume') return json({ thread, activeTurnId: 't2' });
    if (url.pathname === '/api/threads/work/steer') { steered.push(JSON.parse(raw)); return json({}); }
    if (url.pathname.startsWith('/api/')) return json({});
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try { const content = await fs.readFile(path.join(__dirname, '../out', relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ ...(process.env.ELPIS_CHROMIUM ? { executablePath: process.env.ELPIS_CHROMIUM } : {}), headless: true });
  /** A page with the chat open; `preferences` are saved on this device before the app starts. */
  async function open({ colorScheme = 'light', preferences, reducedMotion = 'no-preference' }: { colorScheme?: 'light' | 'dark'; preferences?: Record<string, string>; reducedMotion?: 'no-preference' | 'reduce' } = {}) {
    const page = await browser.newPage({ viewport: { width: 1320, height: 900 }, colorScheme, reducedMotion }); page.setDefaultTimeout(6000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    // Computed colours come back as color-mix()/oklch() too; read them as the pixel a canvas paints.
    await page.addInitScript(() => { (window as RgbWindow).__rgb = value => { const context = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d'); if (!context) throw Error('Canvas unavailable'); context.fillStyle = value; context.fillRect(0, 0, 1, 1); const [r, g, b] = context.getImageData(0, 0, 1, 1).data; return `rgb(${r}, ${g}, ${b})`; }; });
    if (preferences) await page.addInitScript(value => localStorage.setItem('elpis-preferences-v1', value), JSON.stringify(preferences));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: 'Agent work', exact: true }).click();
    await page.getByText('Restarting the site from its new place.', { exact: true }).waitFor();
    return { page, errors };
  }
  return { steered, open, close: async () => { await browser.close(); server.close(); } };
}

const rgb = (value: string) => { const matches = value.match(/[\d.]+/g); assert.ok(matches); return matches.slice(0, 3).map(Number); };
const seconds = (text: string) => { const m = text.match(/^(?:(\d+)m )?(\d+)s$/); assert.ok(m, `a timer reads "39s" or "1m 2s", not "${text}"`); return Number(m[1] ?? 0) * 60 + Number(m[2]); };

test('a message sent while a turn runs appears where it was sent, after the work before it', async () => {
  const f = await fixture();
  try {
    const { page, errors } = await f.open();
    const order = await page.locator('section.turn').last().evaluate(turn => {
      const texts = ['Restart the local site.', 'Restarting the site from its new place.', 'Use port 8088.'];
      const all = [...turn.querySelectorAll('*')].filter(node => !node.children.length || [...node.childNodes].some(child => child.nodeType === 3 && (child.textContent as string).trim()));
      return texts.map(text => all.findIndex(node => (node.textContent as string).trim() === text));
    });
    assert.ok(order.every(at => at >= 0), `all three are shown (${order})`);
    const [prompt, reply, steered] = order; assert.ok(prompt !== undefined && reply !== undefined && steered !== undefined);
    assert.ok(prompt < reply && reply < steered, `in the order they happened: prompt, reply, then the steered message (${order})`);
    assert.deepEqual(errors, []);
  } finally { await f.close(); }
});

test('while a turn runs, Enter follows the follow-up setting and Ctrl+Enter does the other for that message', async () => {
  const app = await fixture();
  try {
    const { page, errors } = await app.open();
    const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    assert.equal(await composer.getAttribute('placeholder'), 'Enter to send, Ctrl+Enter to queue for later');

    await composer.fill('steer this'); await composer.press('Enter');
    await page.waitForFunction(() => !(document.querySelector('[aria-label="Message Elpis"]') as HTMLTextAreaElement).value);
    assert.deepEqual(app.steered.map(body => body.text), ['steer this'], 'Enter steers the running turn (the default)');
    await composer.fill('later please'); await composer.press('Control+Enter');
    const queued = page.getByRole('list', { name: 'Queued follow-ups', exact: true });
    await queued.getByText('later please', { exact: true }).waitFor();
    assert.deepEqual(app.steered.map(body => body.text), ['steer this'], 'Ctrl+Enter queues instead');
    assert.deepEqual(errors, []);
    await page.close();

    // With Queue chosen in Settings, the keys swap and the hint says so.
    const queue = await app.open({ preferences: { followUp: 'queue' } });
    const box = queue.page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await queue.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    assert.equal(await box.getAttribute('placeholder'), 'Enter to queue for later, Ctrl+Enter to send now');
    await box.fill('queued by Enter'); await box.press('Enter');
    await queue.page.getByRole('list', { name: 'Queued follow-ups', exact: true }).getByText('queued by Enter', { exact: true }).waitFor();
    await box.fill('steered by Ctrl'); await box.press('Control+Enter');
    await queue.page.waitForFunction(() => !(document.querySelector('[aria-label="Message Elpis"]') as HTMLTextAreaElement).value);
    assert.deepEqual(app.steered.map(body => body.text), ['steer this', 'steered by Ctrl']);
    await queue.page.close();

    // The Ctrl+Enter send shortcut keeps Enter for new lines: Ctrl+Enter follows the setting, Ctrl+Shift+Enter does the other.
    const mod = await app.open({ preferences: { sendShortcut: 'modEnter' } });
    const modBox = mod.page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await mod.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    assert.equal(await modBox.getAttribute('placeholder'), 'Ctrl+Enter to send, Ctrl+Shift+Enter to queue for later');
    await modBox.fill('line'); await modBox.press('Enter');
    assert.equal(await modBox.inputValue(), 'line\n', 'Enter adds a line');
    await modBox.press('Control+Shift+Enter');
    await mod.page.getByRole('list', { name: 'Queued follow-ups', exact: true }).getByText('line', { exact: true }).waitFor();
    assert.equal(app.steered.length, 2);
  } finally { await app.close(); }
});
