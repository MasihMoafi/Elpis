import type { McpElicitationSchema } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/McpElicitationSchema";
import type { RequestPermissionProfile } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/RequestPermissionProfile";
export type { McpElicitationSchema, RequestPermissionProfile };
export type ElicitationParams = {
  mode?: string; serverName?: string; message?: string; url?: string;
  requestedSchema?: McpElicitationSchema | null; _meta?: Record<string, unknown> | null;
};
export type ElicitationField = NonNullable<McpElicitationSchema["properties"][string]>;
export type FormValue = string | number | boolean | string[];
export type FormContent = Record<string, FormValue>;
type Choice = {label: string; action: string; persist?: string};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function elicitationChoices(params: ElicitationParams): Choice[] {
  const messageOnly = !params.requestedSchema || Object.keys(params.requestedSchema.properties).length === 0;
  const tool = params._meta?.codex_approval_kind === "mcp_tool_call" && messageOnly;
  const choices: Choice[] = [{label: messageOnly ? "Allow" : "Send answers", action:"accept"}];
  if (messageOnly) for (const [persist, label] of [["session", "Allow for this session"], ["always", "Always allow"]]) {
    const offered = params._meta?.persist;
    if (offered === persist || Array.isArray(offered) && offered.includes(persist)) choices.push({label, action:"accept", persist});
  }
  if (!tool) choices.push({label:"Deny", action:"decline"});
  choices.push({label:"Cancel", action:"cancel"});
  // Device verification needs native proof. Never fabricate an accepted response.
  return params.mode === "openai/userVerification" ? choices.filter(c => c.action !== "accept") : choices;
}

export function fieldOptions(field: ElicitationField): {value:string;label:string}[] {
  if ("enum" in field) return field.enum.map((value, i) => ({value,label:("enumNames" in field ? field.enumNames?.[i] : undefined) ?? value}));
  if ("oneOf" in field) return field.oneOf.map(option => ({value:option.const,label:option.title}));
  if (field.type === "array") {
    if ("enum" in field.items) return field.items.enum.map(value => ({value,label:value}));
    return field.items.anyOf.map(option => ({value:option.const,label:option.title}));
  }
  return [];
}

/** Called on the bridge as well as before the form submits. Values stay typed. */
export function validateElicitationContent(schema: McpElicitationSchema, content: unknown): asserts content is FormContent {
  if (!record(content) || Object.keys(content).some(key => !Object.hasOwn(schema.properties, key))) throw Error("Unsupported form fields");
  for (const [key, field] of Object.entries(schema.properties)) {
    if (!field) throw Error(`Unsupported field: ${key}`);
    const value = Object.hasOwn(content,key) ? content[key] : undefined, label = field.title || key;
    const invalid = () => { throw Error(`Check ${label}`); };
    if (value === undefined) { if (schema.required?.includes(key)) throw Error(`Answer ${label}`); continue; }
    if (field.type === "string") {
      if (typeof value !== "string") invalid();
      const text = value as string;
      if (schema.required?.includes(key) && !text.trim()) invalid();
      if ("minLength" in field && field.minLength !== undefined && [...text].length < field.minLength) invalid();
      if ("maxLength" in field && field.maxLength !== undefined && [...text].length > field.maxLength) invalid();
      if ("format" in field && field.format) {
        if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) invalid();
        if (field.format === "uri") { try { new URL(text); } catch { invalid(); } }
        if (field.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0,10) !== text)) invalid();
        if (field.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text)))) invalid();
      }
      const options = fieldOptions(field);
      if (options.length && !options.some(option => option.value === value)) invalid();
    } else if (field.type === "number" || field.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value) || field.type === "integer" && !Number.isInteger(value) || field.minimum !== undefined && (value as number) < field.minimum || field.maximum !== undefined && (value as number) > field.maximum) invalid();
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") invalid();
    } else if (field.type === "array") {
      const options = fieldOptions(field);
      if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !options.some(option => option.value === v)) || new Set(value).size !== value.length || field.minItems !== undefined && value.length < field.minItems || field.maxItems !== undefined && value.length > field.maxItems) invalid();
    } else throw Error(`Unsupported field: ${label}`);
  }
}

export function elicitationFormContent(schema: McpElicitationSchema, answers: Record<string, string[]>): FormContent {
  const fields = Object.entries(schema.properties).flatMap(([key, field]) => {
    if (!field) return [];
    const raw = answers[key]?.[0];
    if (raw === undefined) return field.default === undefined ? [] : [[key, field.default] as const];
    if (!raw && field.type !== "string") return [];
    if (!raw && !schema.required?.includes(key)) return [];
    const value = field.type === "number" || field.type === "integer" ? Number(raw) : field.type === "boolean" ? raw === "true" : field.type === "array" ? JSON.parse(raw) as string[] : raw;
    return [[key, value] as const];
  });
  const content = Object.fromEntries(fields);
  validateElicitationContent(schema, content);
  return content;
}

export function elicitationResponse(params: ElicitationParams, body: unknown) {
  if (!record(body) || Object.keys(body).some(key => !["action","content","_meta"].includes(key))) throw Error("Unsupported elicitation response");
  const meta = body._meta ?? null;
  if (meta !== null && (!record(meta) || Object.keys(meta).some(key => key !== "persist"))) throw Error("Unsupported approval metadata");
  const persist = record(meta) ? meta.persist : undefined;
  if (!elicitationChoices(params).some(choice => choice.action === body.action && choice.persist === persist)) throw Error("Decision is not offered for this request");
  const schema = params.requestedSchema;
  const form = schema && Object.keys(schema.properties).length > 0;
  if (body.action === "accept" && form) validateElicitationContent(schema, body.content);
  else if (body.content != null) throw Error("This response cannot include form content");
  return {action:body.action, content:body.action === "accept" && form ? body.content : null, _meta:meta};
}

export function grantedPermissions(permissions: RequestPermissionProfile) {
  return Object.fromEntries(Object.entries(permissions).filter(([, value]) => value != null));
}
const sameJson = (a: unknown, b: unknown): boolean => {
  if (record(a) && record(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b,key) && sameJson(a[key],b[key]));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v,i) => sameJson(v,b[i]));
  return a === b;
};
export function permissionsResponse(requested: RequestPermissionProfile, body: unknown) {
  if (!record(body) || Object.keys(body).some(key => !["permissions","scope","strictAutoReview"].includes(key)) || !record(body.permissions)) throw Error("Unsupported permissions response");
  if (body.scope !== "turn" && body.scope !== "session") throw Error("Unsupported permission scope");
  if (body.strictAutoReview !== undefined && (typeof body.strictAutoReview !== "boolean" || body.scope !== "turn")) throw Error("Strict auto review requires turn scope");
  if (!sameJson(body.permissions, {}) && !sameJson(body.permissions, grantedPermissions(requested))) throw Error("Grant only the requested permissions");
  if (!Object.keys(body.permissions).length && (body.scope !== "turn" || body.strictAutoReview)) throw Error("Deny without granting session scope");
  return body;
}
