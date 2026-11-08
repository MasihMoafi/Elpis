import test from "node:test";
import assert from "node:assert/strict";
import { providerModels } from "./provider-models.mts";
import { json, listed, local, gateway } from "./provider-models.fixtures.mts";
import type { FetchOptions } from "./provider-models.fixtures.mts";

test("speech model listings retain model-specific voices", async () => {
  let requested = "";
  const result = await providerModels(
    { base_url: "https://openrouter.ai/api/v1", wire_api: "chat" },
    {
      outputModality: "speech",
      fetchImpl: async url => {
        requested = url;
        return new Response(
          JSON.stringify({ data: [{ id: "fish/test", name: "Fish", supported_voices: ["warm", "clear"] }] }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  assert.equal(new URL(requested).searchParams.get("output_modalities"), "speech");
  assert.deepEqual(result.data[0]!.voices, ["warm", "clear"]);
});

test("configured local connection determines the endpoint and exact selected model values", async () => {
  let calls = 0;
  const result = await providerModels(
    { ...local, base_url: `${local.base_url}/` },
    {
      env: {},
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, "http://127.0.0.1:1234/v1/models");
        assert.equal(options.method, "GET");
        assert.equal(options.redirect, "error");
        assert.equal(options.headers.get("accept"), "application/json");
        assert.equal(options.headers.has("authorization"), false);
        assert(options.signal instanceof AbortSignal);
        return json({
          data: [
            { id: "gpt-oss:20b", name: "GPT OSS 20B", description: "Local model" },
            { id: "gpt-oss:20b", name: "Duplicate entry" },
            { id: "org/model", display_name: "Readable provider name" },
            { id: "second-model", displayName: "Second model" },
            { id: "id-only" },
            { id: "bad model id" },
            { id: "claude/opus" },
            null,
            "not a model",
          ],
        });
      },
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    data: [
      { id: "gpt-oss:20b", model: "gpt-oss:20b", displayName: "GPT OSS 20B", description: "Local model" },
      { id: "org/model", model: "org/model", displayName: "Readable provider name" },
      { id: "second-model", model: "second-model", displayName: "Second model" },
      { id: "id-only", model: "id-only", displayName: "id-only" },
    ],
    nextCursor: null,
  });
});

test("hosted connection uses configured headers and the referenced API key before a stored token", async () => {
  const definition = {
    base_url: "https://openrouter.ai/api/v1",
    wire_api: "chat",
    env_key: "PROVIDER_KEY",
    experimental_bearer_token: "unused-stored-secret",
    http_headers: {
      "HTTP-Referer": "https://elpis.example",
      "X-Title": "Elpis",
      Authorization: "Bearer lower-priority-secret",
    },
    env_http_headers: { "X-Organization": "PROVIDER_ORG" },
  };
  const result = await providerModels(definition, {
    env: { PROVIDER_KEY: "environment-secret", PROVIDER_ORG: "selected-team" },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://openrouter.ai/api/v1/models");
      assert.equal(options.headers.get("authorization"), "Bearer environment-secret");
      assert.equal(options.headers.get("http-referer"), "https://elpis.example");
      assert.equal(options.headers.get("x-title"), "Elpis");
      assert.equal(options.headers.get("x-organization"), "selected-team");
      return listed();
    },
  });
  assert(!JSON.stringify(result).includes("secret"));
});

test("stored keys work without an environment reference and IPv6 loopback remains local", async () => {
  await providerModels(
    { base_url: "http://[::1]:11434/v1", experimental_bearer_token: "stored-secret" },
    {
      env: {},
      fetchImpl: async (url, options) => {
        assert.equal(url, "http://[::1]:11434/v1/models");
        assert.equal(options.headers.get("authorization"), "Bearer stored-secret");
        return listed();
      },
    },
  );
  await providerModels(
    { base_url: "http://localhost:11434/v1" },
    {
      env: {},
      fetchImpl: async url => {
        assert.equal(url, "http://localhost:11434/v1/models");
        return listed();
      },
    },
  );
});

test("a key saved in the Elpis home stands before the variable, and models without tools are left out", async () => {
  let auth;
  const fetchImpl = async (url: string, options: FetchOptions) => {
    auth = options.headers.get("authorization");
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "deepseek/deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash",
            context_length: 163840,
            supported_parameters: ["tools", "reasoning"],
          },
          { id: "some/chat-only", name: "Chat only", supported_parameters: ["temperature"] },
        ],
      }),
      { status: 200 },
    );
  };
  const result = await providerModels(
    { base_url: "https://openrouter.ai/api/v1", wire_api: "chat", env_key: "OPENROUTER_API_KEY" },
    { env: {}, savedKey: "saved-key", fetchImpl },
  );
  assert.equal(auth, "Bearer saved-key");
  assert.deepEqual(result.data, [
    {
      id: "deepseek/deepseek-v4.1-flash",
      model: "deepseek/deepseek-v4.1-flash",
      displayName: "DeepSeek V4.1 Flash",
      description: "Top for coding #1 · ≈164k context",
    },
  ]);
});

test("Anthropic and Gemini list their models with their own key headers and shapes", async () => {
  const seen: (string | null)[][] = [];
  const fetchImpl = async (url: string, options: FetchOptions) => {
    seen.push([
      url,
      options.headers.get("x-api-key"),
      options.headers.get("anthropic-version"),
      options.headers.get("x-goog-api-key"),
      options.headers.get("authorization"),
    ]);
    const body = url.includes("anthropic")
      ? { data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1000000 }] }
      : {
          models: [
            {
              name: "models/gemini-4-pro",
              displayName: "Gemini 4 Pro",
              inputTokenLimit: 2000000,
              supportedGenerationMethods: ["generateContent"],
            },
            { name: "models/text-embedding", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
          ],
        };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const anthropic = await providerModels(
    { base_url: "https://api.anthropic.com/v1", env_key: "ANTHROPIC_API_KEY", wire_api: "anthropic_messages" },
    { env: {}, savedKey: "a-key", fetchImpl },
  );
  const gemini = await providerModels(
    {
      base_url: "https://generativelanguage.googleapis.com/v1beta",
      env_key: "GEMINI_API_KEY",
      wire_api: "gemini_generate_content",
    },
    { env: {}, savedKey: "g-key", fetchImpl },
  );
  assert.deepEqual(seen, [
    ["https://api.anthropic.com/v1/models?limit=1000", "a-key", "2023-06-01", null, null],
    ["https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", null, null, "g-key", null],
  ]);
  assert.deepEqual(anthropic.data, [
    { id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Claude Opus 5.5", description: "≈1000k context" },
  ]);
  assert.deepEqual(gemini.data, [
    { id: "gemini-4-pro", model: "gemini-4-pro", displayName: "Gemini 4 Pro", description: "≈2000k context" },
  ]);
});

test("OpenRouter lists its top programming models first, marked, then the rest newest first", async () => {
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    const ranked = url.includes("category=programming");
    return new Response(
      JSON.stringify({
        data: ranked
          ? [
              { id: "deepseek/deepseek-v4.1-flash", supported_parameters: ["tools"] },
              { id: "z-ai/glm-5.3", supported_parameters: ["tools"] },
            ]
          : [
              { id: "new/obscure", name: "Obscure", supported_parameters: ["tools"] },
              { id: "z-ai/glm-5.3", name: "GLM 5.3", context_length: 1048576, supported_parameters: ["tools"] },
              {
                id: "deepseek/deepseek-v4.1-flash",
                name: "DeepSeek V4.1 Flash",
                context_length: 1048576,
                supported_parameters: ["tools"],
              },
            ],
      }),
      { status: 200 },
    );
  };
  const result = await providerModels(
    { base_url: "https://openrouter.ai/api/v1", wire_api: "chat", env_key: "OPENROUTER_API_KEY" },
    { env: { OPENROUTER_API_KEY: "k" }, fetchImpl },
  );
  assert.deepEqual(urls, [
    "https://openrouter.ai/api/v1/models",
    "https://openrouter.ai/api/v1/models?category=programming",
  ]);
  assert.deepEqual(
    result.data.map(row => [row.id, row.description ?? ""]),
    [
      ["deepseek/deepseek-v4.1-flash", "Top for coding #1 · ≈1049k context"],
      ["z-ai/glm-5.3", "Top for coding #2 · ≈1049k context"],
      ["new/obscure", ""],
    ],
  );
});

test("OpenRouter audio choices keep audio inputs without requiring tools and exclude text-only models", async () => {
  const definition = { base_url: "https://openrouter.ai/api/v1", wire_api: "chat" };
  const rows = [
    {
      id: "voice/audio-only",
      name: "Audio only",
      architecture: { input_modalities: ["text", "audio"] },
      supported_parameters: ["temperature"],
    },
    { id: "voice/audio-tools", architecture: { input_modalities: ["audio"] }, supported_parameters: ["tools"] },
    {
      id: "text/chat",
      architecture: { input_modalities: ["text"], output_modalities: ["audio"] },
      supported_parameters: ["tools"],
    },
    { id: "unknown/chat", supported_parameters: ["tools"] },
  ];
  const result = await providerModels(definition, {
    inputModality: "audio",
    fetchImpl: async () => json({ data: rows }),
  });
  assert.deepEqual(
    result.data.map(row => row.model),
    ["voice/audio-only", "voice/audio-tools"],
  );
  assert.deepEqual(result.data[0]!.architecture, { input_modalities: ["text", "audio"] });
  const textOnly = await providerModels(definition, {
    inputModality: "audio",
    fetchImpl: async () => json({ data: rows.slice(2) }),
  });
  assert.deepEqual(textOnly, { data: [], nextCursor: null });
});

test("missing referenced keys and unsupported authentication stop before any request", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return listed();
  };
  await assert.rejects(
    providerModels(
      { ...local, env_key: "MISSING_KEY", experimental_bearer_token: "do-not-fallback" },
      { env: {}, fetchImpl },
    ),
    /MISSING_KEY/,
  );
  await assert.rejects(
    providerModels({ ...local, env_http_headers: { "X-Organization": "MISSING_ORG" } }, { env: {}, fetchImpl }),
    /MISSING_ORG/,
  );
  for (const extra of [
    { auth: { command: ["never-run-this"] } },
    { aws: {} },
    { gateway_oauth: {} },
    { requires_openai_auth: true },
    { wire_api: "bedrock_converse" },
    { query_params: { "api-version": "required" } },
  ]) {
    await assert.rejects(
      providerModels({ ...local, ...extra }, { env: {}, fetchImpl }),
      /not available|not supported|unsupported/i,
    );
  }
  assert.equal(calls, 0);
});

test("a gateway-routed connection lists the models its loopback gateway serves, with the gateway resolving the key", async () => {
  const result = await providerModels(gateway, {
    env: {},
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:44103/v1/models");
      assert.equal(options.headers.get("x-elpis-gateway-token"), "internal-secret");
      assert.equal(options.headers.get("x-api-key"), null);
      assert.equal(options.headers.get("authorization"), null);
      return json({
        models: [
          { slug: "claude-opus-5-5", display_name: "Claude Opus 5.5", context_window: 1000000 },
          { slug: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
        ],
      });
    },
  });
  assert.deepEqual(
    result.data.map(row => [row.model, row.displayName, row.description]),
    [
      ["claude-opus-5-5", "Claude Opus 5.5", "≈1000k context"],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5", undefined],
    ],
  );
});

test("a gateway token is sent only to a loopback gateway", async () => {
  let calls = 0;
  await assert.rejects(
    providerModels(
      { ...gateway, base_url: "https://gateway.example.com/v1" },
      {
        env: {},
        fetchImpl: async () => {
          calls++;
          return listed();
        },
      },
    ),
    /loopback/,
  );
  assert.equal(calls, 0);
});

test("invalid URLs and unsafe headers cannot alter the connection or leak credentials", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return listed();
  };
  for (const base_url of [
    "",
    "not a URL",
    "file:///tmp/models",
    "http://example.com/v1",
    "http://127.0.0.2/v1",
    "https://user:private-secret@example.com/v1",
    "https://@example.com/v1",
    "https://example.com/v1?key=private-secret",
    "https://example.com/v1#fragment",
    "https://example.com/v1?",
    "https:\\example.com\\v1",
    "https://example.com/\nmodels",
  ]) {
    await assert.rejects(providerModels({ ...local, base_url }, { env: {}, fetchImpl }), error => {
      assert.ok(error instanceof Error);
      assert(!error.message.includes("private-secret"));
      return /address|URL|HTTPS|loopback/i.test(error.message);
    });
  }
  for (const extra of [
    { http_headers: { Host: "other.example" } },
    { http_headers: { Cookie: "private-secret" } },
    { http_headers: { "X-Test": "private-secret\r\nInjected: value" } },
    { env_key: "../secret" },
    { experimental_bearer_token: "private-secret\n" },
    { http_headers: [] },
  ]) {
    await assert.rejects(providerModels({ ...local, ...extra }, { env: {}, fetchImpl }), error => {
      assert.ok(error instanceof Error);
      assert(!error.message.includes("private-secret"));
      return /header|credential|environment/i.test(error.message);
    });
  }
  assert.equal(calls, 0);
});
