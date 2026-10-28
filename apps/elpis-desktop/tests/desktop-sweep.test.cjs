const { threadMenuItem, openPatterns } = require('./controls.cjs');
// Whole desktop fit gate. Built renderer, synthetic bridge and desktop only: no engine, account, shell or user state.
// Keep visiting after a failure so one broken page cannot hide the rest of the sweep.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');
const { uiFit } = require('./ui-fit.cjs');
const { contextRoutes } = require('./context-files-fixture.cjs');

const PAGES = ['Models & accounts', 'Configuration', 'Personalization', 'MCP servers', 'Voice', 'Git', 'Worktrees', 'Hooks', 'General', 'Notifications', 'Appearance', 'Keyboard shortcuts', 'Usage & limits', 'Import chats', 'Archived chats', 'About'];
const TOPICS = ['One agent or many', 'Mother and Father', 'Writers and checks', 'Choose a pattern', 'Read a run'];
const description = 'Check the shared components and their rendered layout, then explain which parts need attention before changing the interface. '.repeat(3);
function routes() {
  const settings = { version: 's1', main: { model: 'sol', provider: 'openai' }, background: {}, providers: [{ id: 'openai', displayName: 'OpenAI' }], agents: { graph: 256, atOnce: 4, source: 'agents.max_threads' },
    smartPrune: { enabled: true, explicitOverride: { available: true, version: 'p1', model: null, provider: null } }, memory: { enabled: true, generate: true, use: true }, options: {}, managed: {}, write: { available: true, reason: 'Applies to new conversations.' } };
  let scene = { elements: [], appState: {}, files: {}, page: { name: 'Current page', session: 'fixture' } };
  return {
    ...contextRoutes(),
    '/api/import-chats': () => ({ days: 30, atATime: 50, sources: [] }),
    '/api/about': () => ({ version: '0.1.0', commit: 'ac82360bd', releaseNotes: 'https://example.invalid/releases' }),
    '/api/settings': body => { if (body?.options) Object.assign(settings.options, body.options); return settings; },
    '/api/providers': () => ({ openai: { auth: { state: 'signedOut' }, usage: [] }, claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [], local: [] }),
    '/api/providers/settings': () => ({ version: 'p1', providers: [], managed: {}, write: { available: true } }),
    '/api/mcp': () => ({ version: 'm1', configPath: '/tmp/fixture/config.toml', servers: [{ name: 'rag', enabled: true, transport: 'stdio', command: 'rag-mcp', credentials: [] }], write: { available: true } }),
    '/api/hooks': () => ({ version: 'h1', hooks: [{ key: 'fixture-hook', event: 'preToolUse', handler: 'command', command: 'check-files', matcher: '^Bash$', source: 'user', sourcePath: '/tmp/fixture/hooks.json', enabled: true, managed: false, trust: 'untrusted' }], warnings: [], errors: [], write: { available: true } }),
    '/api/tools/transcription': () => ({ available: true, backend: 'local', label: 'Local WhisperType' }),
    '/api/tools/rag': () => ({ stages: [], keys: { openrouter: false } }),
    '/api/customize': () => ({ skills: { data: [{ id: 'web-dev', name: 'web-dev', description, path: '/tmp/fixture/skills/web-dev/SKILL.md', scope: 'user', enabled: true }], errors: [] }, plugins: { data: [{ id: 'docs', name: 'Docs', description, marketplace: 'Local', enabled: true }] }, connectors: { data: [{ name: 'rag', enabled: true, transport: 'stdio' }, { name: 'GitHub', transport: 'gh', enabled: true, login: null }] } }),
    '/api/folders': () => ({ data: ['src', 'tests', 'docs'] }),
    '/api/repository': () => ({ repository: true }),
    '/api/files/dir': () => ({ data: [{ name: 'README.md', path: 'README.md', type: 'file' }] }),
    '/api/file': () => ({ content: '# Fixture\nReadable contents.\n', size: 29, mtimeMs: 1 }),
    '/api/threads/chat-a/git': () => ({ branch: 'main', files: [], staged: [], unstaged: [] }),
    '/api/workflows': () => ({ data: [] }),
    '/api/love-spot': body => { if (body) scene = body; return { scene, revision: 'fixture' }; },
    '/api/love-spot/pages': () => ({ current: scene.page, pages: [{ name: 'Current page', modified: 1 }] }),
  };
}
async function command(page, name) {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search or start a chat' }).fill(name);
  await page.getByRole('option', { name: new RegExp('^' + name) }).first().click();
}

async function expectFocus(page, target) {
  await page.waitForFunction(element => element === document.activeElement, await target.elementHandle());
}

for (const colorScheme of ['light', 'dark']) for (const [width, height] of [[1280, 800], [900, 700]]) {
  test(`desktop sweep: ${colorScheme} ${width}×${height}`, { timeout: 180000 }, async t => {
    const f = await fixture({ width, height, colorScheme, routes: routes() }), { page } = f;
    const directory = process.env.ELPIS_SWEEP_SHOTS || '/tmp/elpis-desktop-sweep';
    const failures = [], visited = [], consoleErrors = [];
    await page.route(url => /^\/api\/love-spot\/(?:talk\/)?events$/.test(url.pathname), route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await fs.mkdir(directory, { recursive: true });
    const check = async (name, action, scope = () => page.locator('body')) => {
      try {
        await action(); await page.waitForTimeout(120);
        visited.push(name);
        const issues = await uiFit(scope());
        if (issues.length) failures.push({ name, issues });
        await page.screenshot({ path: `${directory}/${colorScheme}-${width}-${name.replace(/[^a-z0-9]+/gi, '-')}.png`, animations: 'disabled' });
      } catch (error) { failures.push({ name, error: error.message.split('\n').slice(0, 4).join('\n') }); }
    };
    try {
      await page.locator('.startup-splash').waitFor({ state: 'detached' });
      await check('new chat', async () => {});
      await check('project dialog', async () => { await page.getByRole('button', { name: 'Add new project', exact: true }).click(); await page.getByRole('alertdialog').waitFor(); });
      await page.keyboard.press('Escape');
      await check('chat', () => f.open('chat-a'));
      const ledger = page.getByRole('dialog', { name: 'Context window usage', exact: true });
      await check('Ledger context files included', async () => { await page.getByRole('group', { name: 'Elpis features', exact: true }).getByRole('button', { name: 'Ledger', exact: true }).click(); await ledger.getByRole('switch', { name: 'Include ES.md', exact: true }).waitFor(); }, () => ledger);
      await check('Ledger context file excluded', async () => { await ledger.getByRole('switch', { name: 'Include ES.md', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="Include ES.md"]').getAttribute('aria-checked') === 'false'); }, () => ledger);
      await check('Ledger categories collapsed', async () => { await ledger.getByRole('button', { name: /^Context window/ }).click(); }, () => ledger);
      await page.keyboard.press('Escape');
      for (const name of ['Rename', 'Delete']) {
        await check(`chat ${name} dialog`, async () => {
          await page.locator('.thread-row[data-thread-id="chat-a"]').click({ button: 'right' });
          await page.getByRole('menuitem', { name, exact: true }).click();
          await page.getByRole('alertdialog').waitFor();
        });
        await page.keyboard.press('Escape');
      }
      await check('Rewind dialog', async () => {
        await page.locator('.message.user').filter({ hasText: 'Run them.' }).click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Rewind to here', exact: true }).click();
        await page.getByRole('alertdialog').waitFor();
      });
      await page.keyboard.press('Escape');
      for (const name of ['Add files and more', 'Change permissions']) {
        await check(name, async () => { await page.getByRole('button', { name, exact: true }).click(); await page.getByRole('menu').waitFor(); });
        await page.keyboard.press('Escape');
      }
      await check('model picker', async () => { await page.getByRole('combobox', { name: 'Model', exact: true }).click(); await page.getByRole('listbox').waitFor(); });
      await page.keyboard.press('Escape');
      await f.composer.focus();
      await check('command menu', async () => { await page.keyboard.press('Control+k'); await page.getByRole('dialog', { name: 'Command menu' }).waitFor(); });
      await page.keyboard.press('Escape');
      await check('command menu restores focus', () => expectFocus(page, f.composer));
      await f.composer.focus();
      await check('keyboard shortcuts dialog', async () => { await page.keyboard.press('Control+/'); await page.getByRole('alertdialog').waitFor(); });
      await page.keyboard.press('Escape');
      await check('keyboard shortcuts restores focus', () => expectFocus(page, f.composer));
      await check('Bash mode', async () => { await f.composer.click(); await page.keyboard.type('!'); await page.getByText('Bash mode. Press Escape to return to chat.', { exact: true }).waitFor(); });
      await f.composer.press('Escape');
      await check('side chat', async () => { await f.composer.press('Control+;'); await page.getByRole('region', { name: 'Side chat', exact: true }).waitFor(); }, () => page.getByRole('region', { name: 'Side chat', exact: true }));
      await page.getByRole('textbox', { name: 'Side question', exact: true }).press('Escape');

      await openSettings(page);
      assert.deepEqual(await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab').allInnerTexts(), PAGES, 'new settings pages must be added to the sweep');
      for (const name of PAGES) {
        await check(`Settings ${name}`, async () => { await page.getByRole('tab', { name, exact: true }).click(); await page.getByRole('tabpanel', { name, exact: true }).waitFor(); });
        // Every choice menu is opened, measured and dismissed with the actual keyboard.
        const panel = page.getByRole('tabpanel', { name, exact: true });
        const selects = panel.locator('[data-slot="select-trigger"]:visible:not([disabled]):not([data-disabled])');
        for (let index = 0; index < await selects.count(); index++) {
          const select = selects.nth(index), label = await select.getAttribute('aria-label') || String(index);
          await check(`Settings ${name} menu ${label}`, () => select.click());
          await page.keyboard.press('Escape');
        }
        if (name === 'Models & accounts') {
          await check('Settings advanced API connections', () => panel.getByText('Advanced API connections', { exact: true }).click());
          await check('Settings API provider form', () => panel.getByRole('button', { name: 'Add API provider', exact: true }).click());
        }
        if (name === 'Personalization') {
          await check('Settings delete memories dialog', async () => { await panel.getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('alertdialog').waitFor(); });
          await page.keyboard.press('Escape');
        }
      }
      await page.getByRole('button', { name: 'Back to app', exact: true }).click();
      await check('Customize Skills', () => page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click());
      for (const name of ['Plugins', 'Connectors']) await check(`Customize ${name}`, () => page.getByRole('radiogroup', { name: 'Customize', exact: true }).getByRole('radio', { name, exact: true }).click());
      await check('guide', () => command(page, 'Guide'));
      for (const name of TOPICS) await check(`Guide ${name}`, () => page.getByRole('region', { name: 'Guide to managing agents' }).getByRole('button', { name, exact: true }).click());
      await check('Canvas 2D', () => command(page, 'Workflows'));
      await check('Canvas patterns', () => openPatterns(page.getByRole('region', { name: 'Workflows', exact: true })));
      await check('Canvas Voting', () => page.getByRole('button', { name: /^Voting/ }).click());
      await check('Canvas selected agent', () => page.locator('.react-flow__node-agent').first().click());
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await check('Canvas add agents', () => page.getByRole('region', { name: 'Workflows', exact: true }).getByRole('button', { name: /^Command/ }).click());
      await page.keyboard.press('Escape');
      await check('Love Spot', async () => { await page.getByRole('button', { name: 'Love Spot', exact: true }).click(); await page.locator('.excalidraw canvas').first().waitFor(); });
      await f.open('chat-a');
      await check('side panel empty', () => page.getByRole('button', { name: 'Show side panel', exact: true }).click());
      await check('side panel Browser', async () => { await page.getByRole('button', { name: 'New side panel tab', exact: true }).click(); await page.getByRole('menuitem', { name: 'Browser tab', exact: true }).click(); });
      for (const name of ['Files', 'Changes', 'Terminal']) {
        await check(`side panel ${name}`, async () => {
          await page.getByRole('button', { name: 'New side panel tab', exact: true }).click();
          await page.getByRole('menuitem', { name, exact: true }).click();
        });
      }
      await check('side panel full view', () => page.getByRole('button', { name: 'Enter full view', exact: true }).click());
      await check('side panel split view', () => page.getByRole('button', { name: 'Exit full view', exact: true }).click());
      await page.getByRole('button', { name: 'Close side panel', exact: true }).click();
      await check('split session', async () => {
        await page.locator('.thread-row[data-thread-id="chat-b"]').click({ button: 'right' });
        await (await threadMenuItem(page, 'Open session in split view')).click();
        await page.frameLocator('iframe[title="Split session"]').getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor();
        await page.frameLocator('iframe[title="Split session"]').getByRole('heading', { name: 'Write the docs', exact: true }).waitFor();
        await page.frameLocator('iframe[title="Split session"]').locator('.startup-splash').waitFor({ state: 'detached' });
      });
      const secondary = page.frameLocator('iframe[title="Split session"]');
      await check('split session secondary', async () => {}, () => secondary.locator('body'));
      await secondary.getByRole('button', { name: 'Close split view', exact: true }).click();
      assert.deepEqual(f.errors, [], 'no renderer exceptions');
      assert.deepEqual(consoleErrors, [], 'no console errors');
    } finally {
      await fs.writeFile(`${directory}/${colorScheme}-${width}-report.json`, JSON.stringify({ visited, failures, errors: f.errors, consoleErrors }, null, 2));
      t.diagnostic(`${visited.length} views checked; ${failures.length} views failed; evidence: ${directory}/${colorScheme}-${width}-report.json`);
      await f.close();
    }
    assert.deepEqual(failures, [], 'every visited view fits and responds');
  });
}
