/** Removes one key from a record while preserving its reference when the key is absent. */
export const without = <T,>(record: Record<string, T>, key: string) => { if (!(key in record)) return record; const next = { ...record }; delete next[key]; return next; };
