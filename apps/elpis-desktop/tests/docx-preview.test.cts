import type { Page } from 'playwright-core';
import type { fixture as Fixture } from './parity-fixture.cts';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { execFile }: typeof import('node:child_process') = require('node:child_process');
const { promisify }: typeof import('node:util') = require('node:util');
const { fixture }: { fixture: typeof Fixture } = require('./parity-fixture.cts');
type Request = { id: string; threadId: string; action: 'open'; path: string; view: 'preview' };
type DocumentWindow = Window & { __docxRequest?: (request: Request) => Promise<{ unsavedChanges: boolean }> };

async function setup(text = '# Agreement\n\nمتن فارسی — saved.\n') {
  const { makeDocx } = await import('./fixtures/docx.mts');
  const files = await import('../bridge/files.mts');
  const root = await fs.mkdtemp(path.join(os.homedir(), '.cache', 'elpis-docx-ui-'));
  const bytes = await makeDocx(text), file = path.join(root, 'agreement.docx');
  await fs.writeFile(file, bytes);
  await fs.writeFile(path.join(root, 'broken.docx'), 'Not a Word container');
  await fs.writeFile(path.join(root, 'notes.txt'), 'Keep this ordinary text editable.');
  const f = await fixture({ cwd: root, width: 1400, height: 850,
    chat: [['t1', 'Read these documents.',
      `Open [the Word document](${file}), [the damaged document](${root}/broken.docx) or [notes](${root}/notes.txt).`],
    ['t2', 'Ready?', 'Documents ready.']],
    routes: {
      '/api/file': async (_body, url) => {
        try { return await files.readFile(url.searchParams.get('cwd'), url.searchParams.get('path'), {
          ...(url.searchParams.has('page') ? { page: Number(url.searchParams.get('page')) } : {}),
          ...(url.searchParams.has('mtimeMs') ? { mtimeMs: Number(url.searchParams.get('mtimeMs')) } : {}),
        }); } catch (error) { return { __http: 422, error: error instanceof Error ? error.message : String(error) }; }
      },
      '/api/files/dir': (_body, url) => files.listDirectory(url.searchParams.get('cwd'), url.searchParams.get('dir') ?? ''),
    },
  });
  const page = f.page as unknown as Page;
  try { await f.open('chat-a'); }
  catch (error) { await f.close(); await promisify(execFile)('gio', ['trash', root]); throw error; }
  return { ...f, page, root, file, bytes,
    editor: (name: string) => page.getByRole('textbox', { name: `Contents of ${name}`, exact: true }),
    link: (name: string) => page.locator('.message.agent').getByRole('button', { name, exact: true }),
    close: async () => { await f.close(); await promisify(execFile)('gio', ['trash', root]); },
  };
}

test('a Word link opens selectable read-only Unicode without changing its original file', async () => {
  const f = await setup();
  try {
    await f.link('the Word document').click();
    const editor = f.editor('agreement.docx'); await editor.waitFor();
    assert.equal(await editor.getAttribute('aria-readonly'), 'true');
    await editor.click(); await f.page.keyboard.press('Control+a');
    const selected = await f.page.evaluate(() => window.getSelection()?.toString());
    assert.match(selected ?? '', /متن فارسی — saved/);
    await f.page.keyboard.type('This must not overwrite a Word document.');
    await f.page.keyboard.press('Control+s');
    assert.deepEqual(await fs.readFile(f.file), f.bytes);
    if (process.env.ELPIS_REVIEW_SHOTS) await f.page.screenshot({ path: path.join(process.env.ELPIS_REVIEW_SHOTS, 'docx-preview.png') });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the document tool receives its acknowledgment for a paged Word preview and navigation reads the following page', async () => {
  const f = await setup('# Start\n\n' + 'Text فارسی 日本語 🙂\n\n'.repeat(3500) + 'Last paragraph.\n');
  try {
    await f.page.addInitScript(() => {
      window.elpisDesktop!.documents = { subscribe: handler => {
        (window as DocumentWindow).__docxRequest = handler;
        return () => { delete (window as DocumentWindow).__docxRequest; };
      } };
    });
    await f.page.reload(); await f.open('chat-a');
    await f.page.waitForFunction(() => !!(window as DocumentWindow).__docxRequest);
    const receipt = await f.page.evaluate(file => (window as DocumentWindow).__docxRequest!({
      id: 'word-open', threadId: 'chat-a', action: 'open', path: file, view: 'preview',
    }), f.file);
    assert.deepEqual(receipt, { unsavedChanges: false });
    const pages = f.page.getByRole('group', { name: 'Document pages' });
    await pages.getByText(/Page 1 of/).waitFor();
    await pages.getByRole('button', { name: 'Next page', exact: true }).click();
    await pages.getByText(/Page 2 of/).waitFor();
    assert.equal(await f.editor('agreement.docx').getAttribute('aria-readonly'), 'true');
    await pages.getByRole('button', { name: 'Previous page', exact: true }).click();
    await pages.getByText(/Page 1 of/).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a damaged Word document offers recovery while another document and the chat draft stay usable', async () => {
  const f = await setup();
  try {
    const composer = f.page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await composer.fill('Keep this draft');
    await f.link('the damaged document').click();
    await f.page.getByText('This Word document is invalid. Open it in your document editor.', { exact: true }).waitFor();
    await f.link('notes').click();
    await f.editor('notes.txt').waitFor();
    assert.notEqual(await f.editor('notes.txt').getAttribute('aria-readonly'), 'true');
    assert.equal(await composer.inputValue(), 'Keep this draft');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
