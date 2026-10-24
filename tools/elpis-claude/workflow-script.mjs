// The workflow script language, copied from Claude Code's Workflow tool: `export const meta = {...}` (a pure
// literal) followed by a plain JavaScript body with top-level await. The body runs in its own VM context with
// only the runner's hooks; Date.now(), Math.random() and argless new Date() throw, since they would break resume.
import vm from "node:vm";

export class ScriptError extends Error {}

// ---- meta: a pure literal ------------------------------------------------------------------------

const LEAD = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const HEAD = /^export\s+const\s+meta\s*=\s*/;

// Scans a literal from `{` and returns its end. Allowed: objects, arrays, strings (templates without ${}),
// numbers (with a leading minus), true/false/null, and bare identifiers as keys. Anything else is refused.
function scanLiteral(src, start) {
  let i = start, depth = 0;
  const stack = [];
  const fail = (why) => { throw new ScriptError(`meta must be a pure literal (no variables, calls, spreads or interpolation): ${why} at offset ${i}`); };
  const skip = () => {
    for (;;) {
      const m = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/.exec(src.slice(i));
      if (!m || !m[0]) return;
      i += m[0].length;
    }
  };
  const nextChar = () => { const save = i; skip(); const c = src[i]; i = save; return c; };
  do {
    skip();
    const c = src[i];
    if (c === undefined) fail("the literal never closes");
    if (c === "{" || c === "[") { stack.push(c); depth++; i++; continue; }
    if (c === "}" || c === "]") {
      if (stack.pop() !== (c === "}" ? "{" : "[")) fail(`unbalanced ${c}`);
      depth--; i++; continue;
    }
    if (c === "," || c === ":") { i++; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) { if (src[j] === "\\") j++; if (src[j] === "\n") fail("unterminated string"); }
      if (j >= src.length) fail("unterminated string");
      i = j + 1; continue;
    }
    if (c === "`") {
      let j = i + 1;
      for (; j < src.length && src[j] !== "`"; j++) { if (src[j] === "\\") { j++; continue; } if (src[j] === "$" && src[j + 1] === "{") fail("template interpolation"); }
      if (j >= src.length) fail("unterminated template");
      i = j + 1; continue;
    }
    const num = /^-?(?:0[xX][\da-fA-F_]+|(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
    if (num && num[0] !== "-") { i += num[0].length; continue; }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (id) {
      i += id[0].length;
      if (["true", "false", "null"].includes(id[0])) continue;
      if (stack.at(-1) === "{" && nextChar() === ":") continue;
      fail(`identifier ${id[0]}`);
    }
    fail(`unexpected ${JSON.stringify(c)}`);
  } while (depth > 0);
  return i;
}

export function parseScript(source) {
  if (typeof source !== "string" || !source.trim()) throw new ScriptError("The script is empty.");
  const lead = LEAD.exec(source)[0].length;
  const head = HEAD.exec(source.slice(lead));
  if (!head) throw new ScriptError("The script must begin with `export const meta = { name, description, ... }`.");
  const start = lead + head[0].length;
  if (source[start] !== "{") throw new ScriptError("meta must be an object literal.");
  const end = scanLiteral(source, start);
  let meta;
  try { meta = vm.runInNewContext(`(${source.slice(start, end)})`, Object.create(null), { timeout: 1000 }); }
  catch (e) { throw new ScriptError(`meta is not a valid literal: ${e.message}`); }
  meta = JSON.parse(JSON.stringify(meta));
  if (typeof meta.name !== "string" || !meta.name.trim()) throw new ScriptError("meta.name is required (a string).");
  if (typeof meta.description !== "string" || !meta.description.trim()) throw new ScriptError("meta.description is required (a string).");
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases) || meta.phases.some((p) => typeof p?.title !== "string")) throw new ScriptError("meta.phases must be a list of { title, detail? }.");
  }
  const rest = source.slice(end).replace(/^\s*;/, "");
  return { meta, body: rest, bodyOffset: source.length - rest.length };
}

// ---- body: a sandboxed async function -------------------------------------------------------------

const GUARDS = `(() => {
  const RealDate = Date;
  const refuse = (what) => { throw new Error(what + " is not available in workflow scripts (it would break resume); pass timestamps in through args."); };
  function SafeDate(...a) {
    if (!new.target) refuse("Date()");
    if (!a.length) refuse("new Date()");
    return new RealDate(...a);
  }
  SafeDate.prototype = RealDate.prototype;
  Object.defineProperty(RealDate.prototype, "constructor", { value: SafeDate });
  SafeDate.UTC = RealDate.UTC; SafeDate.parse = RealDate.parse;
  SafeDate.now = () => refuse("Date.now()");
  globalThis.Date = SafeDate;
  Math.random = () => refuse("Math.random()");
})();`;

// Compiles the body once; run(hooks) returns the body's promise. Values cross into the script through
// `inside` (JSON copies made in the script's realm), so Array.isArray and instanceof behave there.
export function compileScript(source, filename = "workflow.js") {
  const { meta, body } = parseScript(source);
  let code;
  try { code = new vm.Script(`(async () => {\n${body}\n})()`, { filename, lineOffset: -1 }); }
  catch (e) { throw new ScriptError(`The script does not parse (plain JavaScript only, no TypeScript): ${e.message}`); }
  return {
    meta,
    run(hooks) {
      const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
      vm.runInContext(GUARDS, context);
      const json = vm.runInContext("JSON", context);
      const inside = (value) => (value === undefined ? undefined : json.parse(JSON.stringify(value)));
      for (const [name, value] of Object.entries(hooks(inside))) context[name] = value;
      return code.runInContext(context);
    },
  };
}

// ---- JSON Schema: the subset structured answers use ----------------------------------------------------

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => t === "number" ? typeof v === "number" : t === "integer" ? Number.isInteger(v) : typeOf(v) === t;

export function validate(schema, value, at = "$") {
  if (!schema || typeof schema !== "object" || schema === true) return [];
  const errors = [];
  const types = schema.type === undefined ? null : [].concat(schema.type);
  if (types && !types.some((t) => isType(value, t))) return [`${at}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.anyOf && !schema.anyOf.some((s) => !validate(s, value, at).length)) errors.push(`${at}: matches none of anyOf`);
  if (schema.oneOf && schema.oneOf.filter((s) => !validate(s, value, at).length).length !== 1) errors.push(`${at}: must match exactly one of oneOf`);
  if (typeOf(value) === "object") {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}.${key}: required`);
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) errors.push(...validate(props[key], v, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: not allowed`);
      else if (typeof schema.additionalProperties === "object") errors.push(...validate(schema.additionalProperties, v, `${at}.${key}`));
    }
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${at}[${i}]`)));
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: at most ${schema.maxItems} items`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  }
  return errors;
}

// A schema agent() accepts: an object root with properties, required naming only listed properties.
export function checkSchema(schema) {
  if (!schema || typeof schema !== "object" || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") {
    throw new Error("schema must be a JSON Schema with {type: 'object', properties: {...}} at its root");
  }
  const missing = (schema.required ?? []).filter((k) => !(k in schema.properties));
  if (missing.length) throw new Error(`schema is unsatisfiable: required ${missing.join(", ")} not in properties`);
}

// The engine asks OpenAI for strict structured output, which needs every property required and no extra
// ones. Optional properties become nullable; fromStrict drops their nulls again before validation.
export function strictSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = { ...schema };
  if (schema.type === "object" || schema.properties) {
    const required = new Set(schema.required ?? []);
    out.properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, s]) => {
      const strict = strictSchema(s);
      return [k, required.has(k) ? strict : nullable(strict)];
    }));
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (schema.items) out.items = strictSchema(schema.items);
  for (const k of ["anyOf", "oneOf"]) if (schema[k]) out[k] = schema[k].map(strictSchema);
  return out;
}
const nullable = (s) => {
  if (typeof s.type === "string") return { ...s, type: [s.type, "null"] };
  if (Array.isArray(s.type)) return s.type.includes("null") ? s : { ...s, type: [...s.type, "null"] };
  return { anyOf: [s, { type: "null" }] };
};
export function fromStrict(value, schema) {
  if (!schema || typeof schema !== "object" || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return schema.items ? value.map((v) => fromStrict(v, schema.items)) : value;
  const required = new Set(schema.required ?? []);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null && !required.has(k) && schema.properties?.[k]) continue;
    out[k] = fromStrict(v, schema.properties?.[k]);
  }
  return out;
}

// The JSON object in a reply: the whole text, a fenced block, or the outermost braces.
export function jsonAnswer(text) {
  const t = String(text ?? "").trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t)?.[1];
  for (const s of [t, fenced, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)]) {
    if (!s) continue;
    try { const v = JSON.parse(s); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch {}
  }
  return undefined;
}
