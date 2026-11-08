

export type FetchOptions = { method: "GET"; headers: Headers; redirect: "error"; signal: AbortSignal };

export const json = (value: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json", ...init.headers } });

export const listed = () => json({ data: [{ id: "gpt-oss:20b", name: "GPT OSS 20B" }] });

export const local = { base_url: "http://127.0.0.1:1234/v1", wire_api: "responses" };

// How config/read reports a provider the engine serves through its own loopback gateway (here, the Anthropic credits).
export const gateway = {
  base_url: "http://127.0.0.1:44103/v1",
  wire_api: "responses",
  env_key: "ANTHROPIC_CREDITS_KEY",
  http_headers: {
    "x-elpis-gateway-token": "internal-secret",
    "x-elpis-provider": "anthropic-credits",
    "x-elpis-wire": "anthropic_messages",
  },
};
