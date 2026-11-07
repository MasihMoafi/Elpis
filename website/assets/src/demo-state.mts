// Generated browser module: run npm run build:js from website.
// Illustrative counts, independent of any real session or model tokenizer.
export const DEMO_BASE_COUNTS = Object.freeze([9600, 31800, 22500, 12800, 26900, 22600, 8300, 19000, 6500]);
const instructions = 5431, session = 156;
export const DEMO_TOKENS = Object.freeze({ conversation: DEMO_BASE_COUNTS.reduce((a,b) => a+b,0) - instructions - session, instructions, session, prompt: 124, read: 2064, raw: 18432, optimized: 486, limit: 258400 });
export function admissionStateAt(progress: number) {
  const position = Math.min(1, Math.max(0, progress));
  const phase = position >= .89 ? "done" : position >= .70 ? "ace" : position >= .54 ? "tools" : position >= .43 ? "working" : position >= .27 ? "ready" : position >= .12 ? "boot" : "shell";
  const conversation = DEMO_TOKENS.conversation + (position >= .43 ? DEMO_TOKENS.prompt : 0) + (position >= .54 ? DEMO_TOKENS.read : 0) + (position >= .89 ? DEMO_TOKENS.optimized : 0);
  const sources = DEMO_TOKENS.instructions + DEMO_TOKENS.session;
  const total = conversation + sources;
  return { phase, conversation, sources, total, remaining: DEMO_TOKENS.limit - total, usedPercent: total / DEMO_TOKENS.limit * 100, saved: phase === "done" ? DEMO_TOKENS.raw - DEMO_TOKENS.optimized : 0 };
}
