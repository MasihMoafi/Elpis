// V1b / R5, R23, R24: measure the exported renderer; no DOM or CSS overrides.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');

const shots = process.env.ELPIS_PARITY_SHOTS;
const chat = (id, name, extra = {}) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai',
  status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, ...extra });
const owners = [chat('chat-a', 'Didar — project chat with agents'), chat('pinned-agents', 'h2 — Elpis fixes (continued)'),
  chat('plain-agents', 'Plain list chat with agents'), chat('group-agents', 'Group chat with agents')];
const plain = chat('pinned-plain', 'Elpis — two Claude accounts');
const threads = [...owners, plain, chat('project-plain', 'Project chat without agents'), chat('plain-last', 'Last plain chat'),
  ...owners.flatMap(owner => [chat(`${owner.id}-child`, 'Ramanujan — a long agent name that must remain inside the sidebar', { parentThreadId: owner.id }),
    chat(`${owner.id}-leaf`, 'Galileo', { parentThreadId: owner.id })]),
  chat('nested-agent', 'Nested agent', { parentThreadId: 'chat-a-child' })];
const routes = { '/api/threads': (_body, url) => ({ data: url.searchParams.get('archived') === 'true' ? []
  : url.searchParams.has('ancestorThreadId') ? threads.filter(thread => thread.parentThreadId === url.searchParams.get('ancestorThreadId'))
  : threads, nextCursor: null }) };
for (const thread of threads) {
  routes[`/api/threads/${thread.id}`] = () => ({ thread, data: [], nextCursor: null });
  routes[`/api/threads/${thread.id}/resume`] = () => ({ thread, activeTurnId: null });
}

// Shared with the real-bridge acceptance runner. All positions come from the actual renderer.
async function measureSidebar(page) {
  return page.locator('aside.sidebar').evaluate(sidebar => {
    const box = element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height, center: x + width / 2, right: x + width, bottom: y + height };
    };
    const project = box(sidebar.querySelector('.project-row .sidebar-group-chevron'));
    const headers = [...sidebar.querySelectorAll('.sidebar-group-chevron')].map(icon => ({
      name: icon.closest('.sidebar-group').getAttribute('aria-label'), icon: box(icon), target: box(icon.closest('button')),
    }));
    const rows = [...sidebar.querySelectorAll('.thread-list .thread-row')].filter(row => row.querySelector(':scope > .conversation-colour-trigger')).map(row => {
      const toggle = row.querySelector(':scope > button[aria-expanded]:first-child:not(.conversation-colour-trigger)');
      const railStyle = getComputedStyle(row, '::before'), bounds = box(row), clips = [];
      for (let ancestor = row.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).overflowX !== 'visible') clips.push(box(ancestor));
      }
      return { id: row.dataset.threadId, depth: (() => { let depth = 0, branch = row.parentElement; while (branch.parentElement?.firstElementChild?.matches('.thread-row')) { depth++; branch = branch.parentElement; } return depth; })(), row: bounds,
        circle: box(row.querySelector('.conversation-colour-trigger .conversation-colour-swatch')), title: box(row.querySelector('.agent-identity, .thread-title')),
        actions: box(row.querySelector('.thread-actions')), active: row.classList.contains('active'), selected: row.classList.contains('selected'),
        clipLeft: Math.max(...clips.map(clip => clip.x)), clipRight: Math.min(...clips.map(clip => clip.right)),
        rail: { x: bounds.x + (parseFloat(railStyle.left) || 0), width: parseFloat(railStyle.width) || 0, shown: railStyle.content !== 'none' },
        ...(toggle ? { icon: box(toggle.querySelector('svg')), target: box(toggle), expanded: toggle.getAttribute('aria-expanded'), hoverLabel: toggle.title } : {}) };
    });
    const reference = sidebar.querySelector('.project-group .thread-row:not(.child) .conversation-colour-trigger').closest('.thread-row');
    return { project, headers, rows, emptyLabels: [...sidebar.querySelectorAll('.sidebar-group-empty')].map(element => ({ x: box(element).x + parseFloat(getComputedStyle(element).paddingLeft) })),
      circle: box(reference.querySelector('.conversation-colour-trigger .conversation-colour-swatch')).x, title: box(reference.querySelector('.thread-title')).x };
  });
}
function checkSidebar(actual, label) {
  const near = (value, expected, message) => assert.ok(Math.abs(value - expected) <= 0.5,
    `${label}: ${message}: ${value}px != ${expected}px (±0.5px)`);
  for (const header of actual.headers) near(header.icon.center, actual.project.center, `${header.name} chevron center`);
  near(actual.circle, actual.project.center + 13, 'project conversation colour column');
  near(actual.title, actual.project.center + 37.5, 'project name column after its colour control');
  for (const empty of actual.emptyLabels) near(empty.x, actual.circle, 'empty group label inset');
  for (const row of actual.rows) {
    const name = `${row.id} depth ${row.depth}`;
    if (row.icon) near(row.icon.center, actual.project.center + row.depth * 14, `${name} chevron center within its generation`);
    near(row.circle.x, actual.circle + row.depth * 14, `${name} circle column`);
    near(row.title.x, actual.title + row.depth * 14, `${name} identity/name column`);
    assert.ok(row.title.width > 0 && row.title.right <= row.actions.x + 0.5, `${label}: ${name} name fits before its actions`);
    assert.ok(row.circle.right + 4 <= row.title.x, `${label}: ${name} circle stays clear of text`);
    if (!row.icon) continue;
    assert.ok(row.target.right + 4 <= row.circle.x, `${label}: ${name} chevron target stays clear of circle and text`);
    assert.ok(row.target.x >= row.clipLeft && row.target.right <= row.clipRight, `${label}: ${name} chevron target is not clipped`);
    assert.ok(row.target.width >= 12 && row.target.height >= 24, `${label}: ${name} keeps its click target`);
    if (row.rail.shown) assert.ok(row.target.x - (row.rail.x + row.rail.width) >= 0.5,
      `${label}: ${name} active bar has a clear gap from the entire chevron target`);
    assert.equal(row.hoverLabel.startsWith(row.expanded === 'true' ? 'Collapse agents in ' : 'Expand agents in '), true, `${label}: ${name} hover label`);
  }
}
async function capture(page, directory, name) {
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  await page.mouse.move(700, 60);
  await page.locator('aside.sidebar').screenshot({ path: path.join(directory, `${name}.png`) });
}

if (require.main === module) for (const colorScheme of ['light', 'dark']) test(`V1b one sidebar column across Projects, Pinned, Groups and Recents (${colorScheme})`, async () => {
  const f = await fixture({ routes, threads, colorScheme, height: 1440, staticDir: process.env.ELPIS_RENDERER_OUT,
    storage: {
      'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'match', name: 'match-making', cwd: CWD }, { id: 'empty', name: 'Empty project', cwd: CWD }], selectedId: null }),
      'elpis-project-chats-v1': JSON.stringify({ 'chat-a': 'match', 'project-plain': 'match' }),
      'elpis-pinned-chats-v1': JSON.stringify(['pinned-agents', plain.id]),
      'elpis-chat-groups-v1': JSON.stringify({ groups: [{ id: 'work', name: 'Work' }, { id: 'empty', name: 'Empty group' }], members: { 'group-agents': 'work' }, groupBy: 'custom', sortBy: 'recency', collapsed: [] }),
    } }), { page } = f;
  const row = id => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`);
  const measured = [];
  const record = async label => measured.push({ label, ...await measureSidebar(page) });
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    for (const [id, section] of [['chat-a', '.project-group'], ['pinned-agents', 'section[aria-label="Pinned"]'],
      [plain.id, 'section[aria-label="Pinned"]'], ['plain-agents', 'section[aria-label="Recents"]'], ['group-agents', '.chat-group']]) {
      assert.equal(await page.locator(`aside.sidebar ${section} .thread-row[data-thread-id="${id}"]`).count(), 1, `${id}: fixture covers ${section}`);
    }
    assert.equal(await row(plain.id).getByRole('button', { name: /agents in/ }).count(), 0, 'a pinned chat without agents reserves an empty column');
    await record('all collapsed');
    for (const owner of owners) {
      const current = row(owner.id), toggle = current.getByRole('button', { name: /agents in/ });
      for (const selected of [false, true]) {
        await row(selected ? owner.id : plain.id).locator('.thread-link').click();
        assert.equal(await current.evaluate(element => element.classList.contains('active')), selected);
        for (const expanded of [false, true]) {
          if ((await toggle.getAttribute('aria-expanded') === 'true') !== expanded) await toggle.click();
          if (expanded) await row(`${owner.id}-child`).waitFor();
          await current.locator('.thread-link').hover();
          await record(`${owner.id} ${selected ? 'selected' : 'unselected'} ${expanded ? 'expanded' : 'collapsed'} hovered`);
        }
      }
    }
    const nestedToggle = row('chat-a-child').getByRole('button', { name: /Expand agents in/ });
    await nestedToggle.focus();
    await nestedToggle.press('Space');
    await row('nested-agent').waitFor();
    await record('nested agent expanded with keyboard');
    await row(owners[0].id).locator('.thread-link').click();
    await page.keyboard.down('Control');
    try {
      for (const owner of owners.slice(1)) await row(owner.id).locator('.thread-link').click();
    } finally { await page.keyboard.up('Control'); }
    assert.equal(await page.locator('aside.sidebar .thread-row.selected').count(), owners.length, 'all four sections support multiselection');
    await record('multiselected across all four sections');
    await row('pinned-agents').locator('.thread-link').click();
    await capture(page, shots, `v1b-${colorScheme}-expanded`);
    await page.reload();
    await row('pinned-agents').waitFor();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await record('after reload');
    for (const selector of ['.chat-group[aria-label="Work"]', '.project-group[aria-label="Empty project"]', '.chat-group[aria-label="Empty group"]']) {
      const group = page.locator(`aside.sidebar ${selector}`), toggle = group.locator('.sidebar-group-toggle');
      if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
      await record(`${selector} collapsed`);
      await toggle.click();
      await record(`${selector} reopened`);
    }
    await row('pinned-agents').getByRole('button', { name: /agents in/ }).click();
    await record('pinned selected toggled after reload');
    await capture(page, shots, `v1b-${colorScheme}-reloaded`);
    if (shots) await fs.writeFile(path.join(shots, `v1b-${colorScheme}-boxes.json`), JSON.stringify(measured, null, 2));
    const failures = [];
    for (const actual of measured) {
      try { checkSidebar(actual, actual.label); } catch (error) { failures.push(error.message); }
    }
    assert.deepEqual(f.errors, []);
    assert.deepEqual(failures, [], 'all sidebar sections must use the project chevron, circle and name columns');
  } finally { await f.close(); }
});

module.exports = { measureSidebar, checkSidebar, capture };
