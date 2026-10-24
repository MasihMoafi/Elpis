// A small property checker, without a dependency: each property runs on many seeded random cases, edges included
// (empty, one, many, Unicode), and a failure names its seed so `PROPERTY_SEED=<seed>` replays it.
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = ["a", "b", "z", "0", "7", " ", "-", "_", ".", ",", "'", '"', "`", "\\", "/", "{", "}", "[", "]", "<", ">", "&", "é", "ß", "ж", "中", "ق", "🙂", "‍", "\t"];

export function gen(rand) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  // Lengths favour the edges: 0 and 1 come up often.
  const size = (max) => pick([0, 1, int(0, max), int(0, max)]);
  const text = (max = 12) => Array.from({ length: size(max) }, () => pick(CHARS)).join("");
  const json = (depth = 2) => {
    const kind = depth <= 0 ? int(0, 3) : int(0, 5);
    if (kind === 0) return text();
    if (kind === 1) return int(-1000, 1000);
    if (kind === 2) return pick([true, false, null]);
    if (kind === 3) return rand() * 1e6 - 5e5;
    if (kind === 4) return Array.from({ length: size(4) }, () => json(depth - 1));
    return Object.fromEntries(Array.from({ length: size(4) }, (_, i) => [`${text(6)}${i}`, json(depth - 1)]));
  };
  const shuffle = (list) => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = int(0, i); [out[i], out[j]] = [out[j], out[i]]; } return out; };
  return { rand, int, pick, size, text, json, shuffle, bool: () => rand() < 0.5 };
}

export async function forAll(cases, check, { seed = Number(process.env.PROPERTY_SEED) || 20261024 } = {}) {
  const only = Number(process.env.PROPERTY_SEED) ? 1 : cases;
  for (let i = 0; i < only; i++) {
    const caseSeed = seed + i;
    try { await check(gen(random(caseSeed)), i); }
    catch (e) { e.message = `property failed for PROPERTY_SEED=${caseSeed}: ${e.message}`; throw e; }
  }
}
