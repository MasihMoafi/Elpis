// lib/dollar-math.ts: remark-math reads only dollars, so a reply's \( … \) and \[ … \] become dollars, a line that is only
// $$ … $$ becomes a display block, and code keeps its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dollarMath } from '../lib/dollar-math.ts';

test('bracket math becomes dollar math and a $$ line becomes a display block', () => {
  assert.equal(dollarMath('with brackets \\(\\frac{1}{2}\\).'), 'with brackets $\\frac{1}{2}$.');
  assert.equal(dollarMath('\\[ x^2 \\]'), '\n$$\nx^2\n$$\n');
  assert.equal(dollarMath('$$\\sum_{k=0}^{n} k$$'), '$$\n\\sum_{k=0}^{n} k\n$$');
  assert.equal(dollarMath('Plain $a^2$ stays.'), 'Plain $a^2$ stays.', 'single dollars are already what remark-math reads');
});

test('inline code and fenced code keep their source', () => {
  assert.equal(dollarMath('Code stays code: `\\(x\\)` and `$y$`, but \\(z\\) is math.'), 'Code stays code: `\\(x\\)` and `$y$`, but $z$ is math.');
  const fenced = '```\n\\[ not math \\]\n$$ also not $$\n```';
  assert.equal(dollarMath(fenced), fenced);
});
