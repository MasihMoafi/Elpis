const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, THREADS } = require('./parity-fixture.cjs');
const { openSettings, leaveSettings, chooseOption } = require('./controls.cjs');
const { FACE_DATA_URL } = require('../bridge/matilda-face.cjs');

const frames = locator => locator.evaluate(element => {
  const style = getComputedStyle(element);
  const probe = document.createElement('span'); element.append(probe);
  probe.style.color = 'color-mix(in oklch, var(--gold, var(--primary)) 70%, transparent)';
  const accent = getComputedStyle(probe).color;
  probe.style.color = 'var(--primary)'; const primary = getComputedStyle(probe).color;
  probe.style.color = 'var(--love-red)'; const love = getComputedStyle(probe).color;
  probe.style.color = 'color-mix(in srgb, var(--primary) 80%, var(--hud-edge))';
  const focus = getComputedStyle(probe).color; probe.remove();
  return {
    widths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
    edge: style.borderRightColor, line: getComputedStyle(element, '::after').backgroundImage, background: style.backgroundColor, radius: style.borderTopLeftRadius,
    shape: style.getPropertyValue('corner-shape'), primary, love, accent, focus,
  };
});

for (const colorScheme of ['light', 'dark']) for (const width of [1440, 960]) {
  test(`restored chat frames retain actions and local accents in ${colorScheme} at ${width}px`, { timeout: 90000 }, async t => {
    const threads = [THREADS[0], { ...THREADS[1], name: 'Love Spot' }, { ...THREADS[2], name: 'Love Spot · Newton' }];
    const child = { ...THREADS[0], id: 'agent-0', name: 'Agent · inspect', parentThreadId: 'chat-a', source: { subagent: { agent_nickname: 'Agent', task_path: '/root/inspect' } } };
    const talk = [
      { turnId: 'love-1', item: { id: 'love-user', type: 'userMessage', content: [{ type: 'text', text: 'Hello Matilda.' }] } },
      { turnId: 'love-1', item: { id: 'love-answer', type: 'agentMessage', text: 'Hello to you.' } },
    ];
    const miniEntries = [...talk];
    const chat = thread => ({ thread, data: [...talk].reverse(), nextCursor: null });
    const f = await fixture({ staticDir: process.env.ELPIS_TEST_OUT || undefined, colorScheme, width, height: 900, threads: [...threads, child], routes: {
      '/api/threads': (_, url) => ({ data: url.searchParams.has('ancestorThreadId') ? [child] : [...threads, child], nextCursor: null }),
      '/api/threads/chat-b': () => chat(threads[1]),
      '/api/threads/chat-c': () => chat(threads[2]),
      '/api/threads/chat-a/side-chat': () => ({ threadId: 'side-a' }),
      '/api/side-chats/side-a/turns': () => ({ turn: { id: 'side-turn' } }),
      '/api/love-spot/companion': () => ({ pinned: true, face: FACE_DATA_URL, threadId: 'chat-a', favorite: null, music: null, reason: '' }),
      '/api/love-spot/talk': body => {
        if (body?.text) miniEntries.push({ turnId: 'love-2', item: { id: 'love-user-2', type: 'userMessage', content: [{ type: 'text', text: body.text }] } });
        return { entries: miniEntries, busy: false };
      },
    } });
    t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
    const { page } = f;
    const shot = async name => {
      if (!process.env.ELPIS_SHOTS) return;
      fs.mkdirSync(process.env.ELPIS_SHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/${process.env.ELPIS_SHOT_LABEL || 'after'}-${colorScheme}-${width}-${name}.png` });
    };
    await openSettings(page, 'Appearance');
    await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: colorScheme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
    await chooseOption(page.getByLabel('Accent colour', { exact: true }), 'teal');
    await leaveSettings(page); await f.open('chat-a');

    const main = page.locator('.chat-scroll .message.user').last(), mainForm = page.locator('.composer').first();
    await main.waitFor();
    const showAgents = page.getByRole('button', { name: 'Show agents panel', exact: true });
    if (await showAgents.count()) await showAgents.click();
    if (width > 1100) await page.locator('.team-panel').waitFor();
    else assert.equal(await page.locator('.team-panel').isVisible(), false, 'the narrow window hides the Agents pane');
    const ordinary = await frames(main); await shot('main-agents');
    await page.getByRole('button', { name: 'Hide agents panel', exact: true }).click();
    await f.composer.fill('Main draft stays here');
    await f.composer.focus(); await f.composer.press('Control+;');
    const side = page.getByRole('region', { name: 'Side chat', exact: true });
    const sideInput = side.getByRole('textbox', { name: 'Side question', exact: true });
    assert.equal(await side.getByRole('button', { name: 'Send', exact: true }).getAttribute('data-variant'), 'default');
    await sideInput.fill('What is the result?'); await sideInput.press('Enter');
    const sideCard = side.locator('.message.user'); await sideCard.waitFor();
    assert.equal(await f.composer.inputValue(), 'Main draft stays here');
    const sideMessage = await frames(sideCard), sideForm = side.locator('.side-chat-form');
    await sideInput.focus(); const focusedSide = await frames(sideForm); await shot('side');
    await sideInput.press('Escape');

    const avatar = page.getByRole('region', { name: 'Pinned Matilda' }).getByRole('button', { name: 'Chat with Matilda' });
    await avatar.click(); const mini = page.getByRole('dialog', { name: 'Small chat with Matilda' });
    const miniCard = mini.locator('.matilda-mini-message[data-speaker="you"]'); await miniCard.waitFor();
    const miniMessage = await frames(miniCard), miniForm = mini.locator('.matilda-mini-composer');
    await mini.getByRole('textbox', { name: 'Message Matilda' }).focus();
    const focusedMini = await frames(miniForm); await shot('mini');
    let popupEdge;
    if (colorScheme === 'dark') {
      popupEdge = await page.locator('.matilda-mini-popup').evaluate(element => {
        const probe = document.createElement('span'); element.append(probe);
        probe.style.color = 'color-mix(in oklch, var(--gold) 60%, transparent)';
        const expected = getComputedStyle(probe).color; probe.remove();
        return { actual: getComputedStyle(element).borderTopColor, expected };
      });
    }
    await mini.getByRole('textbox', { name: 'Message Matilda' }).fill('A new note for Matilda');
    const miniSend = mini.getByRole('button', { name: 'Send to Matilda' });
    assert.equal(await miniSend.getAttribute('data-variant'), 'ghost');
    assert.deepEqual(await miniSend.locator('svg').evaluate(icon => [getComputedStyle(icon).width, getComputedStyle(icon).height]), ['16px', '16px']);
    await shot('mini-ready'); await miniSend.click();
    await mini.getByText('A new note for Matilda', { exact: true }).waitFor();
    assert.equal(f.posts.filter(post => post.path === '/api/love-spot/talk').at(-1).body.text, 'A new note for Matilda');
    assert.equal(await f.composer.inputValue(), 'Main draft stays here');
    await avatar.click();

    const love = [];
    for (const id of ['chat-b', 'chat-c']) {
      await f.open(id); const card = page.locator('.chat-scroll .message.user').last(); await card.waitFor();
      love.push(await frames(card)); await shot(id);
    }
    await f.composer.focus(); const focusedMain = await frames(mainForm);
    const ordinaryForm = { ...focusedMain }; // Focus edge is checked in each composer below.
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
    const tray = page.locator('.composer-tray'); await tray.waitFor();
    await f.composer.focus();
    const newTray = await frames(tray), newComposer = await frames(mainForm);
    await shot('new-chat');
    const allCards = [ordinary, sideMessage, ...love];
    const result = { ordinary, sideMessage, miniMessage, love, focusedMain, focusedSide, focusedMini };
    if (process.env.ELPIS_SHOTS) fs.writeFileSync(`${process.env.ELPIS_SHOTS}/${process.env.ELPIS_SHOT_LABEL || 'after'}-${colorScheme}-${width}.json`, JSON.stringify(result, null, 2));
    for (const [index, card] of allCards.entries()) {
      // 31 Oct: the accented right edge is the shared angular edge, drawn whole round the bottom-right cut, over a 1px frame.
      assert.deepEqual(card.widths, ['1px', '1px', '1px', '1px'], `sent card ${index} keeps its hairline frame`);
      assert.ok(card.line.includes(card.accent), `sent card ${index} draws its edge in its local accent: ${card.line} / ${card.accent}`);
      assert.equal(card.background, ordinary.background, `sent card ${index} uses the shared card surface`);
      assert.equal(card.radius, ordinary.radius, `sent card ${index} uses the shared corner`);
      assert.equal(card.shape, ordinary.shape, `sent card ${index} uses the shared corner shape`);
    }
    assert.deepEqual(miniMessage.widths, ['0px', '0px', '0px', '0px'], 'the small chat retains its earlier unframed messages');
    assert.deepEqual(focusedMain.widths, ['1px', '1px', '1px', '1px'], 'the main composer retains its earlier frame');
    assert.equal(focusedMain.edge, focusedMain.focus, 'the main composer retains its local focus accent');
    assert.deepEqual(focusedSide.widths, ['1px', '0px', '0px', '0px'], 'the side chat retains its earlier top divider');
    assert.deepEqual(focusedMini.widths, ['0px', '0px', '0px', '0px'], 'the small composer retains its earlier unframed shape');
    assert.notEqual(ordinary.primary, ordinary.love, 'ordinary chats keep the chosen teal accent');
    for (const [index, card] of [miniMessage, ...love].entries()) assert.equal(card.primary, card.love, `Love Spot chat ${index} keeps red`);
    if (popupEdge) assert.equal(popupEdge.actual, popupEdge.expected, 'the pinned Love Spot popup edge follows its red accent');
    assert.equal(newComposer.radius, '0px', 'the new-chat composer joins the tray above it');
    assert.equal(newTray.edge, newComposer.edge, 'the joined tray shares the composer focus edge');
  });
}
