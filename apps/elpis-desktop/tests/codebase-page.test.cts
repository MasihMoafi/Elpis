// docs/specs/codebase-dashboard.md, D1: Observability has a Codebase page for the project of the chat he picks.
// 11 Nov, Masih: "there was a dashboard I had asked for in elpis ... please see that to the end".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');

const report = {
  name: 'demo', commit: 'abc1234', date: '2026-11-10',
  code: [{ k: 'src', v: 4200, d: '31 files' }, { k: 'tests', v: 900, d: '12 files' }],
  docs: [['docs', 4, 380]],
  churnFiles: [['src/app.ts', 300]],
  churnLog: [[new Date().toISOString().slice(0, 10), [[0, 620]]], ['2026-01-05', [[0, 40]]]],
  dups: [{ files: ['a.png', 'b.png'], bytes: 2048, kind: 'media' }],
  worktrees: [['/work/demo', 120, 'main', '2026-11-10', 2]],
  pillars: [
    ['Documentation', [['A README', 1, 'README.md'], ['Agent instructions are in Git', 0, 'no AGENTS.md or CLAUDE.md in Git: a fresh clone has none']]],
    ['Testing', [['Tests exist', 1, '12 test files']]],
  ],
  changed: [{ check: 'A README', from: 0, to: 1 }],
  previous: '2026-11-01T10:00:00.000Z',
};

test('Observability shows the project of the chosen chat: code, churn for chosen dates and readiness with its evidence', async () => {
  const f = await fixture({ width: 1300, height: 850, routes: { '/api/threads/chat-a/codebase': () => report } });
  try {
    const { page } = f;
    await page.locator('aside.sidebar .thread-row').first().click();
    await page.locator('.nav-list').getByRole('button', { name: 'Observability', exact: true }).click();
    await page.getByRole('radio', { name: 'Codebase', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Codebase"]');
    await frame.getByRole('heading', { level: 1 }).filter({ hasText: 'demo holds 5,100 lines of code and data; 82% is in src' }).waitFor();
    await frame.getByRole('button', { name: /^Churn/ }).click();
    await frame.getByRole('heading', { level: 1 }).filter({ hasText: /1 of the 1 most changed files/ }).waitFor();
    await frame.getByText('620', { exact: true }).first().waitFor();
    await frame.getByRole('button', { name: 'All time', exact: true }).click();
    await frame.getByRole('cell', { name: '660', exact: true }).waitFor();
    await frame.getByRole('button', { name: /^Readiness/ }).click();
    await frame.getByRole('heading', { level: 1 }).filter({ hasText: 'demo meets 2 of 3 readiness checks; documentation is weakest' }).waitFor();
    await frame.getByText('no AGENTS.md or CLAUDE.md in Git: a fresh clone has none', { exact: true }).waitFor();
    await frame.getByText('Changed since the report of 2026-11-01', { exact: true }).waitFor();
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/codebase-readiness.png` });
    await page.getByRole('radio', { name: 'Trajectory', exact: true }).click();
    await page.locator('iframe[title="Trajectory"]').waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a chat whose folder is not a Git project gets a plain sentence, not an empty chart', async () => {
  const refusal = { __http: 409, error: "This chat's folder is not a Git project, so there is nothing to measure." };
  const f = await fixture({ routes: { '/api/threads/chat-a/codebase': () => refusal } });
  try {
    const { page } = f;
    await page.locator('aside.sidebar .thread-row').first().click();
    await page.locator('.nav-list').getByRole('button', { name: 'Observability', exact: true }).click();
    await page.getByRole('radio', { name: 'Codebase', exact: true }).click();
    await page.frameLocator('iframe[title="Codebase"]').getByText("This chat's folder is not a Git project, so there is nothing to measure.", { exact: true }).waitFor();
  } finally { await f.close(); }
});
