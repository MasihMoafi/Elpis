// How a bridged chat's context splits into the categories Elpis draws (/context, the Context
// Ledger, the dashboard). The parts come from text length (about 4 characters a token); the
// total is what the model reports.
const tok = (n) => Math.round((n ?? 0) / 4);

export function splitContext(chars, developerChars, used) {
  const c = chars ?? {};
  const parts = { developerMessages: tok(developerChars), userMessages: tok(c.user), agentMessages: tok(c.agent), reasoning: tok(c.reasoning), toolCalls: tok(c.toolCalls), toolResults: tok(c.toolResults) };
  const known = Object.values(parts).reduce((a, b) => a + b, 0);
  // Elpis needs the parts to add up to the total. Estimates larger than the reported context
  // shrink to fit it, keeping their proportions (largest remainder).
  if (known > used) {
    const keys = Object.keys(parts);
    const exact = keys.map((k) => (parts[k] * used) / known);
    keys.forEach((k, i) => { parts[k] = Math.floor(exact[i]); });
    let left = used - keys.reduce((sum, k) => sum + parts[k], 0);
    for (const i of keys.map((_, i) => i).sort((a, b) => (exact[b] % 1) - (exact[a] % 1))) {
      if (left-- <= 0) break;
      parts[keys[i]] += 1;
    }
  }
  const fitted = Object.values(parts).reduce((a, b) => a + b, 0);
  return { systemInstructions: used - fitted, ...parts, toolDefinitions: 0, outputSchema: 0, unrecognizedItems: 0, estimatedTotal: used };
}
