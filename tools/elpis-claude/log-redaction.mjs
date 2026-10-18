import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

// Keep this policy aligned with core/src/log_redaction.rs; both run log-secrets.json.
const rules = [
  ["env", /^([ \t]*(?:export[ \t]+)?(?:[A-Za-z_][A-Za-z0-9_]*)?(?:KEY|TOKEN|SECRET)[ \t]*=[ \t]*)([^\r\n]+)/gim, true],
  ["x-api-key", /(\bx-api-key[ \t]*:[ \t]*["']?)([^\s"'`,;}\[\]<>\\]+)/gi, true],
  ["bearer", /(\bBearer[ \t]+)([^\s"'`,;}\[\]<>\\]+)/gi, true],
  ["anthropic", /\bsk-ant-[A-Za-z0-9_-]+/g],
  ["openrouter", /\bsk-or-[A-Za-z0-9_-]+/g],
  ["openai", /\bsk-[A-Za-z0-9_-]+/g],
  ["google", /\bAIza[A-Za-z0-9_-]{20,}/g],
  ["github", /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g],
  ["aws", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
];
const marker = /^\[redacted:[a-z-]+\]$/;

/** Redact a stored copy. counts contains occurrences, never credential values. */
export function redactSecrets(text, counts = {}) {
  text = String(text);
  // Decode JSON string tokens even inside prefixed log messages and JSONL. Preserve
  // whitespace, numbers and escaping of untouched strings, including nested inputs.
  let previous;
  const original = text;
  text = text.replace(/"(?:\\.|[^"\\])*"/g, (token, offset) => {
    let value;
    try { value = JSON.parse(token); } catch { previous = null; return token; }
    const field = previous && /^\s*:\s*$/.test(original.slice(previous.end, offset)) ? previous.kind : null;
    const isKey = /^\s*:/.test(original.slice(offset + token.length));
    previous = isKey ? { end: offset + token.length, kind: /^x-api-key$/i.test(value) ? "x-api-key" : /(?:KEY|TOKEN|SECRET)$/i.test(value) ? "env" : null } : null;
    let clean;
    if (field && value && !marker.test(value)) {
      counts[field] = (counts[field] ?? 0) + 1;
      clean = `[redacted:${field}]`;
    } else clean = redactSecrets(value, counts);
    return clean === value ? token : JSON.stringify(clean);
  });
  for (const [kind, pattern, prefix] of rules) {
    text = text.replace(pattern, (match, first, second) => {
      if (prefix && marker.test(second.trim())) return match;
      counts[kind] = (counts[kind] ?? 0) + 1;
      return `${prefix ? first : ""}[redacted:${kind}]`;
    });
  }
  return text;
}

export function appendLog(file, message) {
  appendFileSync(file, `${new Date().toISOString().slice(11, 23)} ${redactSecrets(message)}\n`, { mode: 0o600 });
}

// Credentials and UTF-8 characters can span data chunks. Redact complete lines.
export function redactedLines(stream, emit) {
  const decoder = new StringDecoder("utf8");
  let pending = "", discarded = false, ended = false;
  const flush = () => {
    emit(discarded ? "[redacted:oversize]" : redactSecrets(pending.replace(/\r$/, "")));
    pending = ""; discarded = false;
  };
  const consume = text => {
    const parts = text.split("\n");
    for (const [index, part] of parts.entries()) {
      if (!discarded) {
        // Bound the buffering introduced by waiting for a complete stderr line.
        if (pending.length + part.length > 65_536) { pending = ""; discarded = true; }
        else pending += part;
      }
      if (index < parts.length - 1) flush();
    }
  };
  stream.on("data", chunk => consume(decoder.write(chunk)));
  const end = () => {
    if (ended) return;
    ended = true;
    consume(decoder.end());
    if (pending || discarded) flush();
  };
  stream.once("end", end);
  stream.once("close", end);
}
