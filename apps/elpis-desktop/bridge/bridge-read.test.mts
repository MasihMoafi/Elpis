import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { required, useForSpeechFixture, fixture } from "./bridge.fixtures.mts";

test("Use for read aloud sends the selected OpenRouter model and saved key and returns MP3", async t => {
  const f = await useForSpeechFixture(t),
    request = await f.start();
  const saved = await request("/read-aloud/settings", {
    source: "openrouter",
    model: "fish-audio/drama-3",
    voice: null,
  });
  assert.equal(saved.status, 200, "the selected source can be saved");
  const response = await request("/read-aloud", { text: "A short reply." });
  assert.equal(response.status, 200);
  assert.match(required(response.headers.get("content-type")), /audio\/mpeg/);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "ID3-test-mp3");
  assert.equal(f.local.length, 0);
  assert.equal(f.fetches.length, 1);
  assert.equal(required(f.fetches[0]).url, "https://openrouter.ai/api/v1/audio/speech");
  assert.equal(new Headers(required(f.fetches[0]).options.headers).get("authorization"), "Bearer fixture-key");
  assert.deepEqual(JSON.parse(required(f.fetches[0]).options.body), {
    model: "fish-audio/drama-3",
    input: "A short reply.",
    response_format: "mp3",
  });
});

test("Use for converts documented Gemini PCM into a playable WAV without changing models", async t => {
  const f = await useForSpeechFixture(t, {
      contentType: "audio/pcm;rate=24000;channels=1",
      bytes: Buffer.from([0, 0, 255, 127]),
    }),
    request = await f.start();
  assert.equal(
    (
      await request("/read-aloud/settings", {
        source: "openrouter",
        model: "google/gemini-3.8-flash-tts",
        voice: "Kore",
      })
    ).status,
    200,
  );
  const response = await request("/read-aloud", { text: "Hello." });
  assert.equal(response.status, 200);
  assert.match(required(response.headers.get("content-type")), /audio\/wav/);
  const wav = Buffer.from(await response.arrayBuffer());
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.deepEqual(wav.subarray(44), Buffer.from([0, 0, 255, 127]));
  assert.deepEqual(JSON.parse(required(f.fetches[0]).options.body), {
    model: "google/gemini-3.8-flash-tts",
    input: "Hello.",
    voice: "Kore",
    response_format: "pcm",
  });
  assert.deepEqual(f.local, []);
});

test("Use for rejects PCM with an unexpected sample rate instead of playing it at the wrong speed", async t => {
  const f = await useForSpeechFixture(t, {
      contentType: "audio/pcm;rate=44100;channels=1",
      bytes: Buffer.from([0, 0, 255, 127]),
    }),
    request = await f.start();
  assert.equal(
    (
      await request("/read-aloud/settings", {
        source: "openrouter",
        model: "google/gemini-3.8-flash-tts",
        voice: "Kore",
      })
    ).status,
    200,
  );
  const response = await request("/read-aloud", { text: "Hello." });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /format|rate/i);
  assert.deepEqual(f.local, []);
});

test("Use for local read aloud survives a bridge restart and never calls the API", async t => {
  const f = await useForSpeechFixture(t);
  let request = await f.start();
  assert.equal(
    (await request("/read-aloud/settings", { source: "openrouter", model: "fish-audio/drama-3", voice: null })).status,
    200,
  );
  assert.equal((await request("/read-aloud", { text: "API before switching." })).status, 200);
  assert.equal(f.fetches.length, 1, "the API source was active before the switch");
  f.fetches.length = 0;
  assert.equal((await request("/read-aloud/settings", { source: "local", model: null, voice: null })).status, 200);
  await f.stop();
  request = await f.start();
  assert.equal((await (await request("/read-aloud/settings")).json()).source, "local");
  const response = await request("/read-aloud", { text: "Local reply." });
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "local-wav");
  assert.deepEqual(f.local, ["Local reply."]);
  assert.equal(f.fetches.length, 0);
});

test("Use for retains the chosen OpenRouter model across a bridge restart", async t => {
  const f = await useForSpeechFixture(t);
  let request = await f.start();
  assert.equal(
    (await request("/read-aloud/settings", { source: "openrouter", model: "fish-audio/drama-3", voice: null })).status,
    200,
  );
  await f.stop();
  request = await f.start();
  assert.deepEqual(await (await request("/read-aloud/settings")).json(), {
    source: "openrouter",
    model: "fish-audio/drama-3",
    voice: null,
  });
  assert.equal((await request("/read-aloud", { text: "After restart." })).status, 200);
  assert.equal(f.fetches.length, 1);
  assert.deepEqual(f.local, []);
});

test("Use for refuses a stale read aloud request instead of switching source mid-reply", async t => {
  const f = await useForSpeechFixture(t),
    request = await f.start();
  const before = await (await request("/read-aloud")).json();
  assert.equal(typeof before.revision, "string");
  assert.equal(
    (await request("/read-aloud/settings", { source: "openrouter", model: "fish-audio/drama-3", voice: null })).status,
    200,
  );
  const response = await request("/read-aloud", { text: "A short reply.", revision: before.revision });
  assert.equal(response.status, 409);
  assert.equal(f.fetches.length, 0);
  assert.equal(f.local.length, 0);
});

test("Use for limits speech to 4000 characters and refuses PCM-only models", async t => {
  const f = await useForSpeechFixture(t),
    request = await f.start();
  const unsupported = await request("/read-aloud/settings", {
    source: "openrouter",
    model: "heygen/heygen-voice-1-turbo:free",
    voice: "some-voice",
  });
  assert.equal(unsupported.status, 400);
  assert.match((await unsupported.json()).error, /PCM/i);
  assert.equal((await request("/read-aloud", { text: "a".repeat(4000) })).status, 200);
  assert.equal((await request("/read-aloud", { text: "a".repeat(4001) })).status, 400);
  assert.equal(f.local.length, 1);
  assert.equal(f.fetches.length, 0);
});

test("Use for refuses an unproven custom speech source without changing the current choice", async t => {
  const f = await useForSpeechFixture(t),
    request = await f.start();
  const result = await request("/read-aloud/settings", { source: "api-other", model: "other/model", voice: null });
  assert.equal(result.status, 400);
  assert.match((await result.json()).error, /does not support read aloud/i);
  assert.equal((await (await request("/read-aloud/settings")).json()).source, "local");
  assert.equal(f.fetches.length, 0);
});

for (const status of [401, 500])
  test(`Use for read aloud reports API HTTP ${status} without a local fallback`, async t => {
    const f = await useForSpeechFixture(t, { status }),
      request = await f.start();
    assert.equal(
      (await request("/read-aloud/settings", { source: "openrouter", model: "fish-audio/drama-3", voice: null }))
        .status,
      200,
    );
    const response = await request("/read-aloud", { text: "A short reply." });
    assert.ok(response.status >= 400);
    assert.match((await response.json()).error, /read aloud|api|key/i);
    assert.equal(f.fetches.length, 1);
    assert.deepEqual(f.local, []);
  });

test("Use for dictation saves the same WhisperType settings and applies them to every chat", async () => {
  const { client, socket, configRead } = fixture();
  await client.initialize();
  try {
    await client.saveMcp({
      version: "user-version",
      action: "whispertype",
      name: "whispertype",
      backend: "openrouter",
      model: "openai/whisper-1",
      everyChat: true,
    });
    assert.deepEqual(required(required(socket.sent.findLast(row => row.method === "config/batchWrite")).params).edits, [
      { keyPath: "mcp_servers.whispertype.env.WHISPERTYPE_BACKEND", value: "openrouter", mergeStrategy: "replace" },
      {
        keyPath: "mcp_servers.whispertype.env.WHISPERTYPE_CLOUD_MODEL",
        value: "openai/whisper-1",
        mergeStrategy: "replace",
      },
      { keyPath: "mcp_servers.whispertype.env.WHISPERTYPE_EVERY_CHAT", value: "1", mergeStrategy: "replace" },
      { keyPath: "mcp_servers.whispertype.env.ELPIS_DICTATION_EXPLICIT", value: "1", mergeStrategy: "replace" },
    ]);
    Object.assign(configRead.config.mcp_servers.whispertype.env, {
      WHISPERTYPE_BACKEND: "openrouter",
      WHISPERTYPE_CLOUD_MODEL: "openai/whisper-1",
      WHISPERTYPE_EVERY_CHAT: "1",
      ELPIS_DICTATION_EXPLICIT: "1",
    });
    assert.deepEqual(required((await client.mcp()).servers.find(server => server.name === "whispertype")).whispertype, {
      backend: "openrouter",
      model: "openai/whisper-1",
      everyChat: true,
      explicit: true,
    });
  } finally {
    client.close();
  }
});

test("Use for dictation privately resolves the configured OpenRouter provider key", async t => {
  const { client, configRead } = fixture();
  await client.initialize();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-dictation-key-"));
  t.after(async () => {
    client.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  required(configRead.layers[0]).name.file = path.join(home, "config.toml");
  configRead.config.model_providers.openrouter = {
    base_url: "https://openrouter.ai/api/v1",
    experimental_bearer_token: "fixture-provider-key",
  };
  const environment = await client.transcriptionEnvironment();
  assert.equal(environment.openrouterKey, "fixture-provider-key");
  assert.doesNotMatch(JSON.stringify(await client.mcp()), /fixture-provider-key/);
});

test("Use for chat can return the shared default to ChatGPT from another provider", async () => {
  const { client, configRead, socket } = fixture();
  await client.initialize();
  try {
    configRead.config.model_provider = "local";
    await client.saveSettings({ version: "user-version", main: { provider: "openai", model: "test-model" } });
    const edits = required(required(socket.sent.findLast(item => item.method === "config/batchWrite")).params).edits;
    assert.deepEqual(
      required(edits).map(item => [item.keyPath, item.value]),
      [
        ["model", "test-model"],
        ["model_provider", "openai"],
      ],
    );
  } finally {
    client.close();
  }
});

test("A32 default effort uses the shared versioned writer and rejects invalid values", async () => {
  const { client, socket } = fixture();
  await client.initialize();
  try {
    await client.saveSettings({ version: "user-version", options: { reasoningEffort: "high" } });
    assert.deepEqual(required(socket.sent.findLast(row => row.method === "config/batchWrite")).params, {
      expectedVersion: "user-version",
      reloadUserConfig: false,
      edits: [{ keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "replace" }],
    });
    const before = socket.sent.filter(row => row.method === "config/batchWrite").length;
    await assert.rejects(
      client.saveSettings({ version: "user-version", options: { reasoningEffort: "banana" } }),
      /listed values/,
    );
    assert.equal(socket.sent.filter(row => row.method === "config/batchWrite").length, before);
  } finally {
    client.close();
  }
});

test("A32 feature defaults use native advertised keys and refuse managed or forged changes", async () => {
  const { client, socket, requirementsRead } = fixture();
  await client.initialize();
  const send = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    if (request.method !== "experimentalFeature/list") return send(raw);
    socket.sent.push(request);
    queueMicrotask(() =>
      socket.emit(
        "message",
        JSON.stringify({
          id: request.id,
          result: {
            data: [{ name: "shell_tool", displayName: "Shell", enabled: true, stage: "stable" }],
            nextCursor: null,
          },
        }),
      ),
    );
  };
  try {
    const settings = await client.settings();
    assert.equal(required(settings.features.data[0]).enabled, true);
    await client.saveSettings({ version: "user-version", features: { shell_tool: false } });
    assert.deepEqual(required(required(socket.sent.findLast(row => row.method === "config/batchWrite")).params).edits, [
      { keyPath: 'features."shell_tool"', value: false, mergeStrategy: "replace" },
    ]);
    const writes = () => socket.sent.filter(row => row.method === "config/batchWrite").length;
    const before = writes();
    await assert.rejects(client.saveSettings({ version: "user-version", features: { shell_tool: "no" } }), /on or off/);
    await assert.rejects(client.saveSettings({ version: "user-version", features: { forged: true } }), /Unsupported/);
    requirementsRead.requirements = { featureRequirements: { shell_tool: true } };
    await assert.rejects(
      client.saveSettings({ version: "user-version", features: { shell_tool: false } }),
      /Managed policy/,
    );
    assert.equal(writes(), before);
  } finally {
    client.close();
  }
});

test("A32 missing or disabled writable config layers explain why and write nothing", async () => {
  const { client, socket, configRead } = fixture();
  await client.initialize();
  try {
    required(configRead.layers[0]).disabledReason = "Read-only policy";
    assert.equal((await client.settings()).write.available, false);
    await assert.rejects(
      client.saveSettings({ version: "user-version", options: { webSearch: "cached" } }),
      /no writable config/,
    );
    configRead.layers = [];
    await assert.rejects(
      client.saveSettings({ version: "user-version", options: { webSearch: "cached" } }),
      /no writable config/,
    );
    assert.equal(socket.sent.filter(row => row.method === "config/batchWrite").length, 0);
  } finally {
    client.close();
  }
});
