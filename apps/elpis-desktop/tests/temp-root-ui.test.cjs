const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTestTempDir, removeTestTempDir } = require('./temp-root.cjs');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

test('closing a real Love Spot UI removes its temp root without trashing it or another fixture', async t => {
  const sibling = createTestTempDir(path.join(os.tmpdir(), 'cleanup-sibling-'));
  t.after(() => removeTestTempDir(sibling));
  fs.writeFileSync(path.join(sibling, 'marker'), 'keep');
  const f = await loveSpotFixture();
  try {
    await f.open(f.page);
    await f.draw(f.page);
    await f.waitFor(scene => scene.elements.length > 0, 'drawing did not reach the owned fixture');
    assert.equal(fs.existsSync(f.root), true);
  } finally { await f.close(); }
  assert.equal(fs.existsSync(f.root), false);
  const trashInfo = path.join(os.homedir(), '.local/share/Trash/info', `${path.basename(f.root)}.trashinfo`);
  assert.equal(fs.existsSync(trashInfo), false, 'the fixture must not be sent to Trash');
  assert.equal(fs.readFileSync(path.join(sibling, 'marker'), 'utf8'), 'keep');
});
