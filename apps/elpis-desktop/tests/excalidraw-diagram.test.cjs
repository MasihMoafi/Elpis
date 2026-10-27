const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const shapes = require('./fixtures/matilda-diagram.json');
const source = JSON.stringify(shapes);
const reply = 'The diagram is below.\n\n```excalidraw\n' + source + '\n```';
const evidence = process.env.ELPIS_DIAGRAM_EVIDENCE;

for (const colorScheme of ['light', 'dark']) {
  test(`chat embeds the reported diagram, keeps copying and ordinary code, and handles broken drawings (${colorScheme})`, { timeout: 45000 }, async t => {
    const f = await fixture({ colorScheme, width: 1200, height: 1000, chat: [['drawing', 'Draw the flow', reply + '\n\n```js\nconst ok = true;\n```\n\n```excalidraw\n[broken]\n```']] });
    t.after(() => f.close());
    await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').first().click();
    const image = f.page.getByRole('img', { name: 'Diagram', exact: true });
    await image.waitFor();
    await image.evaluate(img => img.decode());
    const body = f.page.locator('.message.agent').last();
    const actionBounds = await body.getByRole('group', { name: 'Diagram actions' }).first().boundingBox();
    const imageBounds = await image.boundingBox();
    assert.ok(actionBounds.y + actionBounds.height <= imageBounds.y, 'Copy controls stay above the diagram');
    assert.equal(await body.locator('pre .language-excalidraw').count(), 0);
    assert.doesNotMatch(await body.innerText(), /"strokeColor"|\[broken\]/);
    assert.match(await body.innerText(), /const ok = true/);
    await body.getByRole('button', { name: 'Copy diagram code', exact: true }).first().click();
    assert.equal((await f.copied()).trim(), source);
    await body.getByRole('button', { name: 'Copy code', exact: true }).click();
    assert.equal(await f.copied(), 'const ok = true;');
    await f.page.setViewportSize({ width: 390, height: 844 });
    const bounds = await image.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, JSON.stringify(bounds));
    if (evidence) {
      await fs.mkdir(evidence, { recursive: true });
      await f.page.setViewportSize({ width: 1200, height: 1000 });
      await image.screenshot({ path: path.join(evidence, `inline-${colorScheme}.png`) });
      await f.page.screenshot({ path: path.join(evidence, `chat-${colorScheme}.png`) });
    }
    assert.deepEqual(f.errors, []);
  });

  test(`the actual Love Spot canvas anchors the reported connectors to their boxes (${colorScheme})`, { timeout: 45000 }, async t => {
    const f = await loveSpotFixture({ colorScheme, reply });
    t.after(() => f.close());
    await f.page.setViewportSize({ width: 1400, height: 1200 });
    await f.open(f.page);
    await f.draw(f.page);
    const drawing = await f.waitFor(scene => scene.elements.some(e => e.id.startsWith('love-paint-') && e.type === 'arrow'), 'The reply painting did not arrive', 15000);
    const header = drawing.elements.find(e => e.id.startsWith('love-paint-') && e.id.endsWith('-0'));
    const first = drawing.elements.find(e => e.id === header.id.replace(/-0$/, '-2'));
    assert.deepEqual([first.x - header.x, first.y - header.y, first.points], [95, 64, [[0, 0], [0, 50]]]);
    const last = drawing.elements.find(e => e.id === header.id.replace(/-0$/, '-27'));
    assert.deepEqual([last.x - header.x, last.y - header.y, last.points], [524, 305, [[0, 0], [290, 75]]]);
    await f.page.keyboard.press('Shift+1');
    if (evidence) {
      await fs.mkdir(evidence, { recursive: true });
      await f.page.locator('.love-spot-editor').screenshot({ path: path.join(evidence, `board-${colorScheme}.png`) });
    }
    assert.deepEqual(f.errors, []);
  });
}
