const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const renderer = process.env.ELPIS_RENDERER_OUT;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');

test('chat displays local images inside and outside its folder and explains unreadable images', async () => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.cache', 'elpis-chat-images-finish-'));
  const cwd = path.join(root, 'project'), outside = path.join(root, 'generated');
  await fs.mkdir(cwd); await fs.mkdir(outside);
  await fs.writeFile(path.join(cwd, 'relative.png'), PNG);
  await fs.writeFile(path.join(outside, 'face with space.png'), PNG);
  await fs.writeFile(path.join(outside, 'invalid.png'), 'not an image');
  const { readFileAsset } = await import('../bridge/files.mjs');
  const reply = [
    `![Absolute](<${outside}/face with space.png>)`,
    `![File URI](file://${outside}/face%20with%20space.png)`,
    '![Relative](relative.png)',
    `![Missing](<${outside}/missing.png>)`,
    `![Invalid](<${outside}/invalid.png>)`,
  ].join('\n\n');
  const f = await fixture({ cwd, ...(renderer ? { staticDir: renderer } : {}), chat: [['images', 'Show the images.', reply], ['tail', 'Done?', 'Ready.']], routes: {
    '/api/file/asset': async (_body, url) => {
      try { const asset = await readFileAsset(url.searchParams.get('cwd'), url.searchParams.get('path')); return { __asset: asset }; }
      catch (e) { return { __http: e.status || 500, error: e.message }; }
    },
  } });
  try {
    await f.open('chat-a');
    for (const name of ['Absolute', 'File URI', 'Relative']) {
      const image = f.page.getByRole('img', { name, exact: true });
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(img => img.decode());
      assert.equal(await image.evaluate(img => img.naturalWidth), 8, `${name} renders actual PNG bytes`);
      assert.match(await image.getAttribute('src'), /^\/api\/file\/asset\?/);
    }
    for (const name of ['Missing', 'Invalid']) {
      const image = f.page.getByRole('img', { name, exact: true });
      if (await image.count()) await image.scrollIntoViewIfNeeded();
      await f.page.getByText(`${name} (image unavailable)`, { exact: true }).waitFor();
      assert.equal(await image.count(), 0, 'no broken-image icon remains');
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); await execFile('gio', ['trash', root]); }
});

