const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureReview } = require('./controls.cjs');
const { fixture } = require('./parity-fixture.cjs');
const { files, contextRoutes } = require('./context-files-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

for (const colorScheme of ['light', 'dark']) test(`goal slash and right Context tab: set, read, clear, errors, file editing and missing intent (${colorScheme})`, async () => {
  let goal = null, exists = false, reject = false, content = '# Session intent\n\nKeep this project focused.', mtimeMs = 1;
  const rows = files(); rows[0] = { ...rows[0], exists: false, included: false, selectable: false, reason: 'Project session intent' };
  rows.push({ name: 'Selected skill', path: '/tmp/parity-fixture/skills/selected/SKILL.md', group: 'skills', estimatedTokens: 120, included: true, selectable: false, reason: 'Loaded in this chat' });
  const f = await fixture({ desktop: true, width: 1440, height: 900, colorScheme, routes: { ...contextRoutes(),
    '/api/threads/chat-a/goal': body => {
      if (body && reject) return { __http: 409, error: 'Goal changed elsewhere. Retry.' };
      if (body?.clear) { const cleared = !!goal; goal = null; return { cleared }; }
      if (body) goal = { objective: body.objective, status: 'active' };
      return { goal };
    },
    '/api/threads/chat-a/session-context': () => ({ goal, files: rows.map((row, i) => i ? row : { ...row, exists }) }),
    '/api/threads/chat-a/session-intent': () => { exists = true; return { path: rows[0].path }; },
    '/api/threads/chat-b/session-context': () => ({ goal: null, files: [] }),
    '/api/file': (body, url) => { if (body) { content = body.content; return { mtimeMs: ++mtimeMs }; } return { content, size: content.length, mtimeMs }; },
    '/api/files/dir': () => ({ data: [] }),
  } });
  const panel = f.page.getByRole('region', { name: 'Side panel', exact: true });
  const command = async value => { await f.composer.fill(value); await f.composer.press('Enter'); };
  try {
    await f.open('chat-a'); await f.composer.fill('/go');
    await f.page.getByRole('option', { name: /\/goal/ }).waitFor();
    await command('/goal Finish the parser and verify Persian متن wrapping.');
    await panel.getByText('Finish the parser and verify Persian متن wrapping.', { exact: true }).waitFor();
    assert.equal(f.posts.some(p => p.path.endsWith('/turns')), false, 'slash goal is not sent as a normal turn');
    await panel.getByText('Not created yet', { exact: true }).waitFor();
    reject = true; await command('/goal A rejected replacement'); await f.page.getByText('Goal changed elsewhere. Retry.', { exact: true }).waitFor();
    assert.equal(await f.composer.inputValue(), '/goal A rejected replacement', 'a rejected goal keeps the typed condition for retry');
    assert.equal(goal.objective, 'Finish the parser and verify Persian متن wrapping.'); reject = false;
    await command('/goal'); await panel.getByRole('button', { name: 'Clear goal', exact: true }).waitFor();
    reject = true; await panel.getByRole('button', { name: 'Clear goal', exact: true }).click(); await panel.getByRole('alert').waitFor();
    assert.ok(goal, 'a rejected Clear keeps the existing goal'); reject = false;
    await panel.getByRole('button', { name: 'Retry context files', exact: true }).click(); await panel.getByRole('alert').waitFor({ state: 'hidden' });
    await assertUiFit(panel, `Context ${colorScheme}`);
    await captureReview(f.page, `goal-${colorScheme}`);
    await panel.getByRole('button', { name: 'Create ES.md', exact: true }).click();
    await f.page.getByRole('article').getByRole('heading', { name: 'Session intent', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Source', exact: true }).click();
    const editor = panel.getByRole('textbox', { name: /Contents of .*ES.md/ }); await editor.fill('# Updated intent'); await editor.press('Control+s');
    await f.page.waitForFunction(() => !document.querySelector('.file-tab[data-dirty="true"]'));
    assert.ok(f.posts.some(p => p.path === '/api/file' && p.body.content === '# Updated intent'));
    for (const file of rows.slice(1)) {
      const displayedPath = file.path.replace(/^\/tmp\/parity-fixture\//, '');
      await panel.getByRole('tab', { name: 'Context', exact: true }).click();
      await panel.getByRole('button', { name: `Open ${file.name}`, exact: true }).click();
      await panel.getByRole('article', { name: `Preview of ${displayedPath}`, exact: true }).waitFor();
      await panel.getByRole('button', { name: 'Source', exact: true }).click();
      await panel.getByRole('textbox', { name: `Contents of ${displayedPath}`, exact: true }).waitFor();
    }
    await panel.getByRole('tab', { name: 'Context', exact: true }).click();
    await panel.getByRole('button', { name: 'Clear goal', exact: true }).click(); await panel.getByText('No goal set.', { exact: true }).waitFor();
    await command('/goal A second goal'); await panel.getByText('A second goal', { exact: true }).waitFor();
    await command('/goal clear'); await panel.getByText('No goal set.', { exact: true }).waitFor();
    await f.open('chat-b'); assert.equal(await panel.getByText('Finish the parser and verify Persian متن wrapping.', { exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
