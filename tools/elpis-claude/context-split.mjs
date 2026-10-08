// How a bridged chat's context splits into the categories Elpis draws (/context, the Context
// Ledger, the dashboard). The parts come from text length (about 4 characters a token); the
// total is what the model reports.
const tok = (n) => Math.round((n ?? 0) / 4);

export function splitContext(chars, developerChars, used) {
  const c = chars ?? {};
  return splitTokens({ developerMessages: tok(developerChars), userMessages: tok(c.user), agentMessages: tok(c.agent), reasoning: tok(c.reasoning), toolCalls: tok(c.toolCalls), toolResults: tok(c.toolResults) }, used);
}

// Parts in tokens, fitted to the reported total; what they leave is the system instructions.
export function splitTokens(parts, used) {
  parts = { ...parts };
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


// A Claude chat's parts in tokens, from Claude's own counts in its Claude Code transcript (since
// its last compaction), so they hold after Elpis restarts and count what text length cannot:
// - each request's growth is the reply before it plus the inputs added since (the user's
//   message, tool results, Claude Code's own additions), shared by their length;
// - a reply's tokens its text and tool calls do not explain are its hidden thinking, which
//   Claude keeps in context;
// - the first request, and one after a new system prompt (a prompt snapshot), carry the system
//   prompt and tools: the inputs added are estimated by length and the rest is system. Claude
//   Code saves a snapshot of its prompt before each request; only a changed one is new.
export function transcriptTokens(jsonl) {
  const t = { system: 0, user: 0, agent: 0, reasoning: 0, toolCalls: 0, toolResults: 0 };
  const entries = jsonl.split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
  const from = entries.findLastIndex((d) => d.type === "system" && d.subtype === "compact_boundary") + 1;
  const textOf = (v) => typeof v === "string" ? v.length : Array.isArray(v) ? v.reduce((n, x) => n + (x?.type === "text" ? x.text.length : 0), 0) : 0;
  let pending = [], newPrompt = true, prevTotal = 0, reply = null;
  let prompt = null; // the system prompt and tools of the snapshots so far
  const closeReply = () => {
    if (!reply) return;
    const shown = tok(reply.text) + tok(reply.calls);
    const scale = shown > reply.out ? reply.out / shown : 1;
    t.agent += tok(reply.text) * scale;
    t.toolCalls += tok(reply.calls) * scale;
    t.reasoning += Math.max(0, reply.out - shown);
    reply = null;
  };
  for (const d of entries.slice(from)) {
    if (d.isSidechain) continue;
    if (d.type === "assistant") {
      const m = d.message ?? {};
      if (reply?.id !== m.id) {
        const u = m.usage ?? {};
        const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (!total) continue; // a reply Claude Code wrote itself
        const out = reply?.out ?? 0;
        closeReply();
        const added = Math.max(0, total - prevTotal - out);
        const shown = pending.reduce((n, [part, chars]) => n + (part === "system" ? 0 : chars), 0);
        if (newPrompt) {
          // The system prompt is in this request: what the inputs do not explain is system.
          const est = Math.min(added, tok(shown));
          for (const [part, chars] of pending) if (part !== "system") t[part] += shown ? (est * chars) / shown : 0;
          t.system += added - est;
        } else {
          const all = pending.reduce((n, [, chars]) => n + chars, 0);
          for (const [part, chars] of pending) t[part] += all ? (added * chars) / all : 0;
          if (!all) t.system += added;
        }
        pending = []; newPrompt = false; prevTotal = total;
        reply = { id: m.id, out: u.output_tokens ?? 0, text: 0, calls: 0 };
      }
      for (const x of m.content ?? []) {
        if (x.type === "text") reply.text += x.text.length;
        else if (x.type === "tool_use") reply.calls += JSON.stringify(x.input ?? {}).length;
      }
    } else if (d.type === "user") {
      const content = d.message?.content;
      if (typeof content === "string") pending.push(["user", content.length]);
      else for (const x of content ?? []) {
        if (x.type === "text") pending.push(["user", x.text.length]);
        else if (x.type === "tool_result") pending.push(["toolResults", textOf(x.content)]);
      }
    } else if (d.type === "attachment") {
      if (d.attachment?.type === "prompt_snapshot") {
        // A snapshot may leave out what has not changed (the first one has no tools).
        const { systemPrompt: system, tools } = d.attachment;
        const changed = (was, now) => was !== undefined && now !== undefined && JSON.stringify(was) !== JSON.stringify(now);
        if (prompt && (changed(prompt.system, system) || changed(prompt.tools, tools))) newPrompt = true;
        prompt = { system: system ?? prompt?.system, tools: tools ?? prompt?.tools };
      }
      else pending.push(["system", JSON.stringify(d.attachment ?? {}).length]);
    }
  }
  closeReply();
  for (const k of Object.keys(t)) t[k] = Math.round(t[k]);
  return t;
}
