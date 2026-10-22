// The HUD language (app/globals.css, "The HUD language"; components/ui/*), measured on the rendered app in both themes:
// one chamfer per role (controls 7px or 4px, panels and floating surfaces 10px, top-left and bottom-right, bevelled),
// one edge colour per role, one HUD label type, the send button sharing the control cuts, and AA contrast for every text on the way.
// Mock bridge (tests/parity-fixture.cjs); no engine, no model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings, leaveSettings } = require('./controls.cjs');

const WORK = [
  { id: 'w1', type: 'commandExecution', command: 'npm test -- parser', status: 'completed', exitCode: 0, aggregatedOutput: '12 tests passed', durationMs: 2400 },
  { id: 'w2', type: 'fileChange', status: 'completed', changes: [{ path: 'src/lib/parser.ts', kind: { type: 'update' }, diff: '-a\n+b' }] },
];
const CHAT = [['t1', 'Run the parser tests.', 'All twelve tests pass.', WORK]];
const skill = (name, scope) => ({ id: name, name, description: `Does ${name}`, path: `/home/u/.elpis-next/skills/${name}/SKILL.md`, scope, enabled: true, plugin: null });
const ROUTES = {
  '/api/settings': () => ({ main: { model: 'sol', provider: 'openai' }, background: {}, providers: [{ id: 'openai', displayName: 'OpenAI' }], smartPrune: { enabled: false, explicitOverride: {} }, memory: {}, write: { available: false, reason: '' }, agents: { graph: 256, atOnce: 4, source: 'agents.max_threads' } }),
  '/api/folders': () => ({ data: ['src', 'tests'] }),
  '/api/customize': () => ({ skills: { data: [skill('pdf', 'system'), skill('web-dev', 'user')], errors: [] }, plugins: { data: [] }, connectors: { data: [] } }),
};
/** Every small uppercase label in the app (the HUD label role). "Worked for 5s" is a caption, not a label: its time units
 * stay lowercase (tests/desktop-polish.test.cjs). */
const LABELS = '.hud-label, .hud-menu-title, .section-label, .plan-card-heading, .canvas-toolbar-label, .canvas-hud span, .canvas-order li span, .canvas-critical span, .quick-add-crumb, .canvas-template-loaded, .agent-node-kind';
const PANELS = '.settings-rows, .settings-card, .customize-list, .step-card, .decision-card, .plan-card, .file-card, .task-list, .agent-conversation-group, .agent-node, .composer';
const FLOATING = '.hud-menu, .hud-popover, .hud-dialog';
const { contrastFailures } = require('./hud-contrast.cjs');

/** The page's view of each role, with the tokens resolved where the elements are. */
const measure = page => page.evaluate(({ LABELS, PANELS, FLOATING }) => {
  const shown = element => { const box = element.getBoundingClientRect(); return box.width > 1 && box.height > 1 && getComputedStyle(element).visibility !== 'hidden'; };
  // Colours compared as sRGB, so oklch, oklab and rgb spellings of one colour agree.
  const pen = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const srgb = value => { pen.clearRect(0, 0, 1, 1); pen.fillStyle = '#000'; pen.fillStyle = value; pen.fillRect(0, 0, 1, 1); return [...pen.getImageData(0, 0, 1, 1).data].join(','); };
  const token = (name, property = 'color') => { const probe = document.createElement('i'); probe.style.setProperty(property, `var(${name})`); document.querySelector('.app-shell').append(probe); const value = getComputedStyle(probe)[property]; probe.remove(); return srgb(value); };
  const name = element => `${element.tagName.toLowerCase()}.${[...element.classList].filter(c => !/[:[]/.test(c)).slice(0, 2).join('.')}${element.getAttribute('aria-label') ? `[${element.getAttribute('aria-label')}]` : ''}`;
  const corner = element => { const s = getComputedStyle(element); return { tl: s.borderTopLeftRadius, tr: s.borderTopRightRadius, br: s.borderBottomRightRadius, bl: s.borderBottomLeftRadius, shape: s.cornerTopLeftShape, shapeBr: s.cornerBottomRightShape, edge: srgb(s.borderTopColor), width: s.borderTopWidth }; };
  const all = selector => [...document.querySelectorAll(selector)].filter(shown);
  return {
    tokens: { border: token('--border'), hudEdge: token('--hud-edge'), muted: token('--muted-foreground'), primary: token('--primary') },
    buttons: all('[data-slot="button"]').map(element => ({ name: name(element), send: element.classList.contains('send-button'), xs: /\b(?:h-6|size-6)\b/.test(element.className), ...corner(element) })),
    panels: all(PANELS).map(element => ({ name: name(element), ...corner(element) })),
    floating: all(FLOATING).map(element => ({ name: name(element), ...corner(element) })),
    // Section headers: an accent tick, the title, a hairline running to the actions.
    sections: all('.settings-group-heading, .customize-title').map(element => { const title = element.querySelector(':scope > h2, :scope > h3'), tick = getComputedStyle(element, '::before'), rule = getComputedStyle(element, '::after'), type = title && getComputedStyle(title);
      return { name: name(element), title: title?.textContent, type: type && `${type.fontSize} ${type.fontWeight} ${type.textTransform}`, tick: `${tick.width} ${srgb(tick.backgroundColor)}`, rule: `${rule.height} ${srgb(rule.backgroundColor)} ${rule.flexGrow}` }; }),
    hairline: token('--hairline'),
    labels: all(LABELS).map(element => { const s = getComputedStyle(element); return { name: name(element), type: [s.fontFamily.split(',')[0], s.fontSize, s.fontWeight, s.letterSpacing, s.textTransform].join(' '), color: srgb(s.color) }; }),
  };
}, { LABELS, PANELS, FLOATING });

const BEVEL = /bevel|superellipse\(0\)/;
function corners(report, where, seen) {
  const { tokens } = report;
  for (const button of report.buttons) {
    const cut = button.xs ? '4px' : '7px';
    assert.deepEqual([button.tl, button.tr, button.br, button.bl], [cut, '0px', cut, '0px'], `${where}: ${button.name} is chamfered top-left and bottom-right by ${cut}`);
    assert.match(button.shape, BEVEL, `${where}: ${button.name} is bevelled`); assert.match(button.shapeBr, BEVEL);
    seen.buttons++;
  }
  for (const panel of report.panels) {
    assert.deepEqual([panel.tl, panel.tr, panel.br, panel.bl], ['10px', '0px', '10px', '0px'], `${where}: ${panel.name} is a panel chamfered by 10px`);
    assert.match(panel.shape, BEVEL, `${where}: ${panel.name} is bevelled`);
    assert.equal(panel.edge, panel.name.includes('composer') ? tokens.hudEdge : tokens.border, `${where}: ${panel.name} has its role's edge`);
    seen.panels.add(panel.name.split('[')[0]);
  }
  for (const surface of report.floating) {
    assert.deepEqual([surface.tl, surface.tr, surface.br, surface.bl], ['10px', '0px', '10px', '0px'], `${where}: ${surface.name} is chamfered by 10px`);
    assert.match(surface.shape, BEVEL, `${where}: ${surface.name} is bevelled`);
    assert.equal(surface.edge, tokens.hudEdge, `${where}: ${surface.name} has the accented edge`);
    seen.floating++;
  }
}
function labels(report, where, seen) {
  const { tokens } = report;
  for (const label of report.labels) {
    assert.match(label.type, /^"?JetBrains Mono"? 12px 500 1\.68px uppercase$/, `${where}: ${label.name} is the HUD label (${label.type})`);
    assert.ok([tokens.muted, tokens.primary].includes(label.color), `${where}: ${label.name} is muted or accent (${label.color})`);
    seen.labels.add(label.name.split('[')[0]);
  }
}

for (const colorScheme of ['dark', 'light']) test(`one HUD language on the chat, its menus and dialogs, Settings, Customize and the flat canvas (${colorScheme})`, async t => {
  const f = await fixture({ width: 1280, height: 800, colorScheme, chat: CHAT, routes: ROUTES });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  const { page } = f, reports = [], low = [];
  // Measured at rest: hover and focus transitions (.15s at most) have settled.
  const visit = async where => { await page.waitForTimeout(250); reports.push([where, await measure(page)]); low.push(...(await page.evaluate(contrastFailures)).map(item => `${where}: ${item}`)); };
  await f.open('chat-a');
  // Unfold the finished work and its group; its first step opens with it, so a step card is on screen.
  for (const fold of await page.locator('.worked-for > summary').all()) await fold.click();
  const group = page.locator('.activity-group > summary').first(); if (await group.count()) await group.click();
  await page.locator('.step-card').first().waitFor();
  await visit('chat');
  await page.getByRole('button', { name: 'Change permissions' }).click(); await page.getByRole('menu').waitFor();
  await visit('permissions menu'); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Alt+r'); await page.locator('.hud-dialog').waitFor();
  await visit('rename dialog'); await page.keyboard.press('Escape'); await page.locator('.hud-dialog').waitFor({ state: 'detached' });
  await openSettings(page); await page.getByRole('tab', { name: 'General', exact: true }).waitFor(); await page.locator('.settings-rows').first().waitFor();
  await visit('Settings'); await leaveSettings(page);
  await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click(); await page.getByText('web-dev', { exact: true }).waitFor();
  await visit('Customize');
  await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click(); await page.locator('.react-flow__node-agent').first().waitFor();
  await visit('canvas');
  await t.test('one chamfer and one edge per role; the send button shares the control cuts', () => {
    const seen = { buttons: 0, floating: 0, panels: new Set() };
    for (const [where, report] of reports) corners(report, where, seen);
    assert.ok(seen.buttons >= 20, `buttons measured: ${seen.buttons}`);
    assert.ok(seen.floating >= 2, `menus and dialogs measured: ${seen.floating}`);
    for (const panel of ['div.step-card', 'form.composer', 'div.settings-rows', 'ul.customize-list', 'div.agent-node']) assert.ok([...seen.panels].some(name => name.startsWith(panel)), `${panel} measured (${[...seen.panels]})`);
  });
  await t.test('one HUD label type', () => {
    const seen = { labels: new Set() };
    for (const [where, report] of reports) labels(report, where, seen);
    for (const label of ['div.section-label', 'p.hud-menu-title', 'span.agent-node-kind', 'span.canvas-toolbar-label']) assert.ok([...seen.labels].some(name => name.startsWith(label)), `${label} measured (${[...seen.labels]})`);
  });
  await t.test('one section header: tick, title, hairline', () => {
    let count = 0;
    for (const [where, report] of reports) for (const section of report.sections.filter(item => item.title)) {
      assert.equal(section.type, '14px 600 none', `${where}: ${section.name} "${section.title}" title`);
      assert.equal(section.tick, `3px ${report.tokens.primary}`, `${where}: ${section.name} has the accent tick`);
      assert.equal(section.rule, `1px ${report.hairline} 1`, `${where}: ${section.name} has the hairline`);
      count++;
    }
    assert.ok(count >= 3, `section headers measured: ${count}`);
  });
  await t.test('every text meets WCAG AA against its own background', () => assert.deepEqual(low, []));
});
