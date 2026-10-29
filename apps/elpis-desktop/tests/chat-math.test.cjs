// Math in a reply renders as typeset formulas, as in the ChatGPT app (29 Oct, Masih: "We don't render math in the
// chat! Fix that! ASAP!"). The exported UI against tests/parity-fixture.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const reply = [
  'Inline with dollars $a^2 + b^2 = c^2$ and with brackets \\(\\frac{1}{2}\\).',
  '',
  '$$\\sum_{k=0}^{n} \\binom{n}{k} = 2^n$$',
  '',
  '\\[ \\int_0^1 x\\,dx = \\tfrac12 \\]',
  '',
  'Code stays code: `\\(x\\)` and `$y$`.',
].join('\n');

test('a reply’s $…$, $$…$$, \\(…\\) and \\[…\\] render as math; code keeps its source', async () => {
  const f = await fixture({ chat: [['math', 'Show me some math', reply], ['last', 'Thanks', 'Glad to help.']] }), { page } = f;
  try {
    await f.open('chat-a');
    const answer = page.locator('.message.assistant, .message.agent, .markdown').filter({ hasText: 'Code stays code' }).last();
    await answer.waitFor();
    assert.equal(await answer.locator('.katex-display').count(), 2, 'both display formulas are typeset');
    assert.equal(await answer.locator('.katex').count(), 4, 'two inline and two display formulas');
    assert.equal(await answer.locator('.katex-error').count(), 0);
    assert.deepEqual(await answer.locator('code').allInnerTexts(), ['\\(x\\)', '$y$'], 'inline code is not typeset');
    const font = await answer.locator('.katex').first().evaluate(node => getComputedStyle(node).fontFamily);
    assert.match(font, /KaTeX_Main/, 'the KaTeX stylesheet and fonts load');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
