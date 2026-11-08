import type { Page } from 'playwright-core';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');

const frame = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const report = async (name: string, value: unknown) => {
  console.log(JSON.stringify({ name, value }));
  if (process.env.ELPIS_RENDER_REPORT) await fs.appendFile(process.env.ELPIS_RENDER_REPORT, JSON.stringify({ name, value }) + '\n');
};

test('scrolling a long chat releases visited turns and preserves selection and navigation', async () => {
  const chat = Array.from({ length: 120 }, (_, index) => [`t${index}`, `Prompt ${index}`, Array.from({ length: 12 }, (_, line) => `Reply ${index} paragraph ${line}.`).join('\n\n')]);
  const f = await fixture({ width: 1440, height: 900, chat, ...(process.env.ELPIS_TEST_STATIC_DIR ? { staticDir: process.env.ELPIS_TEST_STATIC_DIR } : {}) });
  try {
    await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await f.page.locator('.message.agent').last().waitFor();
    const scroll = f.page.locator('.chat-scroll');
    // Traverse every turn in both directions, rather than counting the initial lazy mount.
    for (const reverse of [true, false]) {
      await scroll.hover();
      for (let index = 0; index < 120; index++) { await f.page.mouse.wheel(0, reverse ? -700 : 700); await frame(f.page); }
    }
    const mounted = await f.page.locator('.turn .message.agent').count();
    await report('visited-turns', { mounted, total: chat.length });
    assert.ok(mounted < 30, `${mounted} visited replies stayed mounted`);
    const last = f.page.locator('.turn .message.agent').nth(-2);
    await last.scrollIntoViewIfNeeded();
    const selected = await last.evaluate((element: HTMLElement) => {
      const node = element.querySelector('.markdown p')!;
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
    for (let index = 0; index < 12; index++) { await f.page.mouse.wheel(0, -1000); await frame(f.page); }
    assert.equal(await f.page.evaluate(() => window.getSelection()?.toString()), selected, 'scrolling cannot discard selected text');
    await f.page.evaluate(() => window.getSelection()?.removeAllRanges());
    // The prompt rail focuses placeholder message IDs to restore a virtualized turn.
    await f.page.locator('.turn').first().locator('[id]').first().focus();
    await f.page.getByText('Reply 0 paragraph 0.', { exact: true }).waitFor();
    if (process.env.ELPIS_SHOTS) await f.page.screenshot({ path: `${process.env.ELPIS_SHOTS}/virtualized-chat.png` });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a huge Markdown reply paints a bounded part and Copy code keeps the complete source', async () => {
  const code = Array.from({ length: 14000 }, (_, line) => `// large reply line ${line + 1}`).join('\n');
  const text = `A long Rust example.\n\n\`\`\`rust\n${code}\n\`\`\`\n\nLast paragraph.`;
  const f = await fixture({ width: 1440, height: 900, chat: [['large', 'Show the long example', text]], ...(process.env.ELPIS_TEST_STATIC_DIR ? { staticDir: process.env.ELPIS_TEST_STATIC_DIR } : {}) });
  try {
    const start = Date.now();
    await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await f.page.locator('.message.agent .markdown pre').waitFor(); await frame(f.page);
    const bytes = await f.page.locator('.message.agent .markdown').evaluate((element: HTMLElement) => element.textContent!.length);
    await report('large-message', { elapsedMs: Date.now() - start, renderedChars: bytes, sourceChars: text.length });
    assert.ok(bytes < 12000, `all ${bytes} source characters rendered at once`);
    const parts = f.page.getByRole('navigation', { name: 'Message parts' });
    await parts.getByRole('button', { name: 'Next part', exact: true }).click();
    assert.match(await f.page.locator('.message.agent .markdown pre').innerText(), /large reply line/);
    await f.page.locator('.message.agent').getByRole('button', { name: 'Copy code', exact: true }).click();
    assert.equal(await f.copied(), code, 'continued fences copy the original entire block');
    await parts.getByRole('button', { name: 'Previous part', exact: true }).click();
    await f.page.getByText('A long Rust example.', { exact: true }).waitFor();
    if (process.env.ELPIS_SHOTS) await f.page.screenshot({ path: `${process.env.ELPIS_SHOTS}/progressive-reply.png` });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
