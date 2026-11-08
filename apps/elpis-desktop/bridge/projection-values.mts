// Keep provider credentials, full config layers, audit paths and arbitrary fields server-side.
export const string = (value: unknown) => (typeof value === "string" ? value : null);
export const boolean = (value: unknown) => (typeof value === "boolean" ? value : null);
export const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter(item => typeof item === "string") : null;
export const numericFields = (value: unknown, keys: string[]): Record<string, number> | null =>
  value && typeof value === "object"
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, number] =>
            keys.includes(entry[0]) && typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ),
      )
    : null;
export const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
