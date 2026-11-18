import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadAloudProvider } from "./read-aloud-provider.mts";
import { createReaderWorker } from "./qwen.mts";
import { Readable } from "node:stream";

test("streaming reads are single-use and a changed source cannot play prepared audio", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "speech-stream-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const spoken: { text: string; speed?: number | undefined }[] = [];
  const warming = Promise.withResolvers<void>();
  const warmed: (string | null)[] = [];
  const reader = createReadAloudProvider({ home, kokoro: {
    available: () => true, voices: async () => ["qwen_aiden"], canStream: () => true,
    warm: voice => { warmed.push(voice); return warming.promise; },
    nativeTempo: true, preferredSpeed: 1.3,
    speak: async () => { throw Error("A streaming voice must not wait for a complete file"); },
    stream: async (text, _voice, _signal, speed) => { spoken.push({ text, speed }); return Readable.from([Buffer.from("audio")]); },
  }, provider: async () => { throw Error("No network provider should be called"); } });
  const status = await reader.status();
  assert.deepEqual(warmed, [null], "opening the chat starts loading the default voice without waiting");
  warming.resolve();
  assert.ok("streaming" in status);
  assert.equal(status.streaming, true);
  assert.equal(status.preferredSpeed, 1.3);
  await assert.rejects(reader.prepare({ text: "Invalid speed.", speed: 0 }), /speed/);
  const prepared = await reader.prepare({ text: "First sentence.", speed: 1.3 });
  assert.equal(spoken.length, 0, "prefetch does not load the model or start unused synthesis");
  const id = prepared.url.split("/").at(-1)!;
  const stream = await reader.stream(id, new AbortController().signal);
  for await (const _ of stream) { /* drain */ }
  assert.deepEqual(spoken, [{ text: "First sentence.", speed: 1.3 }]);
  const unused = await reader.prepare({ text: "A cancelled prefetch." });
  const unusedId = unused.url.split("/").at(-1)!;
  reader.release(unusedId);
  await assert.rejects(reader.stream(unusedId, new AbortController().signal), /expired/);
  await assert.rejects(reader.stream(id, new AbortController().signal), /expired/);
  const stale = await reader.prepare({ text: "Obsolete." });
  await reader.save({ source: "local", model: null, voice: "qwen_aiden" });
  await assert.rejects(reader.stream(stale.url.split("/").at(-1)!, new AbortController().signal), /changed/);
  assert.equal(spoken.length, 1);
});

test("Stop discards a read during model loading or synthesis without losing the shared worker", { timeout: 8000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qwen-adapter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker"));
  await fs.mkdir(path.join(root, "model/speech_tokenizer"), { recursive: true });
  await fs.writeFile(path.join(root, "model/model.safetensors"), "fixture");
  await fs.writeFile(path.join(root, "model/speech_tokenizer/model.safetensors"), "fixture");
  await fs.writeFile(path.join(root, "worker/synthesis.py"), `import time, os
def load():
    while not os.path.isfile(os.path.join(os.path.dirname(__file__), 'ready')):
        time.sleep(.01)
    def generate(text, voice):
        if text == 'Discard this.':
            open(os.path.join(os.path.dirname(__file__), 'discarded-text-reached-worker'), 'w').close()
        with open(os.environ['QWEN_TEST_PID'], 'w') as f: f.write(str(os.getpid()))
        yield object(), 24000, None
        for _ in range(40 if text == 'Hello.' else 1):
            time.sleep(.05)
            yield object(), 24000, None
    return generate
`);
  await fs.writeFile(path.join(root, "worker/numpy.py"), `class PCM:
    def __mul__(self, _): return self
    def astype(self, _): return self
    def tobytes(self): return b'\\x01\\x00' * 2400
def clip(*_): return PCM()
`);
  const reader = createReaderWorker({
    ...process.env, ELPIS_READ_ALOUD_ROOT: root, READ_ALOUD_QWEN_PYTHON: "/usr/bin/python3",
    READ_ALOUD_QWEN_MODEL: path.join(root, "model"), QWEN_TEST_PID: path.join(root, "pid"),
  });
  t.after(() => reader.close());
  assert.equal(reader.available(), true);
  const warming = reader.warm();
  const early = new AbortController();
  const discarded = reader.stream("Discard this.", "qwen_aiden", early.signal);
  const checked = Promise.all([
    warming,
    assert.rejects(discarded, /Reading was stopped/).finally(() => fs.writeFile(path.join(root, "worker/ready"), "")),
  ]);
  early.abort();
  await checked;
  const controller = new AbortController(), started = Date.now();
  const stream = await reader.stream("Hello.", "qwen_aiden", controller.signal);
  const first = await new Promise<Buffer>((resolve, reject) => { stream.once("data", resolve); stream.once("error", reject); });
  assert.equal(first[0], 0xff, "the streaming encoder emits a decodable MPEG frame");
  assert.ok(Date.now() - started < 1500, "initial sound must precede the delayed final chunk");
  const pid = Number(await fs.readFile(path.join(root, "pid"), "utf8"));
  const closed = new Promise<void>(resolve => stream.once("close", resolve));
  stream.on("error", () => {});
  controller.abort(); await closed;
  const warm = Date.now();
  const next = await reader.stream("Warm.", "qwen_aiden");
  await new Promise<void>((resolve, reject) => { next.once("data", () => resolve()); next.once("error", reject); });
  assert.ok(Date.now() - warm < 500, "cancelled generation cannot hold up the next reading");
  await assert.rejects(fs.access(path.join(root, "worker/discarded-text-reached-worker")), { code: "ENOENT" });
  next.on("error", () => {});
  reader.close();
  for (let retry = 0; retry < 30; retry++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("The stopped reading left its synthesis process running");
});

test("a missing Qwen installation rejects before starting a subprocess", async () => {
  const reader = createReaderWorker({ HOME: "/nonexistent-elpis-speech-home" });
  assert.equal(reader.available(), false);
  await assert.rejects(reader.stream("Hello.", null), /Install/);
  reader.close();
});
