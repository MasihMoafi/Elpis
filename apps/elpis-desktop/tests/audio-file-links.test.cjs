const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

test('audio file links play through Matilda without opening the Files preview', async () => {
  const cwd = '/workspace/audio-project', opened = [];
  const formats = ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus'];
  const reply = formats.map(ext => `[${ext}](<audio/recording with spaces.${ext}>)`).join(' ') + ' [missing](<audio/missing.mp3>)';
  const work = [{ id: 'created-audio', type: 'fileChange', status: 'completed', changes: formats.map(ext => ({ path: `audio/created recording.${ext}`, kind: { type: 'add' } })) }];
  const f = await fixture({ cwd, chat: [['t1', 'Listen', reply, work], ['t2', 'Continue', 'Ready.']],
    ...(process.env.ELPIS_TEST_STATIC_DIR ? { staticDir: process.env.ELPIS_TEST_STATIC_DIR } : {}),
    routes: { '/api/love-spot/companion': body => {
      if (!body) return { pinned: false, music: null, threadId: null };
      opened.push(body);
      return body.path.endsWith('/missing.mp3') ? { __http: 404, error: 'This audio file is unavailable.' } : { pinned: true, music: { status: 'Playing' } };
    }, '/api/files/dir': () => ({ data: formats.map(ext => ({ name: `recording with spaces.${ext}`, dir: false })) }) },
  });
  try {
    await f.open('chat-a');
    const links = f.page.locator('.message.agent').first();
    for (const ext of formats) {
      await links.getByRole('button', { name: ext, exact: true }).click();
      const deadline = Date.now() + 3000;
      while (opened.length < formats.indexOf(ext) + 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(opened.at(-1), { action: 'play-file', page: 'global', path: path.join(cwd, `audio/recording with spaces.${ext}`) });
    }
    assert.equal(await f.page.getByRole('region', { name: 'File viewer' }).count(), 0);
    for (const ext of formats) {
      await f.page.getByRole('button', { name: `Open created recording.${ext}`, exact: true }).click();
      const count = formats.length + formats.indexOf(ext) + 1, deadline = Date.now() + 3000;
      while (opened.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(opened.at(-1), { action: 'play-file', page: 'global', path: path.join(cwd, `audio/created recording.${ext}`) });
    }
    await f.page.getByRole('button', { name: 'Show side panel' }).click();
    const side = f.page.getByRole('region', { name: 'Side panel' });
    await side.getByRole('button', { name: 'New side panel tab', exact: true }).click();
    await f.page.getByRole('menuitem', { name: 'Files', exact: true }).click();
    const tree = side.getByRole('tree', { name: 'Project files' });
    for (const ext of formats) {
      await tree.getByRole('treeitem', { name: `recording with spaces.${ext}`, exact: true }).click();
      const count = formats.length * 2 + formats.indexOf(ext) + 1, deadline = Date.now() + 3000;
      while (opened.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(opened.at(-1), { action: 'play-file', page: 'global', path: path.join(cwd, `recording with spaces.${ext}`) });
    }
    assert.equal(await f.page.getByRole('region', { name: 'File viewer' }).count(), 0);
    await links.getByRole('button', { name: 'missing', exact: true }).click();
    await links.getByRole('alert').filter({ hasText: 'This audio file is unavailable.' }).waitFor();
    assert.deepEqual(f.errors, []);
    if (process.env.ELPIS_AUDIO_SHOT) await f.page.screenshot({ path: process.env.ELPIS_AUDIO_SHOT });
  } finally { await f.close(); }
});
