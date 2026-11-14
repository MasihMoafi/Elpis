// docs/specs/codebase-dashboard.md, D1 and D9: Observability has a Codebase page for a Git project his chats use.
// 11 Nov, Masih: "there was a dashboard I had asked for in elpis ... please see that to the end".
// 13 Nov: "it says no git and I couldn't find any git projects which is odd! ... bottons too close to each other".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');

const report = (name: string) => ({
  name, commit: 'abc1234', date: '2026-11-10',
  code: [{ k: 'src', v: 4200, d: '31 files' }, { k: 'tests', v: 900, d: '12 files' }],
  docs: [['docs', 4, 380]],
  churnFiles: [['src/app.ts', 300]],
  churnLog: [[new Date().toISOString().slice(0, 10), [[0, 620]]], ['2026-01-05', [[0, 40]]]],
  dups: [{ files: ['a.png', 'b.png'], bytes: 2048, kind: 'media' }],
  worktrees: [[`/work/${name}`, 120, 'main', '2026-11-10', 2]],
  pillars: [
    ['Documentation', [['A README', 1, 'README.md'], ['Agent instructions are in Git', 0, 'no AGENTS.md or CLAUDE.md in Git: a fresh clone has none']]],
    ['Testing', [['Tests exist', 1, '12 test files']]],
  ],
  changed: [{ check: 'A README', from: 0, to: 1 }],
  previous: '2026-11-01T10:00:00.000Z',
});
const PROJECTS = [{ root: '/work/demo', name: 'demo', usedAt: 3, committedAt: 1 }, { root: '/work/other', name: 'other', usedAt: 1, committedAt: 2 }];
/** The bridge's two Codebase routes; `current` is the project of the chat asked about. */
const routes = (projects: typeof PROJECTS, current: string | null) => ({
  '/api/codebase/projects': () => ({ projects, current }),
  '/api/codebase/report': (_body: unknown, url: URL) => {
    const project = projects.find(p => p.root === url.searchParams.get('root'));
    return project ? report(project.name) : { __http: 404, error: 'None of your chats works in this project.' };
  },
});
/** A control's left, right, top and height, in px. */
type Box = [number, number, number, number];
type Locator = {
  evaluate<T, A>(fn: (element: HTMLElement, arg: A) => T, arg: A): Promise<T>;
  locator(selector: string): Locator; first(): Locator; click(): Promise<void>; waitFor(): Promise<void>;
  filter(options: object): Locator; getByRole(role: string, options?: object): Locator;
};
type Page = { locator(selector: string): Locator; getByRole(role: string, options?: object): Locator; frameLocator(selector: string): Locator };
async function openCodebase(page: Page) {
  await page.locator('aside.sidebar .thread-row').first().click();
  await page.locator('.nav-list').getByRole('button', { name: 'Observability', exact: true }).click();
  await page.getByRole('radio', { name: 'Codebase', exact: true }).click();
}
/** The boxes of the controls `selector` finds inside a row, in page order. */
const boxes = (row: Locator, selector: string): Promise<Box[]> =>
  row.evaluate((element: HTMLElement, found: string) => [...element.querySelectorAll(found)].map(control => {
    const b = control.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.right), Math.round(b.top), Math.round(b.height)] as Box;
  }), selector);
const heading = (page: Page, text: string | RegExp) =>
  page.frameLocator('iframe[title="Codebase"]').getByRole('heading', { level: 1 }).filter({ hasText: text });

test('Observability shows the project of the chosen chat: code, churn for chosen dates and readiness with its evidence', async () => {
  const f = await fixture({ width: 1300, height: 850, routes: routes(PROJECTS, '/work/demo') });
  try {
    const { page } = f;
    await openCodebase(page);
    const frame = page.frameLocator('iframe[title="Codebase"]');
    await heading(page, 'demo holds 5,100 lines of code and data; 82% is in src').waitFor();
    await frame.getByRole('button', { name: /^Churn/ }).click();
    await frame.getByRole('heading', { level: 1 }).filter({ hasText: /1 of the 1 most changed files/ }).waitFor();
    await frame.getByText('620', { exact: true }).first().waitFor();
    assert.equal(await frame.getByRole('button', { name: '30 days', exact: true }).getAttribute('aria-pressed'), 'true');
    await frame.getByRole('button', { name: 'All time', exact: true }).click();
    await frame.getByRole('cell', { name: '660', exact: true }).waitFor();
    assert.equal(await frame.getByRole('button', { name: '30 days', exact: true }).getAttribute('aria-pressed'), 'false');
    // The date fields and the presets are 32 px controls, 8 px apart inside a group and 16 px between groups.
    const range = await boxes(frame.locator('.range'), 'input, .toggle');
    assert.deepEqual(range.map(([, , , height]) => height), [32, 32, 32]);
    // Whether the presets fit beside the dates depends on the font; beside them or below, they keep clear of them.
    const [, to, presets] = range as [Box, Box, Box];
    assert.ok(presets[2] === to[2] ? presets[0] - to[1] >= 16 : presets[2] - (to[2] + to[3]) >= 8, `presets clear of the dates: ${JSON.stringify(range)}`);
    await frame.getByRole('button', { name: /^Readiness/ }).click();
    await heading(page, 'demo meets 2 of 3 readiness checks; documentation is weakest').waitFor();
    await frame.getByText('no AGENTS.md or CLAUDE.md in Git: a fresh clone has none', { exact: true }).waitFor();
    await frame.getByText('Changed since the report of 2026-11-01', { exact: true }).waitFor();
    // The bar: chooser and page switch are one 32 px row, 12 px apart; the switch never wraps.
    const bar = await boxes(page.locator('.observability-bar'), '[aria-label="Project"], [role="radiogroup"]');
    assert.deepEqual(bar.map(([, , top, height]) => [top, height]), [[bar[0]![2], 32], [bar[0]![2], 32]], JSON.stringify(bar));
    assert.equal(bar[1]![0] - bar[0]![1], 12);
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/codebase-readiness.png` });
    // He picks another project; the page reads it and the choice is kept on this device.
    await page.getByRole('combobox', { name: 'Project' }).click();
    await page.locator('[data-project-root="/work/other"]').click();
    await heading(page, /^other holds 5,100 lines/).waitFor();
    assert.equal(await page.evaluate(() => (window as unknown as { elpisDesktop: { storage: Storage } }).elpisDesktop.storage.getItem('elpis-codebase-project-v1')), '/work/other');
    await page.getByRole('radio', { name: 'Trajectory', exact: true }).click();
    await page.locator('iframe[title="Trajectory"]').waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// F3, 14 Nov: with Elpis chosen and its report showing, the bar still said "This chat's folder is not a Git project",
// and with nothing chosen the chooser opened on the first project by name. The order: his last choice, the chat's own
// project, the most recent commit.
const LINE = /not a Git project/;
for (const [current, why] of [[null, 'a chat without Git'], ['/work/demo', 'a chat in another project']] as const)
  test(`he opens on the project he chose last, in ${why}, and no line says "not a Git project"`, async () => {
    const f = await fixture({ routes: routes(PROJECTS, current), storage: { 'elpis-codebase-project-v1': '/work/other' } });
    try {
      const { page } = f;
      await openCodebase(page);
      await heading(page, /^other holds/).waitFor();
      assert.equal(await page.getByRole('combobox', { name: 'Project' }).innerText(), 'other');
      assert.equal(await page.locator('.observability').getByText(LINE).count(), 0);
    } finally { await f.close(); }
  });

test('with no choice and no Git in the chat, the page opens on the project with the most recent commit', async () => {
  const recent = [
    { root: '/work/artface-demo', name: 'artface-demo', usedAt: 0, committedAt: 100 },
    { root: '/work/Elpis', name: 'Elpis', usedAt: 0, committedAt: 300 },
    { root: '/work/rustidian', name: 'rustidian', usedAt: 0, committedAt: 200 },
  ];
  const f = await fixture({ routes: routes(recent, null) });
  try {
    const { page } = f;
    await openCodebase(page);
    await heading(page, /^Elpis holds/).waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'Project' }).innerText(), 'Elpis');
    assert.equal(await page.locator('.observability').getByText(LINE).count(), 0);
  } finally { await f.close(); }
});

test('with no Git project in any chat, the page keeps the plain sentence and the chooser', async () => {
  const f = await fixture({ routes: routes([], null) });
  try {
    const { page } = f;
    await openCodebase(page);
    await page.getByText("This chat's folder is not a Git project, and none of your chats works in one yet.", { exact: true }).waitFor();
    const chooser = page.getByRole('combobox', { name: 'Project' });
    assert.equal(await chooser.innerText(), 'No Git projects');
    assert.equal(await chooser.isDisabled(), true);
    assert.equal(await page.locator('iframe[title="Codebase"]').count(), 0);
  } finally { await f.close(); }
});
