import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { transcriptionStatus, createTranscription, normalizeAudio, transcribeMcp } from "./transcription.mts";
import { server, MODEL, call, status, fakeMcp, fakeHome } from "./transcription.fixtures.mts";
import type { MockRequest } from "./transcription.fixtures.mts";

test("the chat provider picks the transcriber: ChatGPT sign-in for ChatGPT, the Voice model for OpenRouter", () => {
  const config = server({ WHISPERTYPE_BACKEND: "local", WHISPERTYPE_CLOUD_MODEL: MODEL });
  assert.deepEqual(transcriptionStatus(config, "openai"), {
    available: true,
    backend: "codex",
    label: "ChatGPT sign-in (cloud)",
    source: "provider",
  });
  assert.deepEqual(transcriptionStatus(config, "openrouter"), {
    available: true,
    backend: "openrouter",
    label: `OpenRouter (cloud) · ${MODEL}`,
    source: "provider",
  });
  assert.equal(JSON.stringify(transcriptionStatus(config, "openai")).includes("private"), false);
});

// Masih (18 Oct): voice "should use whisper medium just like my local setup does", in every chat.
test("WHISPERTYPE_EVERY_CHAT makes the Settings → Voice engine stand for every chat, ChatGPT and OpenRouter ones included", () => {
  for (const provider of ["openai", "openrouter", "anthropic"])
    assert.deepEqual(
      transcriptionStatus(
        server({ WHISPERTYPE_BACKEND: "local", WHISPERTYPE_EVERY_CHAT: "1", WHISPERTYPE_CLOUD_MODEL: MODEL }),
        provider,
      ),
      { available: true, backend: "local", label: "Local WhisperType", source: "fallback" },
      provider,
    );
});

test("an explicitly chosen dictation engine also applies to Gemini chats", () => {
  const config = server({ WHISPERTYPE_BACKEND: "local", WHISPERTYPE_EVERY_CHAT: "1", ELPIS_DICTATION_EXPLICIT: "1" });
  assert.equal(transcriptionStatus(config, "google-gemini", { geminiKey: "fixture-key" }).backend, "local");
});

test("legacy Gemini routing remains unchanged until a Use for choice is saved", () => {
  const config = server({ WHISPERTYPE_BACKEND: "local", WHISPERTYPE_EVERY_CHAT: "1" });
  assert.equal(transcriptionStatus(config, "google-gemini", { geminiKey: "fixture-key" }).backend, "gemini");
});

test("explicit OpenRouter dictation needs the configured provider key and passes it only to the transcriber", async () => {
  const config = server({
    WHISPERTYPE_BACKEND: "openrouter",
    WHISPERTYPE_EVERY_CHAT: "1",
    ELPIS_DICTATION_EXPLICIT: "1",
    WHISPERTYPE_CLOUD_MODEL: MODEL,
  });
  assert.equal(transcriptionStatus(config, "openai", {}).available, false);
  assert.equal(transcriptionStatus(config, "openai", { openrouterKey: "fixture-provider-key" }).available, true);
  const received: unknown[] = [];
  const handle = createTranscription({
    definition: async () => config,
    environment: async () => ({ openrouterKey: "fixture-provider-key" }),
    normalize: async value => value,
    transcribe: async (_config, _audio, _signal, backend, _home, key) => {
      received.push({ backend, key });
      return "from selected provider";
    },
  });
  const result = await call(handle, "audio/wav", Buffer.from("clip"), { provider: "openai", backend: "openrouter" });
  assert.deepEqual(result.value, { text: "from selected provider" });
  assert.deepEqual(received, [{ backend: "openrouter", key: "fixture-provider-key" }]);
  assert.doesNotMatch(JSON.stringify(result), /fixture-provider-key/);
});

test("legacy every-chat OpenRouter dictation keeps its WhisperType credential until Use for is saved", async () => {
  const config = server({
    WHISPERTYPE_BACKEND: "openrouter",
    WHISPERTYPE_EVERY_CHAT: "1",
    WHISPERTYPE_CLOUD_MODEL: MODEL,
  });
  assert.equal(transcriptionStatus(config, "openai", {}).available, true);
  const received: unknown[] = [];
  const handle = createTranscription({
    definition: async () => config,
    environment: async () => ({ openrouterKey: "another-provider-key" }),
    normalize: async value => value,
    transcribe: async (_config, _audio, _signal, _backend, _home, key) => {
      received.push(key);
      return "legacy";
    },
  });
  assert.deepEqual(
    (await call(handle, "audio/wav", Buffer.from("clip"), { provider: "openai", backend: "openrouter" })).value,
    { text: "legacy" },
  );
  assert.deepEqual(received, [null]);
});

test("providers without a transcription Elpis can reach use the Settings fallback", () => {
  for (const provider of [
    "anthropic",
    "anthropic-credits",
    "claude",
    "gemini",
    "google-gemini",
    "lmstudio",
    "custom-gateway",
    undefined,
    "",
  ]) {
    assert.deepEqual(
      transcriptionStatus(server({ WHISPERTYPE_BACKEND: "local" }), provider),
      { available: true, backend: "local", label: "Local WhisperType", source: "fallback" },
      String(provider),
    );
    assert.deepEqual(
      transcriptionStatus(server({ WHISPERTYPE_BACKEND: "codex" }), provider),
      { available: true, backend: "codex", label: "ChatGPT sign-in (cloud)", source: "fallback" },
      String(provider),
    );
  }
});

test("OpenRouter needs its model from Settings → Voice, whether the chat or the fallback asks for it", () => {
  const reason = /Settings → Voice/;
  const bare = server({ WHISPERTYPE_BACKEND: "local" });
  assert.match(transcriptionStatus(bare, "openrouter").reason!, reason);
  assert.equal(transcriptionStatus(bare, "openrouter").available, false);
  assert.match(transcriptionStatus(server({ WHISPERTYPE_BACKEND: "openrouter" }), "anthropic").reason!, reason);
  assert.equal(
    transcriptionStatus(server({ WHISPERTYPE_BACKEND: "openrouter", WHISPERTYPE_CLOUD_MODEL: MODEL }), "anthropic")
      .available,
    true,
  );
  assert.equal(transcriptionStatus(bare, "openai").available, true);
});

test("the fallback is never paid by default: ChatGPT sign-in while Elpis is signed in to ChatGPT, otherwise Local", () => {
  const unset = server({});
  assert.deepEqual(transcriptionStatus(unset, "anthropic", { chatgpt: true }), {
    available: true,
    backend: "codex",
    label: "ChatGPT sign-in (cloud)",
    source: "fallback",
  });
  assert.deepEqual(transcriptionStatus(unset, "claude", { chatgpt: false }), {
    available: true,
    backend: "local",
    label: "Local WhisperType",
    source: "fallback",
  });
  assert.equal(transcriptionStatus(unset, undefined).backend, "local", "nothing known about the account");
  // An explicit choice always stands, OpenRouter included.
  assert.equal(
    transcriptionStatus(server({ WHISPERTYPE_BACKEND: "local" }), "anthropic", { chatgpt: true }).backend,
    "local",
  );
  assert.equal(
    transcriptionStatus(server({ WHISPERTYPE_BACKEND: "openrouter", WHISPERTYPE_CLOUD_MODEL: MODEL }), "anthropic", {
      chatgpt: true,
    }).backend,
    "openrouter",
  );
  assert.equal(
    transcriptionStatus(server({ WHISPERTYPE_BACKEND: "codex" }), "anthropic", { chatgpt: false }).backend,
    "codex",
  );
});

test("Google Gemini chats use the Gemini API with the key Elpis holds, even without WhisperType", () => {
  const key = "AIza-private-key";
  const status = transcriptionStatus(server({ WHISPERTYPE_BACKEND: "local" }), "google-gemini", { geminiKey: key });
  assert.deepEqual(status, {
    available: true,
    backend: "gemini",
    label: "Gemini API (cloud) · gemini-flash-latest",
    source: "provider",
  });
  assert.equal(JSON.stringify(status).includes(key), false);
  assert.equal(transcriptionStatus(null, "google-gemini", { geminiKey: key }).backend, "gemini");
  assert.equal(
    transcriptionStatus({ ...server({}), enabled: false }, "google-gemini", { geminiKey: key }).backend,
    "gemini",
  );
  // No key: the chat has no transcriber of its own, so the fallback speaks.
  assert.equal(transcriptionStatus(server({ WHISPERTYPE_BACKEND: "local" }), "google-gemini", {}).source, "fallback");
  // Antigravity's id is "gemini" in the app; Elpis holds no Antigravity credential, so it never borrows the API key.
  assert.equal(
    transcriptionStatus(server({ WHISPERTYPE_BACKEND: "local" }), "gemini", { geminiKey: key }).backend,
    "local",
  );
});

test("a missing or remote WhisperType server is unavailable; one switched off for agents still dictates", () => {
  const config = server({ WHISPERTYPE_BACKEND: "codex", WHISPERTYPE_CLOUD_MODEL: MODEL });
  for (const provider of ["openai", "openrouter", "anthropic", undefined]) {
    for (const def of [null, { url: "https://mcp.example" }])
      assert.equal(transcriptionStatus(def, provider).available, false);
    assert.equal(transcriptionStatus({ ...config, enabled: false }, provider).available, true);
  }
});

test("an unsupported fallback engine stops only the providers that need the fallback", () => {
  const config = server({ WHISPERTYPE_BACKEND: "invalid" });
  assert.equal(transcriptionStatus(config, "anthropic").available, false);
  assert.equal(transcriptionStatus(config, undefined).available, false);
  assert.equal(transcriptionStatus(config, "openai").available, true);
});

test("audio route enforces type/size, never accepts command overrides, and returns transcript only", async () => {
  const seen: unknown[] = [];
  const handle = createTranscription({
    definition: async () => ({ command: "configured-server", env: { WHISPERTYPE_BACKEND: "local" } }),
    normalize: async audio => audio,
    transcribe: async (config, audio) => {
      seen.push([config.command, audio.toString()]);
      return "متن گفتار";
    },
  });
  assert.deepEqual(await call(handle, "audio/webm;codecs=opus"), { status: 200, value: { text: "متن گفتار" } });
  assert.deepEqual(seen, [["configured-server", "clip"]]);
  await assert.rejects(call(handle, "application/json", Buffer.from('{"command":"wrong"}')), /audio/i);
  await assert.rejects(call(handle, "audio/webm", Buffer.alloc(8 * 1024 * 1024 + 1)), /large/i);
  assert.equal(seen.length, 1);
  const changed = createTranscription({
    definition: async () => ({ command: "server", env: { WHISPERTYPE_BACKEND: "codex" } }),
    normalize: async () => {
      throw Error("Must not process audio after an unseen provider change");
    },
  });
  await assert.rejects(call(changed, "audio/wav"), /provider changed/i);
});

test("the route answers for the chat provider and records with exactly that transcriber", async () => {
  const backends: unknown[] = [];
  const handle = createTranscription({
    definition: async () => ({
      command: "server",
      env: { WHISPERTYPE_BACKEND: "local", WHISPERTYPE_CLOUD_MODEL: MODEL },
    }),
    normalize: async audio => audio,
    transcribe: async (_config, _audio, _signal, backend) => {
      backends.push(backend);
      return "text";
    },
  });
  assert.deepEqual((await status(handle, "openai")).value, {
    available: true,
    backend: "codex",
    label: "ChatGPT sign-in (cloud)",
    source: "provider",
  });
  assert.deepEqual((await status(handle, "anthropic")).value, {
    available: true,
    backend: "local",
    label: "Local WhisperType",
    source: "fallback",
  });
  assert.equal((await status(handle)).value.backend, "local");
  assert.equal((await status(handle, "x".repeat(200))).value.backend, "local"); // an unusable provider name is just another unknown provider
  assert.deepEqual(await call(handle, "audio/ogg", Buffer.from("clip"), { provider: "openai", backend: "codex" }), {
    status: 200,
    value: { text: "text" },
  });
  await call(handle, "audio/ogg", Buffer.from("clip"), { provider: "openrouter", backend: "openrouter" });
  await call(handle, "audio/ogg", Buffer.from("clip"), { provider: "claude", backend: "local" });
  assert.deepEqual(backends, ["codex", "openrouter", "local"]);
  await assert.rejects(
    call(handle, "audio/ogg", Buffer.from("clip"), { provider: "openai", backend: "local" }),
    /provider changed/i,
  ); // the page's route is stale
  assert.deepEqual(backends, ["codex", "openrouter", "local"]);
  const unavailable = createTranscription({
    definition: async () => ({ command: "server", env: { WHISPERTYPE_BACKEND: "local" } }),
    normalize: async audio => audio,
    transcribe: async () => "never",
  });
  await assert.rejects(
    call(unavailable, "audio/ogg", Buffer.from("clip"), { provider: "openrouter", backend: "openrouter" }),
    /Settings → Voice/,
  );
});

test("the route reads the private environment: the Gemini key reaches only the Gemini call and the Elpis home only the codex call", async () => {
  const seen: unknown[] = [];
  const key = "AIza-private-key",
    home = "/home/person/.elpis-test";
  const handle = createTranscription({
    definition: async () => server({ WHISPERTYPE_BACKEND: "local" }),
    environment: async () => ({ chatgpt: true, home, geminiKey: key }),
    normalize: async audio => audio,
    transcribe: async (_config, _audio, _signal, backend, elpisHome) => {
      seen.push(["mcp", backend, elpisHome]);
      return "from mcp";
    },
    gemini: async (geminiKey, audio) => {
      seen.push(["gemini", geminiKey === key, audio.toString()]);
      return "from gemini";
    },
  });
  assert.deepEqual((await status(handle, "google-gemini")).value, {
    available: true,
    backend: "gemini",
    label: "Gemini API (cloud) · gemini-flash-latest",
    source: "provider",
  });
  assert.deepEqual(
    await call(handle, "audio/ogg", Buffer.from("clip"), { provider: "google-gemini", backend: "gemini" }),
    { status: 200, value: { text: "from gemini" } },
  );
  assert.deepEqual(await call(handle, "audio/ogg", Buffer.from("clip"), { provider: "openai", backend: "codex" }), {
    status: 200,
    value: { text: "from mcp" },
  });
  assert.deepEqual(seen, [
    ["gemini", true, "clip"],
    ["mcp", "codex", home],
  ]);
  // A broken environment read never blocks dictation: the fallback is just Local.
  const broken = createTranscription({
    definition: async () => server({}),
    environment: async () => {
      throw Error("engine unavailable");
    },
  });
  assert.equal((await status(broken, "anthropic")).value.backend, "local");
});

test("dictation serializes work and cancellation reaches the owned request", async () => {
  let finish!: (value: string) => void;
  let started!: (signal: AbortSignal) => void;
  const ready = new Promise<AbortSignal>(resolve => {
    started = resolve;
  });
  const handle = createTranscription({
    definition: async () => ({ command: "server", env: { WHISPERTYPE_BACKEND: "local" } }),
    normalize: async audio => audio,
    transcribe: async (_def, _audio, signal) => {
      started(signal);
      return await new Promise(resolve => {
        finish = resolve;
      });
    },
  });
  const request = Readable.from([Buffer.from("clip")]) as MockRequest;
  request.method = "POST";
  request.headers = { "content-type": "audio/ogg", "x-elpis-transcription-backend": "local" };
  const response = new PassThrough();
  const pending = handle(request as IncomingMessage, response as unknown as ServerResponse, () => {});
  const signal = await ready;
  await assert.rejects(call(handle, "audio/ogg"), /already/i);
  response.emit("close");
  assert.equal(signal.aborted, true);
  finish("late response");
  await pending;
});

test("normalization rejects invalid audio rather than forwarding it to a provider", async () => {
  await assert.rejects(
    normalizeAudio(Buffer.from("not audio"), "audio/webm", new AbortController().signal),
    /recording/i,
  );
});

test("compressed upload size cannot bypass the two-minute decoded audio limit", async () => {
  const audio = Buffer.alloc(44 + 121 * 32000);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  await assert.rejects(normalizeAudio(audio, "audio/wav", new AbortController().signal), /two minutes/i);
});

test("MCP transcription initializes, calls only transcribe_audio and closes its child", async () => {
  const config = { command: process.execPath, args: ["-e", fakeMcp], env: { WHISPERTYPE_BACKEND: "local" } };
  assert.equal(
    await transcribeMcp(config, Buffer.from("clip"), new AbortController().signal),
    "Speech inserted into draft",
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(transcribeMcp(config, Buffer.from("clip"), cancelled.signal), /cancel/i);
});

test("MCP transcription asks WhisperType for the route chosen for this chat, not the configured fallback", async () => {
  const config = { command: process.execPath, args: ["-e", fakeMcp], env: { WHISPERTYPE_BACKEND: "codex" } };
  assert.equal(
    await transcribeMcp(config, Buffer.from("clip"), new AbortController().signal, "local"),
    "Speech inserted into draft",
  );
  await assert.rejects(
    transcribeMcp(config, Buffer.from("clip"), new AbortController().signal),
    /could not transcribe/i,
  ); // the fake accepts only backend "local"
});

test("the codex route reads the Elpis home ChatGPT sign-in; an explicit CODEX_HOME in the server env still wins", async () => {
  const run = (env: Record<string, string>, route: string, home: string | null) =>
    transcribeMcp(
      { command: process.execPath, args: ["-e", fakeHome], env },
      Buffer.from("clip"),
      new AbortController().signal,
      route,
      home,
    );
  assert.equal(await run({ WHISPERTYPE_BACKEND: "local" }, "codex", "/elpis/home"), "/elpis/home");
  assert.equal(
    await run({ WHISPERTYPE_BACKEND: "local", CODEX_HOME: "/chosen/home" }, "codex", "/elpis/home"),
    "/chosen/home",
  );
  assert.notEqual(
    await run({ WHISPERTYPE_BACKEND: "local" }, "local", "/elpis/home"),
    "/elpis/home",
    "other routes never get the Elpis home",
  );
  assert.equal(
    await run({ WHISPERTYPE_BACKEND: "local" }, "codex", null),
    String(process.env.CODEX_HOME),
    "no known Elpis home leaves the environment alone",
  );
});
