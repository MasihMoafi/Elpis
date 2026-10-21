const assert = require('node:assert/strict');

// Range locates glyphs; only real mouse input creates the selection.
async function dragMessageText(page, message, fragment) {
  await message.scrollIntoViewIfNeeded();
  const points = await message.evaluate((element, fragment) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      const start = node.textContent.indexOf(fragment);
      if (start < 0) continue;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + fragment.length);
      const scroller = element.closest('.chat-scroll, .side-chat-content');
      if (scroller) {
        const rect = range.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
        if (rect.top < viewport.top || rect.bottom > viewport.bottom) scroller.scrollTop += rect.top - viewport.top - 40;
      }
      return [start, start + fragment.length].map(offset => {
        const range = document.createRange(); range.setStart(node, offset); range.collapse(true);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y + rect.height / 2 };
      });
    }
    throw new Error(`Missing selection fragment: ${fragment}`);
  }, fragment);
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 12 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), fragment);
}

module.exports = { dragMessageText };
