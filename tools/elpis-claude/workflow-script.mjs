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

// The hooks the script sees are made inside its own context, so nothing it can reach belongs to the runner's realm: a
// runner function, promise or error there would hand it that realm's Function, and with it `process` (24 Oct review:
// `log.constructor('return process')()` reached the bridge's file system and shell). The runner's side is `host`,
// kept in a closure: every value crosses as a string or a number.
//   host.agent(prompt, optsJSON, phase) -> Promise of JSON   host.workflow(refJSON, argsJSON) -> Promise of JSON
//   host.post(kind, a, b) (phase, log, scriptError)          host.spent() -> number
const HOOKS = `"use strict";
(host, config, body) => {
  const C = JSON.parse(config);
  const own = (e) => {
    let message = "Error", name = "Error";
    try { message = String(e && e.message !== undefined ? e.message : e); name = String((e && e.name) || "Error"); } catch {}
    const made = name === "TypeError" ? new TypeError(message) : name === "RangeError" ? new RangeError(message) : new Error(message);
    if (made.name !== name) made.name = name;
    return made;
  };
  const call = async (method, ...a) => {
    let text;
    try { text = await host[method](...a); } catch (e) { throw own(e); }
    return typeof text === "string" ? JSON.parse(text) : null;
  };
  const why = (e) => { try { return String(e && e.message !== undefined ? e.message : e).slice(0, 300); } catch { return "error"; } };
  const items = (list, what) => {
    if (!Array.isArray(list)) throw new TypeError(what + " takes an array");
    if (list.length > C.maxItems) throw new RangeError(what + " accepts at most " + C.maxItems + " items (got " + list.length + "); split the work into several calls");
  };
  let current = null;
  const agent = async (prompt, opts) => {
    if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("agent() needs a prompt (a non-empty string)");
    let o;
    try { o = JSON.stringify(opts === undefined ? {} : opts); } catch (e) { throw new TypeError("agent() options must be plain data: " + why(e)); }
    const phase = opts && typeof opts === "object" && typeof opts.phase === "string" ? opts.phase : current;
    return call("agent", prompt, o === undefined ? "null" : o, phase);
  };
  const parallel = async (thunks) => {
    items(thunks, "parallel()");
    const out = await Promise.all(thunks.map((t, i) => Promise.resolve().then(() => t()).catch((e) => { host.post("scriptError", "parallel() task " + i, why(e)); return null; })));
    return out.map((v) => (v === undefined ? null : v));
  };
  const pipeline = async (list, ...stages) => {
    items(list, "pipeline()");
    if (stages.some((s) => typeof s !== "function")) throw new TypeError("pipeline() stages must be functions");
    return Promise.all(list.map(async (item, index) => {
      let value = item;
      for (let n = 0; n < stages.length; n++) {
        try { value = await stages[n](value, item, index); }
        catch (e) { host.post("scriptError", "pipeline() item " + index + ", stage " + (n + 1), why(e)); return null; }
      }
      return value === undefined ? null : value;
    }));
  };
  const phase = (title) => { current = String(title); host.post("phase", current); };
  const log = (message) => { host.post("log", typeof message === "string" ? message : JSON.stringify(message)); };
  const budget = Object.freeze({
    total: C.budgetTotal,
    spent: () => Number(host.spent()),
    remaining: () => (C.budgetTotal === null ? Infinity : Math.max(0, C.budgetTotal - Number(host.spent()))),
  });
  const workflow = async (ref, args) => {
    if (C.nested) throw new Error("workflow() nesting is one level only: a workflow run by workflow() cannot run another");
    const target = ref && typeof ref === "object" ? { scriptPath: ref.scriptPath } : ref;
    return call("workflow", JSON.stringify(target === undefined ? null : target), args === undefined ? undefined : JSON.stringify(args));
  };
  const hooks = { agent, parallel, pipeline, phase, log, budget, workflow, args: C.args === undefined ? undefined : JSON.parse(C.args) };
  for (const name of Object.keys(hooks)) Object.defineProperty(globalThis, name, { value: hooks[name], writable: true, configurable: true });
  return (async () => {
    const value = await body();
    try { return value === undefined ? "null" : JSON.stringify(value); }
    catch (e) { throw new Error("The script's return value is not JSON: " + why(e)); }
  })();
}`;

// Compiles the body once; run(host, config) returns a promise of the script's return value as JSON text.
//   config: { args (JSON text or undefined), budgetTotal (number or null), maxItems, nested }
export function compileScript(source, filename = "workflow.js") {
  const { meta, body } = parseScript(source);
  let code;
  try { code = new vm.Script(`(async () => {\n${body}\n})`, { filename, lineOffset: -1 }); }
  catch (e) { throw new ScriptError(`The script does not parse (plain JavaScript only, no TypeScript): ${e.message}`); }
  return {
    meta,
    run(host, { args, budgetTotal = null, maxItems, nested = false } = {}) {
      const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
      vm.runInContext(GUARDS, context);
      const start = vm.runInContext(HOOKS, context);
      return start(host, JSON.stringify({ args, budgetTotal: budgetTotal ?? null, maxItems, nested }), code.runInContext(context));
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
