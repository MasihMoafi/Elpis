// What went wrong, as text. Plain JavaScript so the bridge-free unit tests (node --test on lib/*.ts) load it as is.

/** An Error's message, else the fallback, else the value itself.
 * @param {unknown} cause @param {string} [fallback] @returns {string} */
export const errorText = (cause, fallback) => cause instanceof Error ? cause.message : fallback ?? String(cause);
