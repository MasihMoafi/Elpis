const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');

const PAGES = ['Models & accounts', 'Configuration', 'Personalization', 'MCP servers', 'Voice', 'Git', 'Worktrees', 'Hooks', 'General', 'Notifications', 'Appearance', 'Keyboard shortcuts', 'Usage & limits', 'Archived chats', 'About'];
const SECTIONS = ['Models & accounts', 'Permissions & behavior', 'Context & maintenance', 'Connections & coding', 'App & terminal', 'Advanced'];
const settings = { version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null }, providers: [{ id: 'openai', displayName: 'OpenAI' }],
  smartPrune: { enabled: true, explicitOverride: { available: true, model: null, provider: null, version: 'p1' } }, memory: { enabled: false, generate: null, use: null, skipExternalContext: null, extractionModel: null, consolidationModel: null },
  options: { defaultPermissions: 'full', webSearch: null, verbosity: null, reasoningSummary: null, serviceTier: null, developerInstructions: null, projectRootMarkers: null, worktreeRoot: null },
  managed: { allowedApprovalPolicies: null, allowedSandboxModes: ['read-only', 'workspace-write'] }, write: { available: true } };

async function settingsFixture(theme = 'light', extra = {}) {
  const app = await fixture({ width: 1600, height: 1000, colorScheme: theme, storage: { 'elpis-theme': theme }, ...extra, routes: {
    '/api/settings': () => settings,
    '/api/mcp': () => ({ version: 'm1', configPath: '/tmp/elpis/config.toml', write: { available: true }, servers: [{ name: 'whispertype', enabled: true, transport: 'stdio', command: 'whispertype-mcp', credentials: [], whispertype: { backend: 'openrouter', model: null } }] }),
    '/api/tools/transcription': () => ({ available: true, backend: 'openrouter', label: 'OpenRouter' }),
    '/api/hooks': () => ({ version: 'h1', write: { available: true }, warnings: [], errors: [], hooks: [{ key: 'k', event: 'preToolUse', handler: 'command', command: 'rtk hook claude', matcher: '^Bash$', timeoutSec: 5, source: 'user', sourcePath: '/tmp/elpis/hooks.json', enabled: true, managed: false, trust: 'untrusted' }] }),
    '/api/providers': () => ({ openai: { auth: { state: 'signedOut' }, usage: [], usageError: null }, claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [], local: [] }),
    '/api/providers/settings': () => ({ version: 'p1', configPath: null, write: { available: true }, managed: { modelProvider: null }, providers: [] }),
    '/api/providers/claude-accounts': () => ({ accounts: [], selected: null }),
    '/api/threads': (_, url) => ({ data: url.searchParams.get('archived') === 'true' ? [0, 1, 2].map(i => ({ id: `archive-${i}`, name: i === 1 ? 'A long archived conversation title '.repeat(6) : `Archived chat ${i + 1}`, cwd: '/tmp/settings-audit', status: { type: 'idle' }, archived: true, archivedAt: 1700000000000, archiveReason: 'Archived by you', agentNickname: i === 2 ? 'Aster' : null })) : [{ id: 'chat-a', name: 'Fix the parser', cwd: '/tmp/parity-fixture', status: { type: 'idle' } }], nextCursor: null }),
    ...extra.routes,
  } });
  await openSettings(app.page);
  return app;
}

async function visit(page, name, section = false) {
  await (section ? page.locator('.settings-section-link').getByText(name, { exact: true }) : page.getByRole('tab', { name, exact: true })).click();
  await page.locator('.settings-page-header h2').filter({ visible: true }).waitFor();
  await page.locator('.settings-page').evaluate(async () => { await document.fonts.ready; });
  await page.waitForTimeout(120);
}

async function captureSettings(page, directory, name) {
  await fs.mkdir(directory, { recursive: true });
  const pane = page.locator('.settings-page');
  await pane.evaluate(el => { el.scrollTop = 0; });
  let index = 0;
  for (;;) {
    await pane.screenshot({ path: path.join(directory, `${name}${index ? `-scroll-${index + 1}` : ''}.png`) });
    const more = await pane.evaluate(el => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return false;
      el.scrollTop += el.clientHeight * 0.8; return true;
    });
    if (!more) break;
    index++;
  }
  await pane.evaluate(el => { el.scrollTop = 0; });
}

// Read rendered geometry and computed styles, including elements below the scroll fold.
function measureRows() {
  const pane = document.querySelector('.settings-page');
  // Inputs inside a closed <details> can have rectangles without being painted.
  const visible = element => element.checkVisibility();
  const shared = element => /^components\/settings\/rows\.tsx#(?:SettingRow|SettingsActions|RowFrame)$/.test(element?.dataset.elpisSource ?? '');
  const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
  const type = element => { const s = getComputedStyle(element); return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, color: s.color }; };
  const baseline = element => { const probe = document.createElement('span'); probe.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline'; element.append(probe); const y = probe.getBoundingClientRect().y; probe.remove(); return y; };
  const rows = [...pane.querySelectorAll('.settings-row')].filter(visible).map(row => {
    const title = row.querySelector('.settings-row-title'), description = row.querySelector('.settings-row-description'), scope = row.querySelector('.settings-scope');
    const control = row.querySelector('.settings-row-control'), style = getComputedStyle(row), rect = box(row);
    const controls = [...(control?.querySelectorAll('[data-slot="button"], [data-slot="select-trigger"], [data-slot="input"], [data-slot="switch"], [data-slot="segment"]') ?? [])].filter(visible).map(element => ({ slot: element.dataset.slot, size: element.dataset.size, text: element.textContent.trim(), ...type(element), ...box(element), centreOffset: box(element).y + box(element).height / 2 - (rect.y + rect.height / 2) }));
    const disclosure = control?.querySelector('details');
    const controlBox = control && box(disclosure?.closest('[role="group"]') ?? control);
    const multilineControl = Boolean(disclosure);
    return { title: title?.textContent, shared: shared(row), actions: row.classList.contains('settings-actions'), stacked: row.classList.contains('stacked'), controlBox, multilineControl, ...rect,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], titleStyle: title && type(title), titleBox: title && box(title), descriptionStyle: description && type(description), descriptionBox: description && box(description), scopeStyle: scope && type(scope), baselineOffset: scope && title ? baseline(scope) - baseline(title) : null, controls };
  });
  return { pane: box(pane), rows, headers: [...pane.querySelectorAll('.settings-group-heading h3')].filter(visible).map(el => ({ text: el.textContent, ...type(el), ...box(el) })),
    pageHeader: [...pane.querySelectorAll('.settings-page-header')].filter(visible).map(box),
    orphanParts: [...pane.querySelectorAll('.settings-row-title, .settings-row-description, .settings-row-control, .settings-rows:not(.settings-empty) button, .settings-rows:not(.settings-empty) input, .settings-rows:not(.settings-empty) [role="combobox"]')].filter(visible).filter(el => !shared(el.closest('.settings-row'))).map(el => el.className),
    scrolls: document.documentElement.scrollWidth > innerWidth + 1 };
}

function violations(pages) {
  const problems = [], titles = new Map(), descriptions = new Map(), controls = new Map(), headers = new Map(), widths = new Map();
  const compare = (map, key, value, where) => { const saved = map.get(key); if (saved && saved.value !== value) problems.push(`${where}: ${key} ${value}, expected ${saved.value} (${saved.where})`); else if (!saved) map.set(key, { value, where }); };
  for (const { name, measurement: m } of pages) {
    if (m.scrolls) problems.push(`${name}: horizontal overflow`);
    if (m.orphanParts.length) problems.push(`${name}: row parts outside shared component: ${m.orphanParts.join(', ')}`);
    for (const h of m.pageHeader) compare(widths, 'page width', h.width, name);
    for (const h of m.headers) for (const key of ['fontSize', 'fontWeight', 'lineHeight']) compare(headers, key, h[key], `${name} section ${h.text}`);
    for (const row of m.rows) {
      const where = `${name} / ${row.title ?? 'actions'}`;
      if (!row.shared) problems.push(`${where}: outside shared component`);
      if (row.actions) continue;
      for (const key of ['fontSize', 'fontWeight', 'lineHeight', 'color']) {
        if (row.titleStyle) compare(titles, key, row.titleStyle[key], where);
        if (row.descriptionStyle) compare(descriptions, key, row.descriptionStyle[key], where);
      }
      if (row.titleStyle && row.descriptionStyle && parseFloat(row.titleStyle.fontSize) <= parseFloat(row.descriptionStyle.fontSize)) problems.push(`${where}: title/description hierarchy`);
      if (row.baselineOffset !== null && Math.abs(row.baselineOffset) > 0.5) problems.push(`${where}: scope baseline ${row.baselineOffset}`);
      compare(titles, 'row padding', row.padding.join(' '), where);
      if (!row.stacked && !row.multilineControl && row.titleBox && (!row.descriptionBox || row.descriptionBox.height < 20) && row.titleBox.height < 22) compare(titles, 'single-line row height', row.height, where);
      if (row.controlBox) {
        const group = row.controlBox;
        if (!row.stacked && Math.abs(group.y + group.height / 2 - row.y - row.height / 2) > 0.6) problems.push(`${where}: control group off centre`);
        if (group.y < row.y - 1 || group.bottom > row.bottom + 1) problems.push(`${where}: clipped control group`);
        if (row.multilineControl && row.controls.length && Math.abs(row.controls[0].y - group.y) > 0.6) problems.push(`${where}: leading control off top`);
      }
      for (const control of row.controls) {
        // Switches and icon actions retain their semantic shape; labelled buttons, selects and fields share a size.
        const kind = control.slot === 'switch' || control.slot === 'segment' || control.size?.startsWith('icon') ? `${control.slot}/${control.size}` : 'labelled control';
        for (const key of ['fontSize', 'height']) compare(controls, `${kind} ${key}`, control[key], where);
        if (!row.stacked && !row.multilineControl && Math.abs(control.centreOffset) > 0.6) problems.push(`${where}: ${control.text || control.slot} off centre ${control.centreOffset}`);
        if (control.y < row.y - 1 || control.bottom > row.bottom + 1) problems.push(`${where}: vertically clipped control`);
        if (control.right > Math.min(row.right, m.pane.right) + 1 || control.x < row.x - 1) problems.push(`${where}: clipped control`);
      }
    }
  }
  return problems;
}

module.exports = { PAGES, SECTIONS, settingsFixture, visit, captureSettings, measureRows, violations };
