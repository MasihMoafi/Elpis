// One place for colours derived from the theme colour (Masih, 31 Oct: "one time, one place, fixed everywhere").
// A custom property that names var(--primary) is resolved where it is declared. Declared on the page only, it keeps the
// page's colour inside Love Spot, which has its own --primary: the red-and-teal mix. So every such colour lives in the
// single derived block (":root, .accent-scope" and ".dark, .dark .accent-scope") in app/globals.css, and nowhere else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const DERIVED = /var\(--(primary|gold|love-red|edge-color)\b/;
const SHARED = new Set([':root, .accent-scope', '.dark, .dark .accent-scope']);

function pageLevelRules(text) {
  const found = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ');
    if (!/^(:root|\.dark|html)\b/.test(selector) || selector.includes(' .') && !SHARED.has(selector)) continue;
    for (const declaration of match[2].split(';')) {
      const [name, ...value] = declaration.split(':');
      if (name.trim().startsWith('--') && DERIVED.test(value.join(':'))) found.push({ selector, name: name.trim() });
    }
  }
  return found;
}

test('colours derived from the theme colour are declared only in the shared derived block', () => {
  const stray = pageLevelRules(css).filter(rule => !SHARED.has(rule.selector));
  assert.deepEqual(stray, [], 'declare these in the derived block so Love Spot and other accent scopes recompute them');
  assert.ok(pageLevelRules(css).some(rule => rule.name === '--chat-box-glow'), 'the glow is in the derived block');
});

test('the check catches a derived colour declared on the page alone', () => {
  assert.deepEqual(pageLevelRules(':root { --halo:0 0 4px var(--primary); }').map(rule => rule.name), ['--halo']);
  assert.deepEqual(pageLevelRules(':root, .accent-scope { --halo:0 0 4px var(--primary); }').filter(rule => !SHARED.has(rule.selector)), []);
});

test('every place with its own --primary is an accent scope', () => {
  const scoped = [...css.matchAll(/([^{}]+)\{[^{}]*--primary\s*:/g)].map(match => match[1].trim()).filter(selector => !/^(:root|\.dark)/.test(selector));
  const markup = ['components/love-spot.tsx', 'app/page.tsx', 'components/matilda-companion.tsx', 'components/plan-card.tsx']
    .filter(file => fs.existsSync(new URL(`../${file}`, import.meta.url))).map(file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join('\n');
  assert.ok(scoped.length > 0);
  assert.ok((markup.match(/accent-scope/g) ?? []).length >= 5, 'Love Spot, its tools, its chats, Matilda\'s popup and its nav button are marked');
});
