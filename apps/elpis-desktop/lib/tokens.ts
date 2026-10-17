/** Token counts as the TUI's /context prints them: 980, 26.5k, 1.2m. */
export function compactTokens(value: number) {
  const trim = (scaled: number) => scaled.toFixed(1).replace(/\.0$/, "");
  return value >= 1e6 ? `${trim(value / 1e6)}m` : value >= 1e3 ? `${trim(value / 1e3)}k` : String(value);
}
