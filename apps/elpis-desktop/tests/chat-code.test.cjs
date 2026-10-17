// Code in a reply is coloured by its language, as in Claude's desktop app, with the language named on the block's bar;
// Copy code still copies the plain source. Local bridge fixture (tests/parity-fixture.cjs); no engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const SOURCE = 'const answer: number = 42; // the answer\nfunction parse(text: string) { return text.split(" "); }';
const REPLY = `Here it is:\n\n\`\`\`ts\n${SOURCE}\n\`\`\`\n\nPlain:\n\n\`\`\`\njust words\n\`\`\``;

for (const colorScheme of ['light', 'dark']) {
  test(`code in a reply is coloured by its language and named, and copies as plain text (${colorScheme})`, async () => {
    const f = await fixture({ colorScheme, chat: [['t1', 'Show the parser.', REPLY]] });
    try {
      const { page } = f;
      await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
      const block = page.locator('.code-block').first(); await block.waitFor();
      assert.equal(await block.locator('.code-block-language').innerText(), 'ts', 'the language is named on the bar');
      const colour = selector => block.locator(selector).first().evaluate(element => getComputedStyle(element).color);
      const plain = await block.locator('pre code').evaluate(element => getComputedStyle(element).color);
      const [keyword, comment, number] = [await colour('.hljs-keyword'), await colour('.hljs-comment'), await colour('.hljs-number')];
      assert.notEqual(keyword, plain, 'keywords have their own colour');
      assert.notEqual(comment, plain, 'comments have their own colour');
      assert.notEqual(comment, keyword);
      assert.notEqual(number, plain, 'numbers have their own colour');
      // A block with no language stays plain, with no name.
      const bare = page.locator('.code-block').nth(1);
      assert.equal(await bare.locator('[class*="hljs-"]').count(), 0);
      assert.equal(await bare.locator('.code-block-language').count(), 0);
      await block.hover();
      await block.getByRole('button', { name: 'Copy code', exact: true }).click();
      assert.equal(await f.copied(), SOURCE, 'Copy code copies the source as written');
      if (process.env.ELPIS_SHOTS) await block.screenshot({ path: `${process.env.ELPIS_SHOTS}/code-${colorScheme}.png` });
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
