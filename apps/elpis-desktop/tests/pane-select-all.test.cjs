// Masih, 23 Oct: "inside of files in elpis when I press ctrl a it should only select all of that file (text for instance); it doesn't. It selects everything."
// One handler (lib/pane-select.ts) serves every content pane; here the open file and the Markdown preview of the Files pane, and the composer keeps its own select-all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const CWD = '/tmp/pane-select-project';
const FILES = { 'src/a.txt': 'alpha line one\nbeta line two\ngamma line three\n', 'docs/guide.md': '# Heading\n\nA paragraph of the guide.\n' };
const norm = text => text.replace(/\s+/g, ' ').trim();
const OTHERS = /Where is it|All green|New chat/;

test('Ctrl+A selects only the open file, only the preview, and only the composer text', async () => {
  const f = await fixture({ cwd: CWD, chat: [['pane', 'Where is it?', 'In `src/a.txt` and `docs/guide.md`.'], ['tail', 'Ready', 'All green.']], routes: {
    '/api/files/dir': () => ({ data: [] }),
    '/api/file': (_body, url) => { const content = FILES[url.searchParams.get('path')]; return { content, size: content.length, mtimeMs: 1 }; },
  } });
  try {
    const { page } = f; page.setDefaultTimeout(7000);
    await f.open('chat-a');
    const link = name => page.locator('.message.agent').getByRole('button', { name, exact: true });

    await link('src/a.txt').click();
    await page.getByRole('textbox', { name: 'Contents of src/a.txt', exact: true }).waitFor();
    await page.locator('.fe-gutter').click(); // the line numbers: focus is not in the text box
    await page.keyboard.press('Control+a');
    const file = await page.evaluate(() => { const box = document.activeElement; return { tag: box.tagName, all: box.selectionStart === 0 && box.selectionEnd === box.value.length, page: getSelection().toString() }; });
    assert.equal(file.tag, 'TEXTAREA', 'the file is what has the focus and the selection'); assert.equal(file.all, true, 'all of the file is selected');
    assert.doesNotMatch(file.page, OTHERS, 'nothing of the chat or the sidebar is selected with it');

    await link('docs/guide.md').click();
    const preview = page.getByRole('article', { name: 'Preview of docs/guide.md' }); await preview.waitFor();
    await preview.getByText('A paragraph of the guide.').click();
    await page.keyboard.press('Control+a');
    const markdown = await page.evaluate(() => ({ selected: getSelection().toString(), preview: document.querySelector('article.file-markdown').textContent }));
    assert.equal(norm(markdown.selected), norm(markdown.preview), 'exactly the preview is selected');
    assert.doesNotMatch(markdown.selected, OTHERS);

    const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await composer.fill('hello there'); await page.keyboard.press('Control+a');
    const typed = await page.evaluate(() => { const box = document.activeElement; return { all: box.selectionStart === 0 && box.selectionEnd === box.value.length, page: getSelection().toString() }; });
    assert.equal(typed.all, true); assert.doesNotMatch(typed.page, OTHERS, 'the composer keeps its own select-all');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
