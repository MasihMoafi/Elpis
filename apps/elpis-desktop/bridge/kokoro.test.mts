import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKokoro } from './kokoro.mts';

test('Kokoro lists its installed voices and uses the selected voice', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-kokoro-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const paths = ['python', 'model', 'voices'].map(name => path.join(home, name));
  await Promise.all(paths.map(file => fs.writeFile(file, 'fixture')));
  const sent: { out: string; voice?: string; id: string }[] = [];
  const spawnWorker = () => {
    const worker = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => {}, stdin: { write: (_raw: string) => {} } });
    worker.stdin = { write: (raw: string) => { const message = JSON.parse(raw) as { out: string; voice?: string; id: string }; sent.push(message); void fs.writeFile(message.out, 'wav').then(() => worker.stdout.emit('data', `${JSON.stringify({ id: message.id, ok: true })}\n`)); } };
    queueMicrotask(() => worker.stdout.emit('data', `${JSON.stringify({ ready: true, voices: ['af_heart', 'am_michael'] })}\n`));
    return worker;
  };
  const kokoro = createKokoro({ env: { ELPIS_KOKORO_PYTHON: paths[0]!, ELPIS_KOKORO_MODEL: paths[1]!, ELPIS_KOKORO_VOICES: paths[2]!, ELPIS_KOKORO_VOICE: 'af_heart' }, spawnWorker: spawnWorker as unknown as NonNullable<NonNullable<Parameters<typeof createKokoro>[0]>['spawnWorker']> });
  assert.equal(kokoro.defaultVoice, 'af_heart');
  assert.deepEqual(await kokoro.voices(), ['af_heart', 'am_michael']);
  assert.equal((await kokoro.speak('Hello.', 'am_michael')).toString(), 'wav');
  assert.equal(sent[0]!.voice, 'am_michael');
  await assert.rejects(kokoro.speak('Hello.', 'not-a-voice'), /voice/i);
});
