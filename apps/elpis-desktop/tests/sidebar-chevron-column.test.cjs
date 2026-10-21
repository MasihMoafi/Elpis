// V1 / R5, R23, R24: measure the shipped renderer, never substitute DOM or CSS in the test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');

const shots = process.env.ELPIS_PARITY_SHOTS;
const chat = (id, name, extra = {}) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai',
  status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, ...extra });
const owners = [chat('chat-a', 'Didar — latest build and chat visibility'), chat('chat-d', 'Another project chat'), chat('chat-e', 'Plain list chat with agents')];
const plain = chat('chat-b', 'Chat without agents');
const threads = [plain, ...owners, ...owners.flatMap(owner => [
  chat(`${owner.id}-ramanujan`, 'Ramanujan — a long agent name that must remain inside the sidebar', { parentThreadId: owner.id }),
  chat(`${owner.id}-galileo`, 'Galileo', { parentThreadId: owner.id }),
])];
const routes = { '/api/threads': (_body, url) => ({ data: url.searchParams.get('archived') === 'true' ? []
  : url.searchParams.has('ancestorThreadId') ? threads.filter(thread => thread.parentThreadId === url.searchParams.get('ancestorThreadId'))
  : threads, nextCursor: null }) };
for (const thread of threads) {
  routes[`/api/threads/${thread.id}`] = () => ({ thread, data: [], nextCursor: null });
  routes[`/api/threads/${thread.id}/resume`] = () => ({ thread, activeTurnId: null });
}

// Also used by sidebar-chevron-real.cjs against a packaged app and its real bridge.
async function measure(row, projectChevron) {
  const project = await projectChevron.boundingBox();
  return row.evaluate((element, project) => {
    const box = element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height, center: x + width / 2, right: x + width };
    };
    const toggle = element.querySelector(':scope > button[aria-expanded]');
    const rail = getComputedStyle(element, '::before'), bounds = element.getBoundingClientRect();
    const clips = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (getComputedStyle(ancestor).overflowX !== 'visible') clips.push(ancestor.getBoundingClientRect().left);
    }
    const svg = toggle.querySelector('svg'), path = svg.querySelector('path');
    const matrix = svg.getScreenCTM();
    const stroke = parseFloat(getComputedStyle(path).strokeWidth) * Math.hypot(matrix.a, matrix.b) / 2;
    return { project: { ...project, center: project.x + project.width / 2 }, icon: box(svg), target: box(toggle),
      inkRight: box(path).right + Math.abs(stroke),
      rail: { x: bounds.x + (parseFloat(rail.left) || 0), width: parseFloat(rail.width) || 0, shown: rail.content !== 'none' },
      circle: box(element.querySelector('.thread-dot')).x, title: box(element.querySelector('.thread-title')).x,
      actions: box(element.querySelector('.thread-actions')).x, rowX: bounds.x,
      clipLeft: Math.max(...clips), expanded: toggle.getAttribute('aria-expanded'), hoverLabel: toggle.title };
  }, project);
}

function check(actual, label, inProject) {
  if (inProject) assert.ok(Math.abs(actual.icon.center - actual.project.center) <= 0.5,
    `${label}: chat chevron center ${actual.icon.center}px != project ${actual.project.center}px (±0.5px)`);
  else assert.equal(actual.icon.center, actual.rowX - 4, `${label}: plain-list chevrons share one gutter`);
  assert.ok(actual.icon.right <= actual.rail.x, `${label}: chevron box must not overlap the active rail: ${JSON.stringify(actual)}`);
  assert.ok(actual.rail.x - actual.inkRight >= 0.5, `${label}: drawn caret must have a clear gap before the active rail`);
  assert.ok(actual.icon.x >= actual.clipLeft, `${label}: chevron must not be clipped`);
  assert.equal(actual.hoverLabel.startsWith(actual.expanded === 'true' ? 'Collapse agents in ' : 'Expand agents in '), true, `${label}: hover label`);
}

async function capture(page, name, group) {
  if (!shots) return;
  await fs.mkdir(shots, { recursive: true });
  const sidebar = await page.locator('aside.sidebar').boundingBox(), spot = await group.boundingBox();
  await page.screenshot({ path: path.join(shots, `${name}.png`), clip: { x: sidebar.x, y: spot.y, width: sidebar.width, height: spot.height } });
}

// Requiring the measurement helpers from the real-app runner must not register mock tests.
if (require.main === module) for (const colorScheme of ['light', 'dark']) test(`V1 shared chevron column and rail gap (${colorScheme})`, async () => {
  const f = await fixture({ routes, colorScheme, height: 1100, staticDir: process.env.ELPIS_RENDERER_OUT,
    storage: {
      'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'match', name: 'match-project', cwd: CWD }, { id: 'second', name: 'Second project', cwd: CWD }], selectedId: null }),
      'elpis-project-chats-v1': JSON.stringify({ 'chat-a': 'match', 'chat-b': 'match', 'chat-d': 'second' }),
    } }), { page } = f;
  const measured = [];
  const row = id => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`);
  const group = page.locator('.project-group').filter({ has: page.getByRole('button', { name: 'match-project', exact: true }) });
  const projectChevron = group.locator('.sidebar-group-chevron');
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    for (const owner of owners) {
      const current = row(owner.id), toggle = current.getByRole('button', { name: /agents in/ });
      const inProject = owner.id !== 'chat-e';
      const parentChevron = owner.id === 'chat-d' ? page.locator('.project-group').filter({ has: page.getByRole('button', { name: 'Second project', exact: true }) }).locator('.sidebar-group-chevron') : projectChevron;
      await current.locator('.thread-link').hover();
      const unchanged = await measure(current, parentChevron);
      assert.equal(unchanged.circle, unchanged.rowX + 8, 'chat circle retains the plain-row alignment');
      assert.equal(unchanged.title, unchanged.rowX + 29, 'chat title retains the plain-row alignment');
      await toggle.click();
      const initialAgent = await row(`${owner.id}-ramanujan`).locator('.thread-dot').boundingBox();
      const originalIndent = initialAgent.x - unchanged.circle;
      await toggle.click();
      for (const selected of [false, true]) {
        await row(selected ? owner.id : plain.id).locator('.thread-link').click();
        for (const expanded of [false, true]) {
          if ((await toggle.getAttribute('aria-expanded') === 'true') !== expanded) await toggle.click();
          if (expanded) await row(`${owner.id}-ramanujan`).waitFor();
          await current.locator('.thread-link').hover();
          const label = `${owner.id} ${selected ? 'selected' : 'unselected'} ${expanded ? 'expanded' : 'collapsed'}`;
          const actual = await measure(current, parentChevron);
          measured.push({ label, inProject, ...actual });
          for (const key of ['circle', 'title', 'actions']) assert.equal(actual[key], unchanged[key], `${label}: ${key} stays in place`);
          if (expanded) {
            const child = await row(`${owner.id}-ramanujan`).locator('.thread-dot').boundingBox();
            assert.equal(child.x - actual.circle, originalIndent, `${label}: agents keep their original indentation`);
            measured.at(-1).agentIndent = child.x - actual.circle;
          }
          if (owner.id === 'chat-a' && selected) {
            await page.mouse.move(700, 60);
            await capture(page, `v1-${colorScheme}-${expanded ? 'expanded' : 'collapsed'}`, group);
          }
        }
      }
    }
    await page.reload();
    await row(owners[0].id).waitFor();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    measured.push({ label: 'after reload', inProject: true, ...await measure(row(owners[0].id), projectChevron) });
    if (shots) await fs.writeFile(path.join(shots, `v1-${colorScheme}-boxes.json`), JSON.stringify(measured, null, 2));
    for (const actual of measured) {
      check(actual, actual.label, actual.inProject);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

module.exports = { measure, check };
