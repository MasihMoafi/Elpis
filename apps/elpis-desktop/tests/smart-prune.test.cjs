const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const prune = { attemptId: 'attempt-1', callId: 'command-1', tool: 'cargo test -p core', sourceTokens: 6300, admittedTokens: 182, kept: 'the 2 failing tests', failureReason: null };
const command = id => ({ id, type: 'commandExecution', command: id === 'command-1' ? 'cargo test -p core' : 'git status', cwd: '/tmp/parity-fixture', status: 'completed', exitCode: 0, aggregatedOutput: 'Full output', durationMs: 40, commandActions: [] });

test('Smart Prune belongs under its tool and opens exact evidence by mouse and Enter', async () => {
  const work = [command('command-1'), command('command-2'), { id: 'prune-1', type: 'smartPrune', prune }];
  for (const colorScheme of ['light', 'dark']) {
    const app = await fixture({ staticDir: process.env.ELPIS_PRUNE_BASELINE, colorScheme, width: 1440, height: 900, chat: [['t1', 'Run tests', 'Finished.', work]], routes: {
      '/api/threads/chat-a/smart-prune/attempt-1/command-1': () => ({ original: 'ORIGINAL_ONLY\nfull failing tests', compact: 'COMPACT_ONLY\ntwo failures' }),
    } });
    try {
      const { page } = app;
      await page.getByRole('button', { name: 'Fix the parser', exact: true }).first().click();
      await page.locator('.worked-for > summary').click();
      await page.locator('.activity-group > summary').click();
      const row = page.getByRole('button', { name: '✂ Smart Prune · cargo test -p core · 6.3k → 182 tokens · kept: the 2 failing tests', exact: true });
      await row.waitFor();
      assert.equal(await row.evaluate(button => button.closest('.activity-group-body > div').previousElementSibling.textContent.includes('cargo test -p core')), true);
      assert.equal(await page.locator('.activity-group-body > div').last().textContent().then(text => text.includes('git status')), true);
      await row.click();
      const panel = page.getByRole('region', { name: 'Side panel', exact: true });
      await panel.getByText('ORIGINAL_ONLY', { exact: false }).waitFor();
      await panel.getByText('COMPACT_ONLY', { exact: false }).waitFor();
      await page.screenshot({ path: `/tmp/elpis-smart-prune-${colorScheme}.png` });
      await panel.getByRole('button', { name: 'Close side panel', exact: true }).click();
      await row.focus(); await page.keyboard.press('Enter');
      await panel.getByText('ORIGINAL_ONLY', { exact: false }).waitFor();
    } finally { await app.close(); }
  }
});

test('Smart Prune off adds no entry; failure says the original was kept', async () => {
  const app = await fixture({ staticDir: process.env.ELPIS_PRUNE_BASELINE, chat: [['t1', 'No prune', 'Off.', [command('command-1')]], ['t2', 'Failed prune', 'Kept.', [command('command-2'), { id: 'failed', type: 'smartPrune', prune: { ...prune, callId: 'command-2', failureReason: 'The pruner timed out.' } }]]] });
  try {
    await app.page.getByRole('button', { name: 'Fix the parser', exact: true }).first().click();
    for (const summary of await app.page.locator('.worked-for > summary').all()) await summary.click();
    await app.page.locator('.activity-group > summary').nth(1).waitFor();
    for (const summary of await app.page.locator('.activity-group > summary').all()) await summary.click();
    await app.page.getByRole('button', { name: /✂ Smart Prune/ }).waitFor();
    assert.equal(await app.page.getByRole('button', { name: /✂ Smart Prune/ }).count(), 1);
    await app.page.getByRole('button', { name: '✂ Smart Prune failed · kept the full output · The pruner timed out.', exact: true }).waitFor();
  } finally { await app.close(); }
});

test('a live prune appears at the completed call and duplicate delivery adds no second row', async () => {
  const app = await fixture({ staticDir: process.env.ELPIS_PRUNE_BASELINE, running: true, chat: [['t4', 'Run tests', 'Running.', [command('command-1'), command('command-2')]]] });
  try {
    await app.open('chat-a');
    await app.page.locator('.activity-group > summary').click();
    assert.equal(await app.page.getByRole('button', { name: /✂ Smart Prune/ }).count(), 0);
    const event = { method: 'item/completed', params: { threadId: 'chat-a', turnId: 't4', item: { id: 'prune-1', type: 'smartPrune', prune }, completedAtMs: Date.now() } };
    app.emit('message', event);
    const row = app.page.getByRole('button', { name: /✂ Smart Prune ·/ });
    await row.waitFor(); app.emit('message', event);
    assert.equal(await row.evaluate(button => button.closest('.activity-group-body > div').previousElementSibling.textContent.includes('cargo test -p core')), true);
    app.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 't5', item: { id: 'next-user', type: 'userMessage', content: [{ type: 'text', text: 'Second turn' }] } } });
    await app.page.getByText('Second turn', { exact: true }).waitFor();
    assert.equal(await row.count(), 1);
    app.emit('message', { ...event, params: { ...event.params, item: { id: 'prune-2', type: 'smartPrune', prune: { ...prune, callId: 'command-2', tool: 'git status' } } } });
    const late = app.page.getByRole('button', { name: /✂ Smart Prune · git status/ });
    await late.waitFor();
    assert.equal(await app.page.locator('section.turn').count(), 2);
    assert.equal(await late.evaluate(button => button.closest('section.turn').textContent.includes('Run tests')), true);
  } finally { await app.close(); }
});
