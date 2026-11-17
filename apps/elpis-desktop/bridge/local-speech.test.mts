import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadAloudProvider } from "./read-aloud-provider.mts";
import { createQwen } from "./qwen.mts";
import { Readable } from "node:stream";

test("streaming reads are single-use and a changed source cannot play prepared audio", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "speech-stream-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const spoken: string[] = [];
  const reader = createReadAloudProvider({ home, kokoro: {
    available: () => true, voices: async () => ["qwen_aiden"], canStream: () => true,
    speak: async () => { throw Error("A streaming voice must not wait for a complete file"); },
    stream: async text => { spoken.push(text); return Readable.from([Buffer.from("audio")]); },
  }, provider: async () => { throw Error("No network provider should be called"); } });
  const status = await reader.status();
  assert.ok("streaming" in status);
  assert.equal(status.streaming, true);
  const prepared = await reader.prepare({ text: "First sentence." });
  assert.equal(spoken.length, 0, "prefetch does not load the model or start unused synthesis");
  const id = prepared.url.split("/").at(-1)!;
  const stream = await reader.stream(id, new AbortController().signal);
  for await (const _ of stream) { /* drain */ }
  assert.deepEqual(spoken, ["First sentence."]);
  await assert.rejects(reader.stream(id, new AbortController().signal), /expired/);
  const stale = await reader.prepare({ text: "Obsolete." });
  await reader.save({ source: "local", model: null, voice: "qwen_aiden" });
  await assert.rejects(reader.stream(stale.url.split("/").at(-1)!, new AbortController().signal), /changed/);
  assert.deepEqual(spoken, ["First sentence."]);
});

test("Qwen delivers initial PCM before synthesis ends and Stop cancels generation while retaining the warm model", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qwen-adapter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "worker"));
  await fs.mkdir(path.join(root, "model/speech_tokenizer"), { recursive: true });
  await fs.writeFile(path.join(root, "model/model.safetensors"), "fixture");
  await fs.writeFile(path.join(root, "model/speech_tokenizer/model.safetensors"), "fixture");
  await fs.writeFile(path.join(root, "worker/synthesis.py"), `import time, os
def load():
    def generate(text, voice):
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
  const reader = createQwen({
    ...process.env, ELPIS_READ_ALOUD_ROOT: root, READ_ALOUD_QWEN_PYTHON: "/usr/bin/python3",
    READ_ALOUD_QWEN_MODEL: path.join(root, "model"), QWEN_TEST_PID: path.join(root, "pid"),
  });
  t.after(() => reader.close());
  assert.equal(reader.available(), true);
  const controller = new AbortController(), started = Date.now();
  const stream = await reader.stream("Hello.", "qwen_aiden", controller.signal);
  const first = await new Promise<Buffer>((resolve, reject) => { stream.once("data", resolve); stream.once("error", reject); });
  assert.equal(first.subarray(0, 4).toString(), "RIFF");
  assert.ok(Date.now() - started < 1500, "initial sound must precede the delayed final chunk");
  const pid = Number(await fs.readFile(path.join(root, "pid"), "utf8"));
  const closed = new Promise<void>(resolve => stream.once("close", resolve));
  stream.on("error", () => {});
  controller.abort(); await closed;
  const warm = Date.now();
  const next = await reader.stream("Warm.", "qwen_aiden");
  await new Promise<void>((resolve, reject) => { next.once("data", () => resolve()); next.once("error", reject); });
  assert.ok(Date.now() - warm < 500, "cancelled generation cannot hold up the next reading");
  next.on("error", () => {});
  reader.close();
  for (let retry = 0; retry < 30; retry++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("The stopped reading left its synthesis process running");
});

test("a missing Qwen installation rejects before starting a subprocess", async () => {
  const reader = createQwen({ HOME: "/nonexistent-elpis-speech-home" });
  assert.equal(reader.available(), false);
  await assert.rejects(reader.stream("Hello.", null), /Install/);
  reader.close();
});
