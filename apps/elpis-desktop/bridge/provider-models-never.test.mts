import test from "node:test";
import assert from "node:assert/strict";
import { providerModels } from "./provider-models.mts";
import { json, listed, local } from "./provider-models.fixtures.mts";

test("non-OK and redirected responses never return upstream bodies or silently follow a redirect", async () => {
  for (const [status, pattern] of [
    [401, /key|access|authentication/i],
    [403, /key|access|authentication/i],
    [404, /models endpoint/i],
    [429, /rate|later/i],
    [500, /HTTP 500/],
    [302, /redirect/i],
  ] as [number, RegExp][]) {
    await assert.rejects(
      providerModels(local, {
        fetchImpl: async (_url, options) => {
          assert.equal(options.redirect, "error");
          return new Response("private-secret upstream body", { status });
        },
      }),
      error => {
        assert.ok(error instanceof Error);
        assert(!error.message.includes("private-secret"));
        return pattern.test(error.message);
      },
    );
  }
  await assert.rejects(
    providerModels(local, { fetchImpl: async () => ({ ok: true, status: 200, redirected: true }) }),
    /redirect/i,
  );
  await assert.rejects(
    providerModels(local, {
      fetchImpl: async () => {
        throw Error("private-secret at https://user:pass@example.com");
      },
    }),
    error => {
      assert.ok(error instanceof Error);
      assert(!/private-secret|example\.com|user:pass/.test(error.message));
      return /could not|unavailable|connect/i.test(error.message);
    },
  );
});

test("malformed catalogues and excessive row counts produce clear unavailable errors", async () => {
  for (const body of ["not JSON", "null", "[]", "{}", '{"data":{}}']) {
    await assert.rejects(
      providerModels(local, { fetchImpl: async () => new Response(body) }),
      /valid|compatible|model list/i,
    );
  }
  await assert.rejects(
    providerModels(local, {
      fetchImpl: async () => json({ data: Array.from({ length: 2001 }, (_, i) => ({ id: `model-${i}` })) }),
    }),
    /too many|2000/i,
  );
  await assert.rejects(
    providerModels(local, { fetchImpl: async () => json({ data: [{ id: "not supported here" }] }) }),
    /supported model/i,
  );
  assert.deepEqual(await providerModels(local, { fetchImpl: async () => json({ data: [] }) }), {
    data: [],
    nextCursor: null,
  });
});

test("streamed size limits apply with or without an honest Content-Length", async () => {
  let cancelled = 0;
  const huge = () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel() {
        cancelled++;
      },
    });
  await assert.rejects(providerModels(local, { fetchImpl: async () => new Response(huge()) }), /too large|2 MiB/i);
  await assert.rejects(
    providerModels(local, {
      fetchImpl: async () => new Response(huge(), { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
    }),
    /too large|2 MiB/i,
  );
  assert.equal(cancelled, 2);
});

test("caller cancellation interrupts a pending fetch or response body", async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  await assert.rejects(
    providerModels(local, {
      signal: before.signal,
      fetchImpl: async () => {
        calls++;
        return listed();
      },
    }),
    /cancel/i,
  );
  assert.equal(calls, 0);
  const during = new AbortController();
  const request = providerModels(local, { signal: during.signal, fetchImpl: () => new Promise(() => {}) });
  during.abort();
  await assert.rejects(request, /cancel/i);
  let reading!: () => void;
  const started = new Promise<void>(resolve => {
    reading = resolve;
  });
  const body = new AbortController();
  const loading = providerModels(local, {
    signal: body.signal,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull() {
            reading();
          },
        }),
      ),
  });
  await started;
  body.abort();
  await assert.rejects(loading, /cancel/i);
});

test("the complete request has an eight-second timeout even if the fetch implementation does not reject", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const loading = providerModels(local, { fetchImpl: () => new Promise(() => {}) });
  t.mock.timers.tick(8000);
  await assert.rejects(loading, /timed out|too long/i);
});

test("the timeout also bounds a response body that never finishes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reading!: () => void;
  const started = new Promise<void>(resolve => {
    reading = resolve;
  });
  const loading = providerModels(local, {
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull() {
            reading();
          },
        }),
      ),
  });
  await started;
  t.mock.timers.tick(8000);
  await assert.rejects(loading, /timed out|too long/i);
});

// 29 Oct, Masih, of the reranker menu's three fixed choices: "this is unacceptable; we want real call and showing of real
// options." OpenRouter lists its rerankers apart from its chat models.
test("OpenRouter rerankers are read from its own rerank listing, without the tools filter or the coding ranking", async () => {
  const urls: string[] = [];
  const result = await providerModels(
    { base_url: "https://openrouter.ai/api/v1", wire_api: "chat" },
    {
      outputModality: "rerank",
      fetchImpl: async url => {
        urls.push(url);
        return new Response(
          JSON.stringify({
            data: [
              { id: "cohere/rerank-4-pro", name: "Cohere: Rerank 4 Pro", supported_parameters: [] },
              { id: "nvidia/nemotron-3.5-rerank-8b:free", name: "NVIDIA: Nemotron 3.5 Rerank 8B (free)" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  assert.deepEqual(urls, ["https://openrouter.ai/api/v1/models?output_modalities=rerank"]);
  assert.deepEqual(
    result.data.map(model => [model.id, model.displayName]),
    [
      ["cohere/rerank-4-pro", "Cohere: Rerank 4 Pro"],
      ["nvidia/nemotron-3.5-rerank-8b:free", "NVIDIA: Nemotron 3.5 Rerank 8B (free)"],
    ],
  );
});
