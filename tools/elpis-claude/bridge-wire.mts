/** The protocol passes through unknown fields, but routing only reads object envelopes. */
export const wireObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const wireId = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";
