import test from 'node:test';
import assert from 'node:assert/strict';
import { MONO, SANS, codeFontProblem, readingStyle } from '../lib/reading.ts';

const defaults = { transcriptSize: 'm', transcriptWidth: 's', interfaceFont: 'sans', codeFont: '' };

test('SETTINGS2 interface and code sizes have independent steps and reject obsolete choices', () => {
  assert.deepEqual(['s', 'm', 'l'].map(interfaceSize => readingStyle({ interfaceSize })['--interface-size']), ['14px', '16px', '18px']);
  assert.deepEqual(['s', 'm', 'l'].map(codeSize => readingStyle({ codeSize })['--code-size']), ['12px', '13px', '16px']);
  assert.equal(readingStyle({ interfaceSize: 'giant', codeSize: false })['--interface-size'], '16px');
});

test('the defaults are today’s look: 14px transcript, 740px columns, the sans stack, the mono stack', () => {
  assert.deepEqual(readingStyle(defaults), { '--interface-size': '16px', '--code-size': '13px', '--transcript-size': '14px', '--transcript-width': '740px', '--ui-font': SANS, '--chat-font': SANS, '--mono': MONO });
  assert.match(SANS, /^Inter, system-ui/);
  assert.match(MONO, /^"JetBrains Mono".*monospace$/);
});

test('text size and width each have three steps; the interface stays Inter', () => {
  assert.deepEqual(['s', 'm', 'l'].map(transcriptSize => readingStyle({ ...defaults, transcriptSize })['--transcript-size']), ['13px', '14px', '16px']);
  assert.deepEqual(['s', 'm', 'l'].map(transcriptWidth => readingStyle({ ...defaults, transcriptWidth })['--transcript-width']), ['740px', '900px', '1100px']);
  assert.equal(readingStyle({ ...defaults, interfaceFont: 'serif' })['--ui-font'], SANS);
});

test('a code font goes first, quoted, before the usual monospace fonts', () => {
  assert.equal(readingStyle({ ...defaults, codeFont: 'DejaVu Sans Mono' })['--mono'], `"DejaVu Sans Mono", ${MONO}`);
  assert.equal(readingStyle({ ...defaults, codeFont: '  Fira_Code 2.1-Retina  ' })['--mono'], `"Fira_Code 2.1-Retina", ${MONO}`, 'trimmed');
});

test('a code font name is one family name: letters, digits, spaces, - _ . and at most 80 characters', () => {
  for (const name of ['', 'Iosevka', 'JetBrains Mono NL', 'Fira_Code 2.1-Retina', 'Убунту Моно', 'x'.repeat(80)]) assert.equal(codeFontProblem(name), null, name);
  for (const name of ['Mono; color: red', '"Quoted"', 'A, monospace', 'url(x)', 'x'.repeat(81)]) assert.ok(codeFontProblem(name), name);
  assert.equal(codeFontProblem('a,b'), 'Use one font name: letters, digits, spaces, hyphens, underscores and dots.');
  assert.equal(codeFontProblem('x'.repeat(81)), 'Use 80 characters or fewer.');
  assert.equal(readingStyle({ ...defaults, codeFont: 'Mono; color: red' })['--mono'], MONO, 'a refused name is never applied');
});

test('unknown stored values fall back to the defaults', () => {
  assert.deepEqual(readingStyle({ transcriptSize: 'xl', transcriptWidth: 7, interfaceFont: 'comic', codeFont: null }), readingStyle(defaults));
});

test('legacy font choices normalize to Inter without changing the code font', () => {
  const style = chatFont => readingStyle({ ...defaults, interfaceFont: 'serif', codeFont: 'Custom Mono', chatFont });
  for (const choice of ['default', 'sans', 'serif', 'mono', 'system', 'bad']) assert.equal(style(choice)['--chat-font'], SANS);
  assert.equal(style('mono')['--mono'], `"Custom Mono", ${MONO}`);
  assert.equal(style('sans')['--ui-font'], SANS);
});
