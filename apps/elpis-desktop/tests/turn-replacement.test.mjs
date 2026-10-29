import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { replacementEligibility, editableMessage, editBlocked, versionControl } from '../lib/turn-replacement.ts';

const text = (value, extra = {}) => ({ type: 'text', text: value, ...extra });
const entry = (content, id = 'user', turnId = 'turn') => ({ turnId, item: { id, type: 'userMessage', content } });
const complete = { historyComplete: true };

test('replacement permits a complete single-user text turn and ignores unrelated turns', () => {
  const result = replacementEligibility([
    entry([text('unrelated')], 'other', 'other-turn'),
    entry([text('First line\n\nمتن فارسی'), text('Last line', { textElements: [] })]),
    { turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: 'Done' } },
  ], 'turn', complete);
  assert.deepEqual(result, { allowed: true, prompt: 'First line\n\nمتن فارسی\nLast line', kept: [], messageId: 'user' });
});

test('replacement edits the typed text and keeps attachments, images, mentions and quoted files as they were', () => {
  for (const extra of [
    { type: 'localImage', path: '/tmp/book.png' },
    { type: 'image', url: 'data:image/png;base64,AAAA' },
    { type: 'mention', name: 'rag', path: 'app://rag' },
    { type: 'skill', name: 'experiment', path: '/tmp/SKILL.md' },
    text('File: note.txt\nBody', { text_elements: [{ byteRange: { start: 0, end: 5 }, placeholder: 'Attachment: note.txt' }] }),
    { type: 'futureInput', text: 'Do not drop me' },
  ]) {
    const result = replacementEligibility([entry([text('Typed'), extra])], 'turn', complete);
    assert.deepEqual(result, { allowed: true, prompt: 'Typed', kept: [extra], messageId: 'user' }, JSON.stringify(extra));
  }
  const imageOnly = replacementEligibility([entry([{ type: 'image', url: 'data:image/png;base64,AAAA' }])], 'turn', complete);
  assert.equal(imageOnly.allowed, true); assert.equal(imageOnly.prompt, '');
});

test('a turn with delivered follow-ups is edited from its first message only', () => {
  const entries = [entry([text('Starting prompt')]), entry([text('Delivered follow-up')], 'follow-up')];
  const result = replacementEligibility(entries, 'turn', complete);
  assert.deepEqual(result, { allowed: true, prompt: 'Starting prompt', kept: [], messageId: 'user' });
  assert.equal(editableMessage(result, 'user'), true); assert.equal(editableMessage(result, 'follow-up'), false);
  assert.equal(editBlocked(result, 'user'), undefined); assert.match(editBlocked(result, 'follow-up'), /first message/);
});

test('replacement refuses incomplete, absent and malformed turn input', () => {
  for (const [entries, turnId, options] of [
    [[entry([text('Visible prompt')])], 'turn', { historyComplete: false }],
    [[entry([text('Other turn')])], 'missing', complete],
    [[entry([])], 'turn', complete],
    [[entry([text('   ')])], 'turn', complete],
    [[entry([{ type: 'text', text: 42 }])], 'turn', complete],
    [[entry([{ type: 'text', text: 'Hello', textElements: 'unknown shape' }])], 'turn', complete],
    [[entry(['not a part'])], 'turn', complete],
    [[{ turnId: 'turn', item: null }], 'turn', complete],
  ]) {
    const result = replacementEligibility(entries, turnId, options);
    assert.equal(result.allowed, false); assert.ok(result.reason);
  }
});

test('the version control shows on the edited message only, and moves only when switching is allowed', () => {
  const option = { allowed: true, prompt: 'p', kept: [], messageId: 'user' };
  const versions = [{ turnId: 'turn', index: 2, count: 2, previous: 'older-chat' }];
  const shown = [];
  const control = versionControl(versions, 'turn', option, 'user', true, id => shown.push(id));
  assert.equal(control.index, 2); assert.equal(control.count, 2); assert.equal(control.onNext, undefined);
  control.onPrevious(); assert.deepEqual(shown, ['older-chat']);
  assert.equal(versionControl(versions, 'turn', option, 'follow-up', true, () => {}), undefined);
  assert.equal(versionControl(versions, 'other-turn', option, 'user', true, () => {}), undefined);
  assert.equal(versionControl(versions, 'turn', option, 'user', false, () => {}).onPrevious, undefined, 'no switching while a turn runs');
});

// Load the actual client component in memory: no Next server, browser, files written or remote images.
const require = createRequire(import.meta.url);
const { transpileModule, ModuleKind, JsxEmit } = require('typescript');
const { renderToStaticMarkup } = require('react-dom/server');
const { createElement } = require('react');
const root = fileURLToPath(new URL('../', import.meta.url));
const modules = new Map();
function loadComponent(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const local = createRequire(file);
  const load = id => {
    if (id.endsWith('.css')) return {};
    if (!id.startsWith('@/') && !id.startsWith('.')) return local(id);
    const target = id.startsWith('@/') ? path.join(root, id.slice(2)) : path.resolve(path.dirname(file), id);
    const source = ['', '.tsx', '.ts', '.js', '.cjs'].map(ext => target + ext).find(candidate => existsSync(candidate) && statSync(candidate).isFile());
    if (!source) throw Error(`Missing component source: ${id}`);
    return loadComponent(source);
  };
  const { outputText } = transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } });
  new Function('require', 'module', 'exports', outputText)(load, module, module.exports);
  return module.exports;
}
const { ChatMessage } = loadComponent(path.join(root, 'components/chat-message.tsx'));

test('actual user-message renderer shows attachment identity without requesting remote content', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Rendering must not fetch attachments'); };
  try {
    const html = renderToStaticMarkup(createElement(ChatMessage, { item: {
      id: 'attachment-user', type: 'userMessage', content: [
        { type: 'localImage', path: '/tmp/book.png' },
        { type: 'localAudio', path: '/tmp/voice.wav' },
        { type: 'image', fileId: 'file-book-4242' },
        { type: 'image', url: 'https://example.invalid/private-remote-4242.png' },
        { type: 'audio', url: 'data:audio/wav;base64,private-audio-4242' },
        { type: 'mention', name: 'RAG tool', path: 'app://rag' },
        { type: 'skill', name: 'Experiment', path: '/tmp/experiment/SKILL.md' },
      ],
    } }));
    for (const visible of ['Image', '/tmp/book.png', 'Audio', '/tmp/voice.wav', 'Mention', 'RAG tool', 'app://rag', 'Skill', '/tmp/experiment/SKILL.md']) assert(html.includes(visible), visible);
    assert.match(html, /href="https:\/\/example.invalid\/private-remote-4242.png"/);
    assert.doesNotMatch(html, /<img|<audio|private-audio-4242|file-book-4242/);
  } finally { globalThis.fetch = originalFetch; }
});

test('actual user-message renderer explains blocked edits and keeps ordinary text editable', () => {
  const item = { id: 'text-user', type: 'userMessage', content: [text('Original prompt')] };
  const editable = renderToStaticMarkup(createElement(ChatMessage, { item, onEdit: async () => {} }));
  assert.match(editable, /aria-label="Edit message"/); assert.match(editable, /Original prompt/);
  const blocked = renderToStaticMarkup(createElement(ChatMessage, { item, onEdit: async () => {}, editBlockedReason: 'Other instructions in this turn must be preserved.' }));
  assert.doesNotMatch(blocked, /aria-label="Edit message"/);
  assert.match(blocked, /Other instructions in this turn must be preserved\./);
  assert.doesNotMatch(blocked, /<p[^>]*>Other instructions in this turn must be preserved\.<\/p>/, 'blocked-edit explanations must not repeat under every message');
});
