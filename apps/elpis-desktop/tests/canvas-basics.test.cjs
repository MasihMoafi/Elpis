// The basics every node editor has (Blender, ComfyUI, Resolve, Node-RED, Slate; lat.md/tasks.md, 17 October 2026):
// undo and redo, copy and paste with the wires among the copies, duplicate, delete keeping the flow, right-click
// menus on agents, the board and wires, F2 to rename, and Home to fit the whole graph.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');

test('canvas basics: undo and redo, copy and paste, duplicate, delete keeping the flow, menus, rename, fit', async () => {
  const { page, canvas, node, wires, saved, titles, agentCount, fit, errors, plans, runs, close } = await openCanvas();
  try {
    const off = () => page.evaluate(() => document.activeElement?.blur());
    const wired = (graph, from, to) => graph.edges.some(edge => graph.nodes.find(item => item.id === edge.source)?.data?.title === from && graph.nodes.find(item => item.id === edge.target)?.data?.title === to);

    await agentCount(4, 'the default board');
    // Readable on opening, as FigJam keeps its objects: the board never zooms below 85% by itself, so an agent's name
    // reads at 12 px or more.
    const named = await node('Quillon · Part 1').locator('.agent-node-title').evaluate(title => parseFloat(getComputedStyle(title).fontSize) * title.getBoundingClientRect().height / title.offsetHeight);
    assert.ok(named >= 12, `an agent's name reads at ${named.toFixed(1)} px`);
    // Shift+click as a hand does it (Shift held, the mouse wobbling a pixel or two) adds to the selection and moves
    // nothing; Ctrl+A selects every agent.
    await fit();
    const where = async () => (await saved()).nodes.map(item => `${item.position.x},${item.position.y}`).join(' ');
    const shiftClick = async title => {
      const box = await node(title).boundingBox();
      await page.keyboard.down('Shift');
      await page.mouse.move(box.x + 60, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 63, box.y + 32); await page.mouse.up();
      await page.keyboard.up('Shift');
    };
    const selected = () => canvas.locator('.react-flow__node.selected .agent-node-title').allInnerTexts();
    const placed = await where();
    await node('Quillon · Part 1').click(); await shiftClick('Veyra · Part 2'); await shiftClick('Orilo · Part 3');
    assert.deepEqual(await selected(), ['Quillon · Part 1', 'Veyra · Part 2', 'Orilo · Part 3']);
    assert.equal(await where(), placed, 'Shift+click moved nothing');
    await shiftClick('Veyra · Part 2');
    assert.deepEqual(await selected(), ['Quillon · Part 1', 'Orilo · Part 3'], 'Shift+click on a selected agent takes it out');
    await off(); await page.keyboard.press('Control+a');
    assert.deepEqual(await selected(), ['Quillon · Part 1', 'Veyra · Part 2', 'Orilo · Part 3', 'Nuvani · Join the parts']);
    assert.equal(await canvas.getByRole('dialog', { name: 'Add agents', exact: true }).count(), 0, 'Ctrl+A selects; it opens nothing');
    await canvas.getByRole('complementary', { name: 'Selected agents', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();

    // The mouse as in Fusion and Slate: left-drag on empty board draws a selection box; middle-drag pans; nothing moves.
    const pane = await canvas.locator('.react-flow__pane').boundingBox(), p1 = await node('Quillon · Part 1').boundingBox(), p3 = await node('Orilo · Part 3').boundingBox();
    await page.mouse.move(p1.x - 20, p1.y - 20); await page.mouse.down(); await page.mouse.move(p3.x + p3.width + 20, p3.y + p3.height + 20, { steps: 8 }); await page.mouse.up();
    assert.deepEqual(await selected(), ['Quillon · Part 1', 'Veyra · Part 2', 'Orilo · Part 3'], 'the box selects what it covers');
    assert.equal(await where(), placed, 'drawing a box moved nothing');
    // A click inside the boxed group picks that agent, never the whole group.
    await shiftClick('Veyra · Part 2');
    assert.deepEqual(await selected(), ['Quillon · Part 1', 'Orilo · Part 3'], 'Shift+click inside a box takes that agent out');
    assert.equal(await where(), placed, 'and moves nothing');
    const view = () => canvas.locator('.react-flow__viewport').evaluate(item => item.style.transform);
    const before = await view();
    await page.mouse.move(pane.x + 30, pane.y + 30); await page.mouse.down({ button: 'middle' }); await page.mouse.move(pane.x + 130, pane.y + 90, { steps: 6 }); await page.mouse.up({ button: 'middle' });
    assert.notEqual(await view(), before, 'middle-drag pans');
    await fit();

    // Tab opens Add, and typing on the board starts a command with that key.
    const adder = canvas.getByRole('dialog', { name: 'Add agents', exact: true }), command = adder.getByRole('textbox', { name: 'Command', exact: true });
    await off(); await page.keyboard.press('Tab');
    await command.waitFor(); await page.keyboard.press('Escape'); await adder.waitFor({ state: 'hidden' });
    await off(); await page.keyboard.type('build');
    await command.waitFor();
    assert.equal(await command.inputValue(), 'build');
    await page.keyboard.press('Escape');

    // A note is for the user, never sent; it moves by its strip.
    await canvas.getByRole('button', { name: 'Note', exact: true }).click();
    const grip = canvas.locator('.canvas-note-grip').first(), from = await grip.boundingBox();
    await page.mouse.move(from.x + 20, from.y + 5); await page.mouse.down(); await page.mouse.move(from.x + 140, from.y + 65, { steps: 8 }); await page.mouse.up();
    const to = await grip.boundingBox();
    assert.ok(Math.abs(to.x - from.x - 120) < 25 && Math.abs(to.y - from.y - 60) < 25, `the note moved by its strip (${Math.round(to.x - from.x)}, ${Math.round(to.y - from.y)})`);
    await page.keyboard.press('Delete');
    await off(); await page.keyboard.press('Control+z');
    await page.waitForTimeout(450);

    // An agent's dots are easy to hit: a press up to 12 px from a dot's centre still lands on the dot.
    const dot = await node('Quillon · Part 1').locator('.react-flow__handle.source').boundingBox(), centre = { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 };
    for (const [dx, dy] of [[12, 0], [0, 12], [-9, -9], [9, 9]])
      assert.ok(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('.react-flow__handle')), [centre.x + dx, centre.y + dy]), `a press ${dx}, ${dy} px from the dot lands on it`);

    // The side panel folds away to give the board the whole width (remembered); choosing an agent brings it back.
    const boardWidth = async () => (await canvas.locator('.react-flow').boundingBox()).width;
    const wide = await boardWidth();
    await canvas.getByRole('button', { name: 'Side panel', exact: true }).click();
    await canvas.getByRole('complementary').waitFor({ state: 'detached' });
    assert.ok(await boardWidth() > wide + 200, 'the board took the panel\'s width');
    await page.reload(); await page.getByRole('button', { name: 'Workflows', exact: true }).click(); await canvas.waitFor();
    assert.equal(await canvas.getByRole('complementary').count(), 0, 'the folded panel stays folded');
    await fit(); await node('Quillon · Part 1').click();
    await canvas.getByRole('complementary', { name: 'Selected agent', exact: true }).waitFor();
    await canvas.getByRole('complementary', { name: 'Selected agent', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();

    // A guide links Anthropic's and LangGraph's own advice on teams of agents.
    assert.deepEqual(await canvas.getByRole('region', { name: 'Guide' }).getByRole('link').evaluateAll(links => links.map(link => new URL(link.href).hostname)), ['www.anthropic.com', 'claude.com', 'www.anthropic.com', 'code.claude.com', 'blog.langchain.com']);

    // The header fits a small window: nothing runs past its edge or is cut off.
    for (const width of [1130, 960]) {
      await page.setViewportSize({ width, height: 660 }); await page.waitForTimeout(150);
      assert.deepEqual(await canvas.locator('.canvas-header').evaluate(header => { const box = header.getBoundingClientRect(); return [header.scrollWidth <= header.clientWidth + 1, [...header.children].every(item => { const at = item.getBoundingClientRect(); return at.right <= box.right + 1 && item.scrollWidth <= item.clientWidth + 1; })]; }), [true, true], `the header fits at ${width} px`);
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(150);

    // Undo and redo, off any text field: Ctrl+Z takes back adding an agent; Ctrl+Shift+Z and Ctrl+Y bring it back.
    await canvas.getByRole('button', { name: 'Add agent', exact: true }).click();
    await agentCount(5, 'added');
    await off(); await page.keyboard.press('Control+z');
    await agentCount(4, 'undone');
    await page.keyboard.press('Control+Shift+z');
    await agentCount(5, 'redone');
    await page.keyboard.press('Control+z'); await agentCount(4, 'undone again');
    await page.keyboard.press('Control+y'); await agentCount(5, 'redone with Ctrl+Y');
    await page.keyboard.press('Control+z'); await agentCount(4, 'back to the default board');

    // Copy and paste keep the wires among the copied agents, never to the originals; the copies are selected.
    await fit();
    await node('Quillon · Part 1').click(); await node('Nuvani · Join the parts').click({ modifiers: ['Shift'] });
    await page.keyboard.press('Control+c');
    const board = await canvas.locator('.react-flow__pane').boundingBox();
    await page.mouse.move(board.x + board.width * 0.5, board.y + board.height * 0.85);
    await page.keyboard.press('Control+v');
    await agentCount(6, 'pasted');
    let graph = await saved();
    const copies = graph.nodes.filter(item => item.data?.title?.endsWith(' · Part 1') || item.data?.title?.endsWith(' · Join the parts'));
    assert.equal(copies.length, 4);
    assert.equal(new Set(graph.nodes.filter(item => item.type === 'agent').map(item => item.data.title)).size, 6, 'copies receive unique names');
    const copyIds = new Set(await canvas.locator('.react-flow__node-agent.selected').evaluateAll(list => list.map(item => item.dataset.id)));
    assert.equal(copyIds.size, 2, 'the two copies are selected');
    assert.ok(graph.edges.some(edge => copyIds.has(edge.source) && copyIds.has(edge.target)), 'the copies keep their wire');
    assert.ok(!graph.edges.some(edge => copyIds.has(edge.source) !== copyIds.has(edge.target)), 'no wire joins a copy to an original');
    // Ctrl+D duplicates the selection in one step, and one Ctrl+Z takes it back.
    await page.keyboard.press('Control+d');
    await agentCount(8, 'duplicated');
    await off(); await page.keyboard.press('Control+z');
    await agentCount(6, 'duplicate undone');

    // Delete keeping the flow (Ctrl+Delete): what waited for the agent now waits for what it waited for.
    await canvas.getByRole('button', { name: /^Sequential/ }).click();
    await node('Veyra · Step 2: build on it').waitFor();
    await node('Veyra · Step 2: build on it').click();
    await page.keyboard.press('Control+Delete');
    await agentCount(2, 'deleted keeping the flow');
    graph = await saved();
    assert.ok(wired(graph, 'Quillon · Step 1: the base', 'Orilo · Step 3: finish'), 'step 3 now waits for step 1');

    // Right-click menus: on an agent, its actions with their keys; Duplicate adds a copy.
    await node('Quillon · Step 1: the base').click({ button: 'right' });
    const agentMenu = canvas.getByRole('menu', { name: 'Agent Quillon · Step 1: the base', exact: true });
    assert.deepEqual(await agentMenu.getByRole('menuitem').allInnerTexts().then(list => list.map(item => item.split('\n')[0])), ['Dashboard', 'Rename', 'Add agents after it', 'Duplicate', 'Copy', 'Delete, keep the flow', 'Delete']);
    await agentMenu.getByRole('menuitem', { name: /^Duplicate/ }).click();
    await agentCount(3, 'duplicated from the menu');
    // On the board: add, paste, arrange and fit.
    await fit();
    await page.mouse.click(board.x + 20, board.y + 20, { button: 'right' });
    const boardMenu = canvas.getByRole('menu', { name: 'Board', exact: true });
    assert.deepEqual(await boardMenu.getByRole('menuitem').allInnerTexts().then(list => list.map(item => item.split('\n')[0])), ['Add agents', 'Add a note', 'Paste 2 agents', 'Arrange by run order', 'Fit the view']);
    await boardMenu.getByRole('menuitem', { name: /^Add agents/ }).click();
    await canvas.getByRole('dialog', { name: 'Add agents', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    // On a wire: the same menu a click opens.
    const wire = wires.first(), point = await wire.locator('.react-flow__edge-path').evaluate(path => { const at = path.getPointAtLength(path.getTotalLength() / 2), m = path.getScreenCTM(); return { x: at.x * m.a + at.y * m.c + m.e, y: at.x * m.b + at.y * m.d + m.f }; });
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await canvas.getByRole('menu', { name: 'Wire', exact: true }).waitFor();
    await page.keyboard.press('Escape');

    // F2 renames the selected agent: its name field takes the keys, with the name selected.
    await node('Orilo · Step 3: finish').click();
    await page.keyboard.press('F2');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Name');
    assert.deepEqual(await page.evaluate(() => [document.activeElement.getAttribute('aria-label'), document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd)]), ['Name', 'Orilo · Step 3: finish']);
    await page.keyboard.type('Finish it');
    assert.deepEqual(await titles(), ['Quillon · Step 1: the base', 'Finish it', 'Veyra · Step 1: the base']);

    // Home fits the whole graph back into view, however far it was zoomed.
    await off();
    for (let index = 0; index < 3; index++) await canvas.getByRole("button", { name: /zoom in/i }).click();
    await page.keyboard.press('Home'); await page.waitForTimeout(400);
    const area = await canvas.locator('.react-flow').boundingBox();
    for (const box of await canvas.locator('.react-flow__node-agent').evaluateAll(list => list.map(item => { const at = item.getBoundingClientRect(); return { x: at.x, y: at.y, right: at.right, bottom: at.bottom }; })))
      assert.ok(box.x >= area.x && box.right <= area.x + area.width && box.y >= area.y && box.bottom <= area.y + area.height, 'every agent is in view');

    // Run graph never stops for a missing goal: Elpis gives each agent what it lacks, from the team as drawn, and the
    // run starts.
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('done'), null, { timeout: 10000 });
    assert.match(plans.at(-1).goal, /^Run this team as drawn/);
    assert.equal(runs.length, 1);
    assert.ok(runs[0].tasks.filter(task => task.kind === 'implement').every(task => task.writeScopes.length), 'every agent got a folder');
    // "Let Elpis handle it": from a goal, Elpis designs the team; one Ctrl+Z puts the old board back.
    await canvas.getByRole('button', { name: 'Mother', exact: true }).click();
    const motherPanel = canvas.getByRole('complementary', { name: 'Mother', exact: true });
    await motherPanel.getByRole('textbox', { name: 'Goal', exact: true }).fill('Build a dark theme from scratch');
    await page.waitForTimeout(400);
    await motherPanel.getByRole('button', { name: 'Let Elpis design the team', exact: true }).click();
    await node('Use the theme').waitFor();
    assert.deepEqual(await titles(), ['Build the theme', 'Use the theme']);
    assert.ok(wired(await saved(), 'Build the theme', 'Use the theme'), 'the team is wired as designed');
    assert.equal(plans.at(-1).goal, 'Build a dark theme from scratch');
    await off(); await page.keyboard.press('Control+z');
    await agentCount(3, 'the design undone');
    // Free text in the command line that is no command goes to Elpis, which acts on the board.
    await off(); await page.keyboard.press('Tab'); await command.waitFor();
    await page.keyboard.type('Fix the login bug');
    assert.match(await adder.getByLabel('Will add').innerText(), /^Elpis/);
    await page.keyboard.press('Enter');
    await agentCount(4, 'Elpis added the agent asked for');
    assert.ok((await titles()).includes('Fix the login bug'));

    // Wiring, every way a hand tries it. From a right dot onto any part of another agent: it waits for this one. From a
    // left dot: this one waits for the other. With Alt held: the two work alongside (no order), a dashed line with no
    // arrows. From the Mother's dot: she takes no wires, and says so.
    await fit();
    const dragTo = async (from, end, onto, alt = false) => {
      const dot = await from.locator(`.react-flow__handle.${end}`).boundingBox(), body = await onto.boundingBox();
      if (alt) await page.keyboard.down('Alt');
      await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2); await page.mouse.down();
      await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2, { steps: 10 }); await page.mouse.up();
      if (alt) await page.keyboard.up('Alt');
      await page.waitForTimeout(450);
    };
    const edgesNow = async () => { const graph = await saved(), title = id => graph.nodes.find(item => item.id === id)?.data?.title ?? id; return graph.edges.map(edge => [title(edge.source), title(edge.target), edge.kind ?? 'waits']); };
    const fixer = node('Fix the login bug'), finisher = node('Finish it'), copy = node('Veyra · Step 1: the base'), base = node('Quillon · Step 1: the base').first();
    await dragTo(fixer, 'source', finisher);
    assert.ok((await edgesNow()).some(([a, b, kind]) => a === 'Fix the login bug' && b === 'Finish it' && kind === 'waits'), 'right dot onto a body: it waits for this one');
    await dragTo(copy, 'target', fixer);
    assert.equal((await edgesNow()).filter(([a, b]) => a === 'Fix the login bug' && b === 'Veyra · Step 1: the base').length, 1, 'left dot onto a body: this one waits for the other');
    await dragTo(base, 'source', node('Fix the login bug'), true);
    const alongside = (await edgesNow()).filter(([, , kind]) => kind === 'alongside');
    assert.deepEqual(alongside, [['Quillon · Step 1: the base', 'Fix the login bug', 'alongside']], 'Alt: the two work alongside');
    assert.equal(await canvas.locator('.react-flow__edge.canvas-edge-alongside .canvas-chevron').count(), 0, 'no arrows on a two-way wire');
    await dragTo(canvas.locator('.react-flow__node-mother'), 'source', finisher);
    await canvas.getByText(/The Mother starts every agent that waits for no one/).waitFor();
    // The wire's menu turns a two-way wire one-way, and back.
    const twoWay = canvas.locator('.react-flow__edge.canvas-edge-alongside .react-flow__edge-path');
    // Clicked where the wire shows, as a hand would: the first point along it that no agent covers.
    const mid = await twoWay.evaluate(path => { const m = path.getScreenCTM(); for (let step = 1; step < 20; step++) { const at = path.getPointAtLength(path.getTotalLength() * step / 20), x = at.x * m.a + at.y * m.c + m.e, y = at.x * m.b + at.y * m.d + m.f; if (document.elementFromPoint(x, y)?.closest('.react-flow__edge') === path.closest('.react-flow__edge')) return { x, y }; } return null; });
    assert.ok(mid, 'part of the two-way wire shows');
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    await canvas.getByRole('menu', { name: 'Wire', exact: true }).getByRole('menuitem', { name: /^Make it one-way/ }).click();
    await page.waitForTimeout(450);
    assert.equal((await edgesNow()).filter(([, , kind]) => kind === 'alongside').length, 0, 'now one-way');

    // FigJam's quick create: the + beside an agent makes the next one, wired after it, its prompt taking the keys, its
    // name following the prompt; the + below makes a parallel one waiting for the same agents. Nothing lands on anything.
    await fit();
    await node('Finish it').hover();
    await node('Finish it').getByRole('button', { name: 'Add the next agent after Finish it' }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Prompt');
    await page.keyboard.type('Write the release notes');
    await node('Write the release notes').waitFor();
    assert.ok((await edgesNow()).some(([a, b]) => a === 'Finish it' && b.endsWith(' · Write the release notes')), 'the next agent waits for it');
    await node('Write the release notes').hover();
    await node('Write the release notes').getByRole('button', { name: /^Add an agent beside .* · Write the release notes$/ }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Prompt' && !document.activeElement.value);
    await page.keyboard.type('Update the changelog');
    await node('Update the changelog').waitFor();
    assert.ok((await edgesNow()).some(([a, b]) => a === 'Finish it' && b.endsWith(' · Update the changelog')), 'the parallel agent waits for the same agent');
    // And beside an agent that feeds others, the parallel one feeds them too.
    await fit(); await node('Quillon · Step 1: the base').first().hover();
    await node('Quillon · Step 1: the base').first().getByRole('button', { name: 'Add an agent beside Quillon · Step 1: the base' }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Prompt' && !document.activeElement.value);
    await page.keyboard.type('Second base');
    await node('Second base').waitFor();
    assert.ok((await edgesNow()).some(([a, b]) => a.endsWith(' · Second base') && b === 'Finish it'), 'it feeds what its sibling feeds');
    await canvas.getByRole('button', { name: 'Add agent', exact: true }).click();
    await page.waitForTimeout(450);
    const overlaps = await canvas.locator('.react-flow__node-agent, .react-flow__node-note, .react-flow__node-mother').evaluateAll(list => { const boxes = list.map(item => item.getBoundingClientRect()); let count = 0; boxes.forEach((a, i) => boxes.slice(i + 1).forEach(b => { if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) count++; })); return count; });
    assert.equal(overlaps, 0, 'no agent or note lies on another');

    // Colour means state, as on Deus Ex's board: in the dark theme too, an idle wire and the selection outline are a
    // neutral grey, never the theme's gold.
    await page.evaluate(() => localStorage.setItem('elpis-theme', 'dark')); await page.reload();
    await page.getByRole('button', { name: 'Workflows', exact: true }).click(); await canvas.waitFor();
    await node('Quillon · Step 1: the base').first().click();
    // How colourful a computed colour is, 0 to 1: oklch's chroma (×5) or rgb's saturation.
    const saturation = color => { const values = color.match(/[\d.]+/g).map(Number); if (color.startsWith('oklch')) return values[1] * 5; const [r, g, b] = values.slice(0, 3).map(value => value / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), light = (max + min) / 2; return max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1)); };
    const idleWire = await wires.first().locator('.react-flow__edge-path').evaluate(path => getComputedStyle(path).stroke);
    const outline = await canvas.locator('.react-flow__node.selected .agent-node').first().evaluate(item => getComputedStyle(item).outlineColor);
    assert.ok(saturation(idleWire) < 0.2, `an idle wire is ${idleWire}`);
    assert.ok(saturation(outline) < 0.2, `the selection outline is ${outline}`);

    // With no project chosen, Run graph says so and offers the project menu right in its message.
    await page.evaluate(() => localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [], selectedId: null }))); await page.reload();
    await page.getByRole('button', { name: 'Workflows', exact: true }).click(); await canvas.waitFor();
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const alert = canvas.getByRole('alert').filter({ hasText: 'Choose the project the agents work in, then run again.' });
    await alert.waitFor();
    assert.match(await alert.innerText(), /project/i);
    assert.ok(await alert.locator('button').count() >= 1, 'the project menu sits in the message');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
