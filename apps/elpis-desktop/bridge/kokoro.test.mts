import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createKokoro } from './kokoro.mts';
import { createReadAloudProvider } from './read-aloud-provider.mts';

test('Kokoro lists its installed voices and uses the selected voice', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-kokoro-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const paths = ['python', 'model', 'voices'].map(name => path.join(home, name));
  await Promise.all(paths.map(file => fs.writeFile(file, 'fixture')));
  const sent: { out: string; voice?: string; id: string }[] = [];
  const spawnWorker = () => {
    const stdin = Object.assign(new EventEmitter(), { write: (_raw: string) => {} });
    const worker = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => {}, stdin });
    stdin.write = (raw: string) => { const message = JSON.parse(raw) as { out: string; voice?: string; id: string }; sent.push(message); void fs.writeFile(message.out, 'wav').then(() => worker.stdout.emit('data', `${JSON.stringify({ id: message.id, ok: true })}\n`)); };
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

test('the worker refuses CPU-only or failed CUDA sessions before loading Kokoro', () => {
  const script = `
import runpy, sys, types
worker, mode = sys.argv[1:]
sys.argv = [worker, 'model', 'voices']
runtime = types.ModuleType('onnxruntime')
runtime.get_available_providers = lambda: ['CPUExecutionProvider'] if mode == 'unavailable' else ['CUDAExecutionProvider', 'CPUExecutionProvider']
runtime.SessionOptions = type('SessionOptions', (), {})
class Session:
    def __init__(self, *args, **kwargs): pass
    def get_providers(self): return ['CPUExecutionProvider']
    def disable_fallback(self): pass
runtime.InferenceSession = Session
sys.modules['onnxruntime'] = runtime
kokoro = types.ModuleType('kokoro_onnx')
class Kokoro:
    def __init__(self, *args): print('MODEL_LOADED', flush=True)
    @classmethod
    def from_session(cls, *args):
        print('MODEL_LOADED', flush=True)
        return cls()
    def get_voices(self): return []
kokoro.Kokoro = Kokoro
sys.modules['kokoro_onnx'] = kokoro
sys.modules['soundfile'] = types.ModuleType('soundfile')
runpy.run_path(worker, run_name='__main__')
`;
  const worker = fileURLToPath(new URL('./kokoro-worker.py', import.meta.url));
  for (const mode of ['unavailable', 'initialization-fell-back']) {
    const result = spawnSync('python3', ['-c', script, worker, mode], { input: '', encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0, mode);
    assert.doesNotMatch(result.stdout, /MODEL_LOADED/, mode);
    const message = JSON.parse(result.stdout.trim()) as { ready: boolean; error: string };
    assert.equal(message.ready, false, mode);
    assert.match(message.error, /GPU/i, mode);
  }
});

test('a GPU failure during speech cannot retry inference on the CPU', () => {
  const script = `
import runpy, sys, types
worker = sys.argv[1]
sys.argv = [worker, 'model', 'voices']
runtime = types.ModuleType('onnxruntime')
runtime.get_available_providers = lambda: ['CUDAExecutionProvider', 'CPUExecutionProvider']
runtime.SessionOptions = type('SessionOptions', (), {})
class Session:
    def __init__(self, *args, **kwargs): self.fallback = True
    def get_providers(self): return ['CUDAExecutionProvider', 'CPUExecutionProvider']
    def disable_fallback(self): self.fallback = False
    def run(self):
        if self.fallback:
            print('CPU_INFERENCE', flush=True)
            return [], 24000
        raise RuntimeError('GPU stopped')
runtime.InferenceSession = Session
sys.modules['onnxruntime'] = runtime
kokoro = types.ModuleType('kokoro_onnx')
class Kokoro:
    @classmethod
    def from_session(cls, session, voices):
        model = cls()
        model.session = session
        return model
    def get_voices(self): return ['af_heart']
    def create(self, *args, **kwargs): return self.session.run()
kokoro.Kokoro = Kokoro
sys.modules['kokoro_onnx'] = kokoro
sys.modules['soundfile'] = types.ModuleType('soundfile')
runpy.run_path(worker, run_name='__main__')
`;
  const worker = fileURLToPath(new URL('./kokoro-worker.py', import.meta.url));
  const result = spawnSync('python3', ['-c', script, worker], { input: `${JSON.stringify({ id: '1', text: 'Hello.', out: 'unused.wav' })}\n`, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /CPU_INFERENCE/);
  const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { ready?: boolean; id?: string; ok?: boolean });
  assert.equal(messages[0]?.ready, true);
  assert.equal(messages[1]?.id, '1');
  assert.equal(messages[1]?.ok, false);
});

test('a GPU startup failure reaches the caller instead of hanging', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-kokoro-start-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const paths = ['python', 'model', 'voices'].map(name => path.join(home, name));
  await Promise.all(paths.map(file => fs.writeFile(file, 'fixture')));
  const spawnWorker = () => {
    const worker = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => {}, stdin: Object.assign(new EventEmitter(), { write: () => {} }) });
    queueMicrotask(() => {
      worker.emit('exit', 1);
      worker.stdout.emit('data', `${JSON.stringify({ ready: false, error: 'Read aloud needs a working GPU.' })}\n`);
      worker.emit('close', 1);
    });
    return worker;
  };
  const kokoro = createKokoro({ env: { ELPIS_KOKORO_PYTHON: paths[0]!, ELPIS_KOKORO_MODEL: paths[1]!, ELPIS_KOKORO_VOICES: paths[2]! }, spawnWorker: spawnWorker as unknown as NonNullable<NonNullable<Parameters<typeof createKokoro>[0]>['spawnWorker']> });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([kokoro.speak('Hello.'), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Read aloud hung')), 1000); })]), /working GPU/i);
  } finally { clearTimeout(timer); }
});

test('local read aloud status reports a failed GPU startup and recovers', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-kokoro-status-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let attempts = 0;
  const kokoro = { available: () => true, voices: async () => { if (++attempts === 1) throw new Error('Read aloud needs a working GPU.'); return ['af_heart']; }, speak: async () => Buffer.from('wav') };
  const readAloud = createReadAloudProvider({ home, kokoro, provider: async () => { throw new Error('Unexpected API provider'); } });
  const unavailable = await readAloud.status();
  assert.equal(unavailable.available, false);
  assert.ok('reason' in unavailable);
  assert.match(unavailable.reason ?? '', /GPU/);
  const recovered = await readAloud.status();
  assert.equal(recovered.available, true);
});

test('a broken worker pipe rejects speech without an uncaught error', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-kokoro-pipe-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const paths = ['python', 'model', 'voices'].map(name => path.join(home, name));
  await Promise.all(paths.map(file => fs.writeFile(file, 'fixture')));
  let uncaught: Error | null = null, starts = 0;
  const spawnWorker = () => {
    starts++;
    const stdin = Object.assign(new EventEmitter(), { write: () => {} });
    const worker = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => {}, stdin });
    worker.kill = () => { queueMicrotask(() => worker.emit('close', 1)); };
    stdin.write = () => queueMicrotask(() => {
      try { stdin.emit('error', new Error('EPIPE')); }
      catch (error) { uncaught = error as Error; worker.emit('close', 1); }
    });
    queueMicrotask(() => worker.stdout.emit('data', `${JSON.stringify({ ready: true, voices: ['af_heart'] })}\n`));
    return worker;
  };
  const kokoro = createKokoro({ env: { ELPIS_KOKORO_PYTHON: paths[0]!, ELPIS_KOKORO_MODEL: paths[1]!, ELPIS_KOKORO_VOICES: paths[2]! }, spawnWorker: spawnWorker as unknown as NonNullable<NonNullable<Parameters<typeof createKokoro>[0]>['spawnWorker']> });
  await assert.rejects(kokoro.speak('Hello.'), /stopped|try again/i);
  assert.equal(uncaught, null, 'the bridge must handle stream errors');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await kokoro.voices(), ['af_heart']);
  assert.equal(starts, 2, 'a broken worker is replaced before the next use');
});
