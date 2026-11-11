// Shared system, requirement 2: "Same kind of page, same frame." Every page's title starts at one point, at every
// window width. Measured on 11 Nov: Love Spot's title sat 4 px to the left of the others and Workflows' 1 px higher.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');

const PAGES = ['Workflows', 'Love Spot', 'Observability', 'Customize', 'Lab'];

for (const width of [1100, 1400, 1920]) test(`every page title starts at the same point (${width} px wide)`, async () => {
  const f = await fixture({ width, height: 900, routes: { '/api/workflows/workspace': () => ({ cwd: '/tmp/parity-fixture' }) } });
  try {
    const { page } = f;
    const origins: Record<string, string> = {};
    for (const name of PAGES) {
      await page.locator('.nav-list').getByRole('button', { name, exact: true }).click();
      const title = page.locator('main.workspace .workspace-header h1');
      await title.filter({ hasText: name }).waitFor();
      await page.waitForTimeout(300);
      origins[name] = await title.evaluate((el: HTMLElement) => {
        const main = el.closest('main')!.getBoundingClientRect(), box = el.getBoundingClientRect();
        return `${Math.round(box.left - main.left)},${Math.round(box.top - main.top)}`;
      });
    }
    assert.deepEqual(origins, Object.fromEntries(PAGES.map(name => [name, '16,16'])));
  } finally { await f.close(); }
});

// The content under each title, measured on 11 Nov at the three widths (main column W px wide). Two kinds of page:
// - tools (Workflows, Observability): controls and content run from the title's edge (16) to W − 16; Love Spot's board
//   runs edge to edge (0 to W) under its title;
// - documents (Customize, Lab): the shared page column of .page-scroll, --page-content-width centred in its padding;
//   Settings carries its title inside that column, so title, header and groups share one left and one right edge.
// Observability's empty-state line sat at 2 px instead of 16 (the settings notice's own margin); it now sits on the edge.
type Edges = { title: number; left: number; right: number; width: number; column?: { left: number; right: number } };
const EDGE_PAGES = ['Workflows', 'Love Spot', 'Observability', 'Customize', 'Lab', 'Settings'];
async function measureEdges(page: import('playwright-core').Page, name: string): Promise<Edges> {
  if (name === 'Settings') {
    await page.keyboard.press('Control+Comma');
    await page.locator('.settings-page .settings-page-header h2').first().waitFor();
  } else {
    await page.locator('.nav-list').getByRole('button', { name, exact: true }).click();
    await page.locator('main.workspace .workspace-header h1').filter({ hasText: name }).waitFor();
  }
  await page.waitForTimeout(300);
  return page.evaluate((name: string) => {
    const main = document.querySelector('main')!.getBoundingClientRect();
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw Error(`${name}: ${selector} is missing`);
      return el.getBoundingClientRect();
    };
    const x = (value: number) => Math.round(value - main.left);
    const column = () => {
      const scroll = document.querySelector('main .page-scroll')!, style = getComputedStyle(scroll);
      const padL = parseFloat(style.paddingLeft), inner = scroll.clientWidth - padL - parseFloat(style.paddingRight);
      const width = Math.min(parseFloat(style.getPropertyValue('--page-content-width')), inner);
      const left = scroll.getBoundingClientRect().left + padL + (inner - width) / 2;
      return { left: x(left), right: x(left + width) };
    };
    const content = {
      Workflows: '.canvas-header > form',
      'Love Spot': '.love-spot-content',
      Observability: '.observability > .settings-notice',
      Customize: '.customize',
      Lab: 'main .page-scroll > :first-child',
      Settings: '.settings-page .settings-group',
    }[name]!;
    const title = box(name === 'Settings' ? '.settings-page-header h2' : 'main.workspace .workspace-header h1');
    const body = box(content);
    const edges = { title: x(title.left), left: x(body.left), right: x(body.right), width: Math.round(main.width) };
    if (name === 'Settings') {
      const groups = [...document.querySelectorAll('.settings-page .settings-page-header, .settings-page .settings-group')];
      if (groups.some(el => { const r = el.getBoundingClientRect(); return x(r.left) !== edges.left || x(r.right) !== edges.right; }))
        return { ...edges, left: -1 };
    }
    return name === 'Customize' || name === 'Lab' ? { ...edges, column: column() } : edges;
  }, name);
}
/** The pages whose edges leave their kind's frame by more than 1 px, as "page: measured ≠ expected". */
function frameProblems(measured: Record<string, Edges>) {
  const problems: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  for (const [name, edges] of Object.entries(measured)) {
    const { title, left, right, width, column } = edges;
    const expected = name === 'Settings' ? { title: left, left: title, right }
      : name === 'Love Spot' ? { title: 16, left: 0, right: width }
        : column ? { title: 16, left: column.left, right: column.right }
          : { title: 16, left: 16, right: width - 16 };
    if (!near(title, expected.title) || !near(left, expected.left) || !near(right, expected.right))
      problems.push(`${name}: ${title}/${left}/${right} ≠ ${expected.title}/${expected.left}/${expected.right}`);
  }
  const { Customize: customize, Lab: lab } = measured;
  if (customize && lab && (!near(customize.left, lab.left) || !near(customize.right, lab.right)))
    problems.push(`Customize and Lab: ${customize.left}/${customize.right} ≠ ${lab.left}/${lab.right}`);
  return problems;
}
async function allEdges(width: number, shift?: string) {
  const f = await fixture({ width, height: 900, routes: { '/api/workflows/workspace': () => ({ cwd: '/tmp/parity-fixture' }) } });
  try {
    if (shift) await f.page.addStyleTag({ content: shift });
    const measured: Record<string, Edges> = {};
    for (const name of EDGE_PAGES) measured[name] = await measureEdges(f.page, name);
    return measured;
  } finally { await f.close(); }
}

for (const width of [1100, 1400, 1920]) test(`the content under every page title keeps its frame's edges (${width} px wide)`, async () => {
  assert.deepEqual(frameProblems(await allEdges(width)), []);
});

test('a page whose content moves 4 px leaves its frame', async () => {
  const problems = frameProblems(await allEdges(1400, '.customize { position: relative; left: 4px; }'));
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0]!, /^Customize: /);
  assert.match(problems[1]!, /^Customize and Lab/);
});
