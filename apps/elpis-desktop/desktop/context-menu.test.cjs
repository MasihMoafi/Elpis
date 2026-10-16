'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { contextMenuTemplate, attachContextMenu } = require('./context-menu.cjs');

const ORIGIN = 'http://127.0.0.1:45001';
const flags = (over = {}) => ({ canCut: false, canCopy: false, canPaste: false, canSelectAll: true, canUndo: false, canRedo: false, canDelete: false, canEditRichly: false, ...over });
const params = (over = {}) => ({ x: 40, y: 50, isEditable: false, selectionText: '', misspelledWord: '', dictionarySuggestions: [], linkURL: '', linkText: '', srcURL: '', mediaType: 'none', editFlags: flags(), ...over });

function setup() {
  const calls = [];
  const contents = {};
  for (const name of ['cut', 'copy', 'paste', 'selectAll']) contents[name] = () => calls.push(name);
  contents.replaceMisspelling = word => calls.push(['replaceMisspelling', word]);
  contents.copyImageAt = (x, y) => calls.push(['copyImageAt', x, y]);
  contents.downloadURL = url => calls.push(['downloadURL', url]);
  contents.session = { addWordToSpellCheckerDictionary: word => calls.push(['learn', word]) };
  const clipboard = { writeText: text => calls.push(['writeText', text]) };
  const openLink = url => calls.push(['openLink', url]);
  const template = over => contextMenuTemplate(params(over), { contents, clipboard, openLink, origin: ORIGIN });
  const labels = items => items.map(item => item.type === 'separator' ? '|' : item.label);
  return { calls, template, labels, contents, clipboard, openLink };
}
const click = (items, label) => items.find(item => item.label === label).click();

test('a click on plain page text with nothing selected shows no menu', () => {
  assert.deepEqual(setup().template(), []);
});

test('selected text outside a field offers Copy only', () => {
  const { template, labels, calls } = setup();
  const items = template({ selectionText: 'a sentence', editFlags: flags({ canCopy: true }) });
  assert.deepEqual(labels(items), ['Copy']);
  assert.equal(items[0].enabled, true);
  click(items, 'Copy');
  assert.deepEqual(calls, ['copy']);
});

test('an editable field offers Cut, Copy, Paste and Select all, enabled by what the field can do', () => {
  const { template, labels, calls } = setup();
  const empty = template({ isEditable: true, editFlags: flags({ canPaste: true }) });
  assert.deepEqual(labels(empty), ['Cut', 'Copy', 'Paste', 'Select all']);
  assert.deepEqual(empty.map(item => item.enabled), [false, false, true, true]);
  const selected = template({ isEditable: true, selectionText: 'abc', editFlags: flags({ canCut: true, canCopy: true, canPaste: true }) });
  assert.deepEqual(selected.map(item => item.enabled), [true, true, true, true]);
  for (const label of ['Cut', 'Copy', 'Paste', 'Select all']) click(selected, label);
  assert.deepEqual(calls, ['cut', 'copy', 'paste', 'selectAll']);
  assert.deepEqual(selected.map(item => item.accelerator), ['CmdOrCtrl+X', 'CmdOrCtrl+C', 'CmdOrCtrl+V', 'CmdOrCtrl+A']);
  assert.ok(selected.every(item => item.registerAccelerator === false), 'the shortcut is shown; the application menu still owns it');
});

test('a misspelled word lists the dictionary suggestions first, then Learn spelling', () => {
  const { template, labels, calls } = setup();
  const items = template({ isEditable: true, selectionText: 'teh', misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], editFlags: flags({ canCut: true, canCopy: true, canPaste: true }) });
  assert.deepEqual(labels(items), ['the', 'ten', '|', 'Learn spelling', '|', 'Cut', 'Copy', 'Paste', 'Select all']);
  click(items, 'ten');
  click(items, 'Learn spelling');
  assert.deepEqual(calls, [['replaceMisspelling', 'ten'], ['learn', 'teh']]);
  const none = template({ isEditable: true, misspelledWord: 'zzqx', dictionarySuggestions: [] });
  assert.deepEqual(labels(none).slice(0, 3), ['No guesses found', '|', 'Learn spelling']);
  assert.equal(none[0].enabled, false);
});

test('a misspelling outside an editable field is not offered a correction', () => {
  const { template, labels } = setup();
  assert.deepEqual(labels(template({ selectionText: 'teh', misspelledWord: 'teh', dictionarySuggestions: ['the'], editFlags: flags({ canCopy: true }) })), ['Copy']);
});

test('an outside link offers Open link and Copy link', () => {
  const { template, labels, calls } = setup();
  const items = template({ linkURL: 'https://example.com/docs', linkText: 'docs' });
  assert.deepEqual(labels(items), ['Open link', 'Copy link']);
  click(items, 'Open link');
  click(items, 'Copy link');
  assert.deepEqual(calls, [['openLink', 'https://example.com/docs'], ['writeText', 'https://example.com/docs']]);
});

test('links into the app itself, files and scripts get no link items', () => {
  const { template } = setup();
  for (const linkURL of [`${ORIGIN}/Users/me/report.md:12`, 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) assert.deepEqual(template({ linkURL }), [], linkURL);
});

test('selected text inside a link shows Copy before the link items', () => {
  const { template, labels } = setup();
  assert.deepEqual(labels(template({ linkURL: 'https://example.com', selectionText: 'example', editFlags: flags({ canCopy: true }) })), ['Copy', '|', 'Open link', 'Copy link']);
});

test('an image offers Copy image and Save image as', () => {
  const { template, labels, calls } = setup();
  const items = template({ mediaType: 'image', srcURL: `${ORIGIN}/api/threads/t1/media/0`, x: 12, y: 34 });
  assert.deepEqual(labels(items), ['Copy image', 'Save image as…']);
  click(items, 'Copy image');
  click(items, 'Save image as…');
  assert.deepEqual(calls, [['copyImageAt', 12, 34], ['downloadURL', `${ORIGIN}/api/threads/t1/media/0`]]);
  assert.deepEqual(labels(template({ mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' })), ['Copy image', 'Save image as…']);
  assert.deepEqual(labels(template({ mediaType: 'image', srcURL: 'file:///etc/passwd' })), ['Copy image'], 'only a fetchable address can be saved');
});

test('groups are separated once, never first, last or twice in a row', () => {
  const { template, labels } = setup();
  const items = template({ isEditable: true, selectionText: 'x', misspelledWord: 'x', linkURL: 'https://example.com', mediaType: 'image', srcURL: 'https://example.com/a.png', editFlags: flags({ canCopy: true }) });
  const shown = labels(items);
  assert.notEqual(shown[0], '|'); assert.notEqual(shown.at(-1), '|');
  assert.ok(!shown.some((entry, index) => entry === '|' && shown[index + 1] === '|'));
});

test('the menu is attached to a window and pops up only when it has items', () => {
  const { openLink, clipboard } = setup();
  const listeners = new Map(), popups = [];
  const contents = { session: {}, on: (name, listener) => listeners.set(name, listener), removeListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); }, copy() {} };
  const Menu = { buildFromTemplate: template => ({ template, popup: options => popups.push({ template, options }) }) };
  const window = { id: 7 };
  const dispose = attachContextMenu(contents, { Menu, clipboard, openLink, origin: ORIGIN, window });
  listeners.get('context-menu')({}, params());
  assert.deepEqual(popups, [], 'nothing to show');
  listeners.get('context-menu')({}, params({ selectionText: 'x', editFlags: flags({ canCopy: true }) }));
  assert.equal(popups.length, 1);
  assert.deepEqual(popups[0].options, { window });
  assert.deepEqual(popups[0].template.map(item => item.label), ['Copy']);
  dispose();
  assert.equal(listeners.size, 0);
});
