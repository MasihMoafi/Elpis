'use strict';
// Explicit opt-in: makes one live OpenRouter conversation using synthetic data only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Session } = require('../src/session');
const { runtimeOptions } = require('../src/providers');
(async () => {
  if (!process.env.ELPIS_LIVE_OPENROUTER || !process.env.OPENROUTER_API_KEY || !process.env.ELPIS_EDITOR_TEST_RUNTIME) throw new Error('Explicit live opt-in, runtime and OPENROUTER_API_KEY are required.');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-openrouter-live-'));
  await fs.writeFile(path.join(home, 'config.toml'), 'web_search = "disabled"\n[features]\nmulti_agent = false\n');
  const uri = 'file:///synthetic-provider-check.ts';
  const marker = `LIVE_EDITOR_${crypto.randomBytes(8).toString('hex')}`;
  let reads = 0;
  const bridge = { epoch: 0, cancel() { this.epoch++; }, async execute(name, args) {
    if (name === 'editor_documents') return { documents: [{ uri, languageId: 'typescript', version: 1 }] };
    assert.equal(name, 'editor_read'); assert.equal(args.uri, uri); reads++; return { uri, version: 1, text: marker };
  } };
  const model = process.env.ELPIS_LIVE_MODEL || 'openrouter/free';
  const session = new Session(home, bridge, runtimeOptions({ executable: process.env.ELPIS_EDITOR_TEST_RUNTIME, home, provider: 'openrouter', model }));
  let text = ''; session.on('delta', value => text += value);
  let timer;
  const evidence = { provider: 'openrouter', model, home, passed: false };
  try {
    const done = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Live conversation timed out')), 90000); session.once('completed', resolve); });
    const [turn] = await Promise.all([done, session.send(`Use editor_read to read ${uri}. Return its exact contents. The file is an editor buffer; do not use shell or other tools.`)]);
    assert.equal(turn.status, 'completed', JSON.stringify(turn)); assert(reads > 0); assert(text.includes(marker));
    evidence.passed = true; evidence.reads = reads;
  } catch (error) { evidence.error = error.message; throw error; }
  finally { clearTimeout(timer); session.dispose(); await fs.writeFile(path.join(home, 'result.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence)); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
