"use strict";

type Chat = { manual: boolean; replies: Record<string, boolean>; dismissed?: string[]; plan?: string };
type State = { version: 2; chats: Record<string, Chat> };
type Op =
  | { kind: "complete"; id: string; turn: string; read: boolean; plan: boolean }
  | { kind: "read"; id: string; manual: boolean }
  | { kind: "unread"; id: string }
  | { kind: "clearPlan"; id: string; turn?: string };

const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200 && !["__proto__", "constructor", "prototype"].includes(value);
function operationImpl(value: unknown): value is Op {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!id(v.id)) return false;
  if (v.kind === "complete") return id(v.turn) && typeof v.read === "boolean" && typeof v.plan === "boolean";
  if (v.kind === "read") return typeof v.manual === "boolean";
  if (v.kind === "clearPlan") return v.turn === undefined || id(v.turn);
  return v.kind === "unread";
}
function parse(raw: string | null): State {
  let value: Record<string, unknown> = {};
  try { value = JSON.parse(raw || "{}"); } catch { /* recover as empty */ }
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  const chats: Record<string, Chat> = Object.create(null);
  if (value.version === 2 && value.chats && typeof value.chats === "object" && !Array.isArray(value.chats)) {
    for (const [key, rawChat] of Object.entries(value.chats)) {
      if (!id(key) || !rawChat || typeof rawChat !== "object" || Array.isArray(rawChat)) continue;
      const c = rawChat as Record<string, unknown>, replies: Record<string, boolean> = Object.create(null);
      if (c.replies && typeof c.replies === "object" && !Array.isArray(c.replies))
        for (const [turn, read] of Object.entries(c.replies)) if (id(turn) && typeof read === "boolean") replies[turn] = read;
      const dismissed = Array.isArray(c.dismissed) ? c.dismissed.filter(id) : [];
      chats[key] = { manual: c.manual === true, replies, ...(dismissed.length ? { dismissed } : {}), ...(id(c.plan) ? { plan: c.plan } : {}) };
    }
  } else {
    if (Array.isArray(value.unread)) for (const key of value.unread) if (id(key)) chats[key] = { manual: true, replies: {} };
    if (value.plans && typeof value.plans === "object" && !Array.isArray(value.plans))
      for (const [key, plan] of Object.entries(value.plans)) if (id(key) && id(plan)) {
        const chat = chats[key] ??= { manual: false, replies: {} };
        chat.plan = plan;
      }
  }
  return { version: 2, chats };
}
function applyImpl(raw: string | null, op: Op): string {
  if (!operationImpl(op)) throw Error("Unsupported attention operation");
  const state = parse(raw), chat = state.chats[op.id] ??= { manual: false, replies: Object.create(null) };
  if (op.kind === "complete") {
    chat.replies[op.turn] = chat.replies[op.turn] === true || op.read;
    if (op.plan && !chat.dismissed?.includes(op.turn)) chat.plan = op.turn;
  } else if (op.kind === "read") {
    for (const turn of Object.keys(chat.replies)) chat.replies[turn] = true;
    if (op.manual) chat.manual = false;
  } else if (op.kind === "unread") chat.manual = true;
  else {
    const dismissed = op.turn ?? chat.plan;
    if (dismissed && !chat.dismissed?.includes(dismissed)) chat.dismissed = [...(chat.dismissed ?? []), dismissed];
    if (!op.turn || chat.plan === op.turn) delete chat.plan;
  }
  return JSON.stringify({ ...state, ...project(state) });
}
function project(state: State) {
  const unread: string[] = [], plans: Record<string, string> = {};
  for (const [key, chat] of Object.entries(state.chats)) {
    if (chat.manual || Object.values(chat.replies).includes(false)) unread.push(key);
    if (chat.plan) plans[key] = chat.plan;
  }
  return { unread, plans };
}
function viewImpl(raw: string | null) { return project(parse(raw)); }
module.exports = { operation: operationImpl, apply: applyImpl, view: viewImpl };
export type { Op };
export declare const operation: (value: unknown) => value is Op;
export declare const apply: (raw: string | null, op: Op) => string;
export declare const view: (raw: string | null) => { unread: string[]; plans: Record<string, string> };
