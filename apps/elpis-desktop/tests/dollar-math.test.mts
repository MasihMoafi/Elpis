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

// 11 Nov, Masih's screenshot: "reported about $0.34 **. A fixed ten-question set … should be around **$0.70 before
// retries" showed as one italic formula with the words run together. A dollar of an amount is not a formula.
test('an amount of money is not a formula; a real formula beside one still is', () => {
  const said = 'reported about $0.34 **. A fixed set, should be around **$0.70 before retries. Replacing the $10 proposal.';
  assert.equal(dollarMath(said), said.replaceAll('$', '\\$'));
  assert.equal(dollarMath('It costs $5 and $6.'), 'It costs \\$5 and \\$6.');
  assert.equal(dollarMath('From $5-$10 a month.'), 'From \\$5-\\$10 a month.');
  assert.equal(dollarMath('Here $x^2$ costs $5.'), 'Here $x^2$ costs \\$5.');
  assert.equal(dollarMath('So \\(5\\) and $2n$ are numbers.'), 'So $5$ and $2n$ are numbers.', 'a formula may start with a digit');
  assert.equal(dollarMath('Then $3 + 4 = 7$ holds.'), 'Then $3 + 4 = 7$ holds.', 'a sum is a formula');
  const withFormula = 'about $0.34 **. A set, around **$0.70 before retries. The $10 proposal. Still math: $x^2$.';
  assert.equal(dollarMath(withFormula), withFormula.replace('$0.34', '\\$0.34').replace('$0.70', '\\$0.70').replace('$10', '\\$10'));
  assert.equal(dollarMath('It was $1,000,000, or $5/month, or $5k a year.'), 'It was \\$1,000,000, or \\$5/month, or \\$5k a year.');
  assert.equal(dollarMath('Already escaped \\$5 stays, and `$5 in code` stays.'), 'Already escaped \\$5 stays, and `$5 in code` stays.');
  assert.equal(dollarMath('$$\\sum_{k=0}^{n} k$$'), '$$\n\\sum_{k=0}^{n} k\n$$', 'display formulas are untouched');
});
