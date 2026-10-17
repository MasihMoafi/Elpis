// Approvals, questions and plans as Claude's desktop app offers them (parity gap 8): numbered choices that the number
// keys pick, Enter for the highlighted one and Esc to deny; "Deny, and tell Elpis what to do instead"; a question card
// with "Other"; a plan card with Accept, Accept and approve for me, and Keep planning. Each test checks what the bridge
// receives. Local bridge fixture (tests/parity-fixture.cjs); no engine, no model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture, CWD } = require('./parity-fixture.cjs');

const SHOTS = '/tmp/elpis-decision-cards';
const until = async (check, what) => { for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out waiting for ${what}`); };
const approvalPosts = posts => posts.filter(post => post.path.startsWith('/api/approvals/'));
const command = (id, extra = {}) => ({ id, ownerThreadId: 'chat-a', method: 'item/commandExecution/requestApproval', params: { threadId: 'chat-a', turnId: 't4', itemId: `cmd-${id}`, command: 'git status --short', cwd: CWD, reason: 'Check what changed', ...extra } });
const DECISIONS = ['accept', 'acceptForSession', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } }, 'decline', 'cancel'];
const narrowShot = async (page, card, name) => {
  const previous = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  const fits = await card.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth; });
  assert.equal(fits, true, `${name} fits at 390px`);
  await card.screenshot({ path: `${SHOTS}/${name}-390.png` });
  await page.setViewportSize(previous);
};
const choiceNames = card => card.locator('.choice').evaluateAll(rows => rows.map(row => [row.querySelector('kbd')?.textContent ?? '', row.getAttribute('aria-label')]));

for (const colorScheme of ['light', 'dark']) {
  test(`command approval: number keys, Enter and Esc answer it from the empty message box (${colorScheme})`, async () => {
    const f = await fixture({ colorScheme, height: 900 }), { page, composer, posts, emit } = f;
    try {
      await f.open('chat-a'); await composer.click();
      emit('approval', command('a1', { availableDecisions: DECISIONS }));
      const card = page.getByRole('group', { name: 'Allow Elpis to run this command?' });
      await card.waitFor();
      assert.deepEqual(await choiceNames(card), [['1', 'Allow once'], ['2', 'Allow for this session'], ['3', 'Always allow'], ['4', 'Deny'], ['5', 'Deny, and tell Elpis what to do instead'], ['6', 'Deny and stop']]);
      await card.getByText('git status', { exact: false }).first().waitFor();
      await fs.mkdir(SHOTS, { recursive: true }); await card.screenshot({ path: `${SHOTS}/command-${colorScheme}.png` });
      await page.keyboard.press('2');
      await until(() => approvalPosts(posts).length === 1, 'the number key');
      assert.deepEqual(approvalPosts(posts)[0], { path: '/api/approvals/a1', body: { decision: 'acceptForSession' } });
      await card.waitFor({ state: 'detached' });

      emit('approval', command('a2', { availableDecisions: DECISIONS })); await card.waitFor();
      await page.keyboard.press('Enter');
      await until(() => approvalPosts(posts).length === 2, 'Enter');
      assert.deepEqual(approvalPosts(posts)[1], { path: '/api/approvals/a2', body: { decision: 'accept' } });
      await card.waitFor({ state: 'detached' });

      emit('approval', command('a3', { availableDecisions: DECISIONS })); await card.waitFor();
      await page.keyboard.press('Escape');
      await until(() => approvalPosts(posts).length === 3, 'Esc');
      assert.deepEqual(approvalPosts(posts)[2], { path: '/api/approvals/a3', body: { decision: 'decline' } });
      await card.waitFor({ state: 'detached' });

      emit('approval', command('a4', { availableDecisions: DECISIONS })); await card.waitFor();
      await page.keyboard.press('3');
      await until(() => approvalPosts(posts).length === 4, 'the "always" number key');
      assert.deepEqual(approvalPosts(posts)[3].body, { decision: DECISIONS[2] });
      await card.waitFor({ state: 'detached' });

      // A draft in the message box keeps its keys: "1" is typed, nothing is answered.
      await composer.fill('draft'); emit('approval', command('a5', { availableDecisions: DECISIONS })); await card.waitFor();
      await composer.press('1'); await composer.press('Escape'); await page.waitForTimeout(150);
      assert.equal(approvalPosts(posts).length, 4); assert.match(await composer.inputValue(), /^draft1/);
      await card.getByRole('button', { name: 'Deny and stop', exact: true }).click();
      await until(() => approvalPosts(posts).length === 5, 'the click');
      assert.deepEqual(approvalPosts(posts)[4].body, { decision: 'cancel' });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`"Deny, and tell Elpis what to do instead" sends the instruction with the denial (${colorScheme})`, async () => {
    const f = await fixture({ colorScheme, height: 900 }), { page, composer, posts, emit } = f;
    try {
      await f.open('chat-a'); await composer.click();
      emit('approval', { ...command('b1'), method: 'item/fileChange/requestApproval', params: { threadId: 'chat-a', turnId: 't4', itemId: 'patch-1', reason: 'Rename the lexer' } });
      const card = page.getByRole('group', { name: 'Allow Elpis to edit files?' });
      await card.waitFor();
      assert.deepEqual(await choiceNames(card), [['1', 'Allow once'], ['2', 'Allow for this session'], ['3', 'Deny'], ['4', 'Deny, and tell Elpis what to do instead'], ['5', 'Deny and stop']]);
      await page.keyboard.press('4');
      const box = card.getByRole('textbox', { name: 'What should Elpis do instead?', exact: true });
      await box.waitFor(); assert.equal(await box.evaluate(element => element === document.activeElement), true, 'the box takes the keys');
      await box.press('Escape'); await box.waitFor({ state: 'detached' });
      assert.equal(await card.locator('.choice').count(), 5, 'Esc in the box goes back to the choices');
      await card.getByRole('button', { name: 'Deny, and tell Elpis what to do instead', exact: true }).click();
      await box.fill('Keep lexer.ts; add an alias instead.');
      await card.screenshot({ path: `${SHOTS}/instead-${colorScheme}.png` });
      await box.press('Enter');
      await until(() => approvalPosts(posts).length === 1, 'the instruction');
      assert.deepEqual(approvalPosts(posts)[0], { path: '/api/approvals/b1/instead', body: { text: 'Keep lexer.ts; add an alias instead.' } });
      await card.waitFor({ state: 'detached' });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`question card: number keys pick an option, "Other" takes your own answer (${colorScheme})`, async () => {
    const f = await fixture({ colorScheme, height: 900 }), { page, composer, posts, emit } = f;
    try {
      await f.open('chat-a'); await composer.click();
      const questions = [
        { id: 'scope', header: 'Scope', question: 'Which files should change?', isOther: true, isSecret: false, options: [{ label: 'Only the parser (Recommended)', description: 'The smallest change' }, { label: 'Parser and lexer', description: 'Touches both passes' }] },
        { id: 'tests', header: 'Tests', question: 'Add tests?', isOther: true, isSecret: false, options: [{ label: 'Yes', description: 'Unit tests for each pass' }, { label: 'No', description: 'No new tests' }] },
      ];
      emit('approval', { id: 'c1', ownerThreadId: 'chat-a', method: 'item/tool/requestUserInput', params: { threadId: 'chat-a', turnId: 't4', itemId: 'ask-1', isBlocking: true, autoResolutionMs: null, questions } });
      const card = page.getByRole('group', { name: 'Elpis has 2 questions' });
      await card.waitFor();
      const first = card.getByRole('radiogroup', { name: 'Which files should change?' }), second = card.getByRole('radiogroup', { name: 'Add tests?' });
      assert.deepEqual(await choiceNames(first), [['1', 'Only the parser (Recommended)'], ['2', 'Parser and lexer'], ['3', 'Other']]);
      await card.screenshot({ path: `${SHOTS}/question-${colorScheme}.png` });
      await narrowShot(page, card, `question-${colorScheme}`);
      await page.keyboard.press('2');
      assert.equal(await first.getByRole('radio', { name: 'Parser and lexer', exact: true }).getAttribute('aria-checked'), 'true');
      assert.deepEqual((await choiceNames(second)).map(([key]) => key), ['1', '2', '3'], 'the keys move to the next question');
      await page.keyboard.press('3');
      const other = card.getByRole('textbox', { name: 'Other answer: Add tests?', exact: true });
      await other.waitFor(); assert.equal(await other.evaluate(element => element === document.activeElement), true);
      await other.fill('Only snapshot tests'); await other.press('Enter');
      await until(() => approvalPosts(posts).length === 1, 'the answers');
      assert.deepEqual(approvalPosts(posts)[0], { path: '/api/approvals/c1', body: { answers: { scope: ['Parser and lexer'], tests: ['None of the above', 'user_note: Only snapshot tests'] } } });
      await card.waitFor({ state: 'detached' });

      emit('approval', { id: 'c2', ownerThreadId: 'chat-a', method: 'item/tool/requestUserInput', params: { threadId: 'chat-a', turnId: 't4', itemId: 'ask-2', isBlocking: true, autoResolutionMs: null, questions } });
      await card.waitFor();
      assert.equal(await card.getByRole('button', { name: 'Submit', exact: true }).isDisabled(), true, 'Submit waits for every answer');
      await first.getByRole('radio', { name: 'Only the parser (Recommended)', exact: true }).click();
      await second.getByRole('radio', { name: 'Yes', exact: true }).click();
      await card.getByRole('button', { name: 'Submit', exact: true }).click();
      await until(() => approvalPosts(posts).length === 2, 'the clicked answers');
      assert.deepEqual(approvalPosts(posts)[1].body, { answers: { scope: ['Only the parser (Recommended)'], tests: ['Yes'] } });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}

/** The first chat, in Plan mode and Ask for approval, with a finished turn that proposed a plan. */
const planFixture = colorScheme => fixture({ colorScheme, height: 900,
  chat: [['t1', 'Plan the release.', 'That is the plan.', [{ id: 'plan-t1', type: 'plan', text: '1. Tag the release.\n2. Build the installers.' }]]],
  routes: {
    '/api/threads/chat-a/resume': () => ({ thread: { id: 'chat-a', name: 'Fix the parser', preview: 'Fix the parser', cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } }, activeTurnId: null, planMode: true, permissions: 'ask' }),
    '/api/threads/chat-a/permissions': body => ({ permissions: body.permissions }),
  } });
const planPosts = posts => posts.filter(post => /\/(turns|permissions)$/.test(post.path));

for (const colorScheme of ['light', 'dark']) {
  test(`plan card: Keep planning sends what should change, in Plan mode (${colorScheme})`, async () => {
    const f = await planFixture(colorScheme), { page, composer, posts } = f;
    try {
      await f.open('chat-a'); await composer.click();
      const card = page.getByRole('group', { name: 'Elpis proposed a plan' });
      await card.waitFor();
      assert.deepEqual(await choiceNames(card), [['1', 'Accept'], ['2', 'Accept and approve for me'], ['3', 'Keep planning']]);
      await card.screenshot({ path: `${SHOTS}/plan-${colorScheme}.png` });
      await narrowShot(page, card, `plan-${colorScheme}`);
      await page.keyboard.press('3');
      const box = card.getByRole('textbox', { name: 'What should change?', exact: true });
      await box.waitFor(); await box.press('Escape'); await box.waitFor({ state: 'detached' });
      await page.keyboard.press('Escape');
      await box.waitFor(); assert.equal(await box.evaluate(element => element === document.activeElement), true, 'Esc on the card opens Keep planning');
      await box.fill('Add a rollback step.'); await box.press('Enter');
      await until(() => planPosts(posts).length === 1, 'the plan feedback');
      assert.deepEqual(planPosts(posts), [{ path: '/api/threads/chat-a/turns', body: { text: 'Add a rollback step.' } }]);
      await card.waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('button', { name: 'Turn plan mode off', exact: true }).count(), 1, 'the chat stays in Plan mode');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}

test('plan card: 2 accepts and switches the chat to Approve for me first', async () => {
  const f = await planFixture('light'), { page, composer, posts } = f;
  try {
    await f.open('chat-a'); await composer.click();
    const card = page.getByRole('group', { name: 'Elpis proposed a plan' }); await card.waitFor();
    await page.keyboard.press('2');
    await until(() => planPosts(posts).length === 2, 'the permission change and the turn');
    assert.deepEqual(planPosts(posts), [{ path: '/api/threads/chat-a/permissions', body: { permissions: 'auto' } }, { path: '/api/threads/chat-a/turns', body: { text: 'Implement the plan.', mode: 'default' } }]);
    await card.waitFor({ state: 'detached' });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('plan card: Enter accepts in the chat\'s own permission mode', async () => {
  const f = await planFixture('light'), { page, composer, posts } = f;
  try {
    await f.open('chat-a'); await composer.click();
    const card = page.getByRole('group', { name: 'Elpis proposed a plan' }); await card.waitFor();
    await page.keyboard.press('Enter');
    await until(() => planPosts(posts).length === 1, 'the turn');
    await page.waitForTimeout(100);
    assert.deepEqual(planPosts(posts), [{ path: '/api/threads/chat-a/turns', body: { text: 'Implement the plan.', mode: 'default' } }]);
    await card.waitFor({ state: 'detached' });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) {
  test(`decision cards fit at 390px without legacy approval padding (${colorScheme})`, async () => {
    const f = await fixture({ colorScheme, height: 844 }), { page, posts, emit } = f;
    try {
      await f.open('chat-a');
      await page.setViewportSize({ width: 390, height: 844 });
      emit('approval', command('narrow', { availableDecisions: DECISIONS }));
      const card = page.getByRole('group', { name: 'Allow Elpis to run this command?' });
      await card.waitFor();
      const layout = await card.evaluate(element => ({ padding: getComputedStyle(element).padding, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: innerWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
      assert.equal(layout.padding, '0px', 'the shared card owns its spacing');
      assert.ok(layout.left >= 0 && layout.right <= layout.width, JSON.stringify(layout));
      assert.ok(layout.scrollWidth <= layout.clientWidth, JSON.stringify(layout));
      await fs.mkdir(SHOTS, { recursive: true });
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/narrow-${colorScheme}.png` });
      await card.getByRole('button', { name: 'Deny, and tell Elpis what to do instead', exact: true }).click();
      const box = card.getByRole('textbox', { name: 'What should Elpis do instead?', exact: true });
      await box.fill('Read the files instead.');
      await page.screenshot({ path: `${SHOTS}/narrow-instead-${colorScheme}.png` });
      await card.getByRole('button', { name: 'Deny and send', exact: true }).click();
      await until(() => approvalPosts(posts).length === 1, 'the narrow-screen instruction');
      assert.deepEqual(approvalPosts(posts)[0], { path: '/api/approvals/narrow/instead', body: { text: 'Read the files instead.' } });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
