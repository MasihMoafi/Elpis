import test from "node:test";
import assert from "node:assert/strict";
import { createTranscription, transcribeGemini } from "./transcription.mts";
import { call, googleMock, spoken } from "./transcription.fixtures.mts";
import type { MockReply } from "./transcription.fixtures.mts";

test("Gemini transcription sends the documented generateContent request with the key in the header only", async () => {
  const google = await googleMock(() => spoken("  Hello from the recording.\n"));
  try {
    const wav = Buffer.from("RIFF....WAVEfmt fake-wav-bytes");
    const text = await transcribeGemini("AIza-private-key", wav, new AbortController().signal, { api: google.api });
    assert.equal(text, "Hello from the recording.");
    const [request] = google.requests;
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1beta/models/gemini-flash-latest:generateContent");
    assert.equal(request.headers["x-goog-api-key"], "AIza-private-key");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.url.includes("AIza"), false, "the key never goes in the URL");
    assert.deepEqual(Object.keys(request.body).sort(), ["contents", "generationConfig"]);
    const [turn] = request.body.contents;
    assert.ok(turn);
    assert.equal(turn.role, "user");
    assert.deepEqual(turn.parts[1]!, { inline_data: { mime_type: "audio/wav", data: wav.toString("base64") } });
    assert.match(turn.parts[0]!.text, /Transcribe .*verbatim.*transcript only/i);
    assert.deepEqual(request.body.generationConfig, { temperature: 0 });
  } finally {
    await google.close();
  }
});

test("Gemini transcription joins text parts, skips reasoning, and reports every failure without the key", async () => {
  const key = "AIza-private-key",
    signal = () => new AbortController().signal;
  const cases = [
    [
      {
        body: {
          candidates: [
            {
              content: { parts: [{ text: "thinking", thought: true }, { text: "Part one. " }, { text: "Part two." }] },
            },
          ],
        },
      },
      undefined,
      "Part one. Part two.",
    ],
    [{ body: { candidates: [] } }, /no transcript/i],
    [{ body: { candidates: [{ content: { parts: [{ text: "   " }] } }] } }, /no transcript/i],
    [{ body: { promptFeedback: { blockReason: "OTHER" } } }, /no transcript/i],
    [{ status: 403, body: { error: { message: `API key ${key} not valid` } } }, /rejected the API key/i],
    [
      {
        status: 400,
        body: {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "API key not valid. Please pass a valid API key.",
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
          },
        },
      },
      /rejected the API key/i,
    ], // how Google reports a bad key
    [
      { status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "unsupported audio" } } },
      /HTTP 400/,
    ],
    [{ status: 429, body: { error: { message: "quota" } } }, /rate/i],
    [{ status: 500, body: "oops" }, /HTTP 500/],
    [{ body: "{not json" }, /unreadable/i],
    [
      { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" }, body: "" },
      /could not be reached|redirect/i,
    ],
  ] satisfies [MockReply, RegExp | undefined, string?][];
  for (const [reply, failure, expected] of cases) {
    const google = await googleMock(() => reply);
    try {
      if (expected)
        assert.equal(await transcribeGemini(key, Buffer.from("x"), signal(), { api: google.api }), expected);
      else
        await assert.rejects(transcribeGemini(key, Buffer.from("x"), signal(), { api: google.api }), error => {
          assert.ok(error instanceof Error);
          assert.ok(failure);
          assert.match(error.message, failure);
          assert.equal(error.message.includes(key), false);
          return true;
        });
    } finally {
      await google.close();
    }
  }
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    transcribeGemini(key, Buffer.from("x"), aborted.signal, { api: "http://127.0.0.1:1/v1beta" }),
    /cancel/i,
  );
  await assert.rejects(
    transcribeGemini(key, Buffer.from("x"), signal(), { api: "http://127.0.0.1:1/v1beta" }),
    error => error instanceof Error && /could not be reached/i.test(error.message) && !error.message.includes(key),
  );
});

test("cancelling mid-request stops the Gemini call", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const google = await googleMock(() => {
    release();
    return spoken("late");
  });
  const controller = new AbortController();
  const pending = transcribeGemini("k", Buffer.from("x"), controller.signal, {
    api: google.api,
    fetchImpl: (url, init) => {
      controller.abort();
      return fetch(url, init);
    },
  });
  await assert.rejects(pending, /cancel/i);
  await google.close();
  void held;
});

test("a Google Gemini chat is transcribed end to end against a local Google stand-in, with no WhisperType at all", async () => {
  const google = await googleMock(() => spoken("Dictated through Gemini."));
  try {
    const handle = createTranscription({
      definition: async () => null,
      environment: async () => ({ chatgpt: false, home: "/unused", geminiKey: "AIza-private-key" }),
      normalize: async audio => audio,
      transcribe: async () => {
        throw Error("WhisperType must not run for a Gemini chat");
      },
      gemini: (key, audio, signal) => transcribeGemini(key, audio, signal, { api: google.api }),
    });
    assert.deepEqual(
      await call(handle, "audio/ogg", Buffer.from("spoken clip"), { provider: "google-gemini", backend: "gemini" }),
      { status: 200, value: { text: "Dictated through Gemini." } },
    );
    assert.equal(google.requests.length, 1);
    assert.equal(
      google.requests[0]!.body.contents[0]!.parts[1]!.inline_data.data,
      Buffer.from("spoken clip").toString("base64"),
    );
    assert.equal(google.requests[0]!.headers["x-goog-api-key"], "AIza-private-key");
    await assert.rejects(
      call(handle, "audio/ogg", Buffer.from("spoken clip"), { provider: "google-gemini", backend: "codex" }),
      /provider changed/i,
    );
    assert.equal(google.requests.length, 1, "a stale route reaches no provider");
  } finally {
    await google.close();
  }
});
