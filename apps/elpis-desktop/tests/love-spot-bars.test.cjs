// Every floating bar of the Love Spot board moves by one and the same handle (Masih, 22 Oct), and stays clear of the others.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

// Masih, 22 Oct: "I wanted to be able to move it anywhere not just horizontally. And it shouldn't interfere with the other ones either."
const touches = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
test('the tool bar moves anywhere in the board, stops against the other controls instead of covering them, and the place is kept', async () => {
  const f = await loveSpotFixture({ colorScheme: 'light' });
  try {
    await f.page.setViewportSize({ width: 1280, height: 800 });
    await f.open(f.page);
    const bar = f.page.locator('.love-spot-editor .App-toolbar').first(), area = f.page.locator('.love-spot-editor'), grip = f.page.getByRole('button', { name: 'Move tools' });
    const others = f.page.locator('.love-spot-editor').locator('.main-menu-trigger, .layer-ui__wrapper__top-right, .layer-ui__wrapper__footer-left, .layer-ui__wrapper__footer-right');
    const covers = async () => { const box = await bar.boundingBox(); const hit = []; for (const other of await others.all()) { const o = await other.boundingBox(); if (o && o.width > 0 && o.height > 0 && touches(box, o)) hit.push(await other.getAttribute('class')); } return hit; };
    const dragTo = async (x, y) => { const g = await grip.boundingBox(); await f.page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await f.page.mouse.down(); await f.page.mouse.move(x, y, { steps: 12 }); await f.page.mouse.up(); };
    await grip.waitFor();
    const start = await bar.boundingBox(), board = await area.boundingBox();
    assert.deepEqual(await covers(), [], 'at the start the bar covers nothing');
    const gripBox = await grip.boundingBox();
    assert.ok(gripBox.x >= start.x + start.width && Math.abs(gripBox.y + gripBox.height / 2 - (start.y + start.height / 2)) <= 3, `the handle is to the right of the bar, level with its middle: ${JSON.stringify({ gripBox, start })}`);
    assert.equal(await grip.locator('svg circle').count(), 9, 'the handle is a 3 by 3 grid of dots');
    await dragTo(board.x + board.width / 2 - 150, board.y + board.height / 2 + 120);
    const moved = await bar.boundingBox();
    assert.ok(moved.y - start.y >= 150, `the bar goes down, not only sideways: ${JSON.stringify({ start, moved })}`);
    assert.ok(start.x - moved.x >= 100, 'and to the left at the same time');
    assert.deepEqual(await covers(), [], 'in the middle of the board it covers nothing');
    for (const [x, y] of [[board.x + 20, board.y + 8], [board.x + board.width - 20, board.y + 8], [board.x + 20, board.y + board.height - 8], [board.x + board.width - 20, board.y + board.height - 8]]) {
      await dragTo(x, y);
      assert.deepEqual(await covers(), [], `dragged into the corner ${Math.round(x)},${Math.round(y)} it stops against the other controls`);
      const box = await bar.boundingBox();
      assert.ok(box.x >= board.x && box.y >= board.y && box.x + box.width <= board.x + board.width + 1 && box.y + box.height <= board.y + board.height + 1 || box.width > board.width, 'and stays in the board');
    }
    await grip.focus();
    for (let i = 0; i < 12; i++) await f.page.keyboard.press('ArrowUp');
    assert.deepEqual(await covers(), [], 'arrow keys stop against the controls too');
    await dragTo(board.x + board.width / 2, board.y + board.height / 2);
    const kept = await bar.boundingBox();
    await f.page.reload(); await f.open(f.page); await grip.waitFor();
    const after = await bar.boundingBox(); assert.ok(Math.abs(after.x - kept.x) <= 2 && Math.abs(after.y - kept.y) <= 2, `the place is kept in both directions: ${JSON.stringify({ kept, after })}`);
    await grip.dblclick();
    const home = await bar.boundingBox(); assert.ok(Math.abs(home.x - start.x) <= 2 && Math.abs(home.y - start.y) <= 2, `double-click puts it back: ${JSON.stringify({ start, home })}`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// Masih, 22 Oct: "when I have one function somewhere I want the exact same function elsewhere": every floating bar has the one handle.
test('lock and hand moves on its own handle, and no bar covers another', async () => {
  const f = await loveSpotFixture({ colorScheme: 'dark' });
  try {
    await f.page.setViewportSize({ width: 860, height: 760 }); // a board this narrow lays its bars out in the narrow arrangement
    await f.open(f.page); await f.page.locator('.love-spot-editor .mobile-misc-tools-container').waitFor();
    const handle = name => f.page.getByRole('button', { name, exact: true });
    for (const name of ['Move tools', 'Move lock and hand']) await handle(name).waitFor();
    assert.equal(await handle('Move zoom and undo').count(), 0, 'the zoom and undo bar has no handle');
    const bars = { tools: f.page.locator('.love-spot-editor section:has(.App-toolbar)').first(), extras: f.page.locator('.love-spot-editor .mobile-misc-tools-container') };
    const rects = async () => Object.fromEntries(await Promise.all(Object.entries(bars).map(async ([name, bar]) => [name, await bar.boundingBox()])));
    const drag = async (name, x, y) => { const g = await handle(name).boundingBox(); await f.page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await f.page.mouse.down(); await f.page.mouse.move(x, y, { steps: 12 }); await f.page.mouse.up(); };
    const apart = async note => { const r = await rects(); for (const [a, b] of [['tools', 'extras']]) assert.equal(touches(r[a], r[b]), false, `${note}: ${a} and ${b} touch ${JSON.stringify(r)}`); return r; };
    const board = await f.page.locator('.love-spot-editor').boundingBox();
    const before = await apart('at the start');
    await drag('Move lock and hand', board.x + 120, board.y + board.height / 2);
    let after = await apart('lock and hand moved');
    assert.ok(Math.abs(after.extras.x - before.extras.x) > 100 && after.extras.y - before.extras.y > 100, `lock and hand move by their own handle: ${JSON.stringify({ before: before.extras, after: after.extras })}`);
    assert.deepEqual([after.tools.x, after.tools.y].map(Math.round), [before.tools.x, before.tools.y].map(Math.round), 'and the tool bar does not move with it');
    const middle = after.extras;
    await drag('Move tools', middle.x + middle.width / 2, middle.y + middle.height / 2);
    await apart('the tool bar dragged onto lock and hand');
    await f.page.reload(); await f.open(f.page); await handle('Move lock and hand').waitFor();
    const kept = await rects();
    assert.ok(Math.abs(kept.extras.x - after.extras.x) <= 2 && Math.abs(kept.extras.y - after.extras.y) <= 2, `each bar's place is kept: ${JSON.stringify({ was: after.extras, now: kept.extras })}`);
    await handle('Move lock and hand').dblclick();
    const home = await rects(); assert.ok(Math.abs(home.extras.y - before.extras.y) <= 2, 'double-click puts lock and hand back');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
