import { speechChunks } from './client.mjs';

/** Incremental prose only. Ambiguous fence prefixes stay private, even across a timer flush. */
export function createSentenceBuffer(emit) {
  let raw = '', prose = '', pending = '', fence = '', depth = 0, quoted = false, escaped = false, ended = false, timer;
  const deliver = text => { for (const chunk of speechChunks(text)) if (chunk.trim()) emit(chunk); };
  function flush(tail = false) {
    clearTimeout(timer); timer = undefined;
    let end = tail || /[.!?؟。！]["'”’)]*$/.test(pending) ? pending.length : pending.search(/\s+\S*$/u);
    if (end >= 0) {
      if (!tail && end < pending.length) end += pending.slice(end).match(/^\s+/u)?.[0].length ?? 0;
      deliver(pending.slice(0, end)); pending = pending.slice(end);
    }
  }
  function add(char) { prose += char; pending += char; }
  function drain() {
    while (raw) {
      if (fence) {
        const end = raw.indexOf(fence);
        if (end < 0) { raw = raw.match(fence[0] === '`' ? /`{1,2}$/ : /~{1,2}$/)?.[0] ?? ''; break; }
        raw = raw.slice(end + fence.length); fence = ''; continue;
      }
      const char = raw[0];
      if (depth) {
        raw = raw.slice(1);
        if (escaped) { escaped = false; continue; }
        if (quoted && char === '\\') { escaped = true; continue; }
        if (char === '"') quoted = !quoted;
        if (!quoted) { if (char === '{' || char === '[') depth++; if (char === '}' || char === ']') depth--; }
        continue;
      }
      if (char === '`' || char === '~') {
        const count = raw.match(char === '`' ? /^`+/ : /^~+/)[0].length;
        if (count < 3 && count === raw.length) break;
        raw = raw.slice(count);
        if (count >= 3) fence = char.repeat(3);
        continue;
      }
      if (char === '[') {
        const next = raw.slice(1).trimStart();
        if (!next || ['true', 'false', 'null'].some(word => word.startsWith(next))) break;
        if (/^[\]\[\{"\d\-]|^(?:true|false|null)/.test(next)) { depth = 1; raw = raw.slice(1); continue; }
      }
      if (char === '{') { depth = 1; raw = raw.slice(1); continue; }
      add(char); raw = raw.slice(1);
    }
    let sentence;
    while ((sentence = pending.match(/^[\s\S]*?[.!?؟。！]["'”’)]*\s+/u))) {
      deliver(sentence[0]); pending = pending.slice(sentence[0].length);
    }
    const chunks = speechChunks(pending);
    if (chunks.length > 1) { for (const chunk of chunks.slice(0, -1)) deliver(chunk); pending = chunks.at(-1); }
    if (pending && !timer) { timer = setTimeout(() => flush(), 300); timer.unref?.(); }
  }
  return {
    push(delta) { if (!ended) { raw += delta; drain(); } },
    text: () => prose,
    discard() { clearTimeout(timer); timer = undefined; pending = ''; },
    finish() { if (!ended) { ended = true; flush(true); raw = ''; } },
    cancel() { ended = true; clearTimeout(timer); pending = raw = ''; },
  };
}
