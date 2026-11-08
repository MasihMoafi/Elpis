export type JsonRpcEnvelope = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown; [key: string]: unknown };

/** The protocol passes through unknown fields, but routing only reads object envelopes. */
export const wireObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const wireId = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";

export const wireEnvelope = (value: unknown): value is JsonRpcEnvelope => wireObject(value)
  && (value.id === undefined || wireId(value.id)) && (value.method === undefined || typeof value.method === "string");
