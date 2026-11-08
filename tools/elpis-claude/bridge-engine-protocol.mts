import { wireEnvelope,wireId,wireObject } from "./bridge-wire.mts";
import { isTranscriptItem,isTranscriptTurn } from "./bridge-transcript.mts";
import type { AccessSettings,EngineThread,RequestId } from "./bridge-types.mts";

const string = (v: unknown): v is string => typeof v === "string";
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const optional = (v: unknown, check: (value: unknown) => boolean) => v === undefined || check(v);
const nullable = (v: unknown, check: (value: unknown) => boolean) => v === null || check(v);
const strings = (v: unknown) => Array.isArray(v) && v.every(string);
const status = (v: unknown) => wireObject(v) && optional(v.type, string) && optional(v.activeFlags, strings);

export function isEngineThread(v: unknown): v is EngineThread {
  return wireObject(v) && string(v.id) && optional(v.model, x => nullable(x, string))
    && optional(v.parentThreadId, x => nullable(x, string)) && optional(v.status, status)
    && optional(v.source, x => string(x) || (wireObject(x) && optional(x.custom, string)))
    && optional(v.turns, x => Array.isArray(x) && x.every(isTranscriptTurn))
    && [v.cwd, v.preview, v.modelProvider, v.workflowRunId].every(x => optional(x, string))
    && [v.name, v.path, v.reasoningEffort, v.workflowAgentId].every(x => optional(x, y => nullable(y, string)))
    && [v.createdAt, v.updatedAt].every(x => optional(x, number)) && optional(v.recencyAt, x => nullable(x, number))
    && optional(v.ephemeral, x => typeof x === "boolean");
}
const access = (v: unknown): v is AccessSettings => wireObject(v)
  && [v.approvalPolicy, v.approvalsReviewer, v.permissions].every(x => optional(x, string))
  && [v.activePermissionProfile, v.sandboxPolicy, v.sandbox].every(x => optional(x, y => nullable(y, z => wireObject(z) && optional(z.id, string) && optional(z.type, string))));
type EventTurn = { id: string; status?: string; [key: string]: unknown };
const turn = (v: unknown): v is EventTurn => wireObject(v) && string(v.id) && optional(v.status, string);
export type EngineResult = AccessSettings & { thread?: EngineThread; turn?: EventTurn; data?: unknown; config?: Record<string, unknown>;
  collaborationMode?: { settings?: Record<string, unknown> } | null; [key: string]: unknown };
const result = (v: unknown): v is EngineResult => wireObject(v) && access(v)
  && optional(v.thread, isEngineThread) && optional(v.turn, turn) && optional(v.config, wireObject)
  && optional(v.collaborationMode, x => nullable(x, y => wireObject(y) && optional(y.settings, wireObject)));
export type EngineEvent = { threadId?: string; thread?: EngineThread; turn?: EventTurn; status?: { type?: string; activeFlags?: string[] };
  threadName?: string | null; requestId?: RequestId; threadSettings?: AccessSettings; smartPrune?: { enabled?: boolean }; [key: string]: unknown };
const event = (v: unknown): v is EngineEvent => wireObject(v) && optional(v.threadId, string)
  && optional(v.thread, isEngineThread) && optional(v.turn, turn) && optional(v.status, status)
  && optional(v.threadName, x => nullable(x, string)) && optional(v.requestId, wireId) && optional(v.threadSettings, access)
  && optional(v.smartPrune, x => wireObject(x) && optional(x.enabled, y => typeof y === "boolean"));
type EngineError = { message?: string; code?: string | number; signedOut?: boolean; data?: unknown; [key: string]: unknown };
const error = (v: unknown): v is EngineError => wireObject(v) && optional(v.message, string)
  && optional(v.code, x => string(x) || typeof x === "number") && optional(v.signedOut, x => typeof x === "boolean");
export type EngineMessage = { id?: RequestId; method?: string; params?: EngineEvent; result?: EngineResult | null; error?: EngineError | null; [key: string]: unknown };
export function isEngineMessage(v: unknown): v is EngineMessage {
  return wireEnvelope(v)
    && optional(v.params, event) && optional(v.result, x => nullable(x, result))
    && optional(v.error, x => nullable(x, error));
}

const config = (v: unknown) => wireObject(v) && optional(v.model, x => nullable(x, string))
  && optional(v.features, x => nullable(x, y => wireObject(y) && optional(y.multi_agent, z => nullable(z, a => typeof a === "boolean"))));
const page = (v: unknown, row: (item: unknown) => boolean) => wireObject(v)
  && optional(v.data, x => Array.isArray(x) && x.every(row))
  && optional(v.nextCursor, x => nullable(x, string)) && optional(v.backwardsCursor, x => nullable(x, string));
const itemRow = (v: unknown) => wireObject(v) && optional(v.turnId, string) && isTranscriptItem(v.item)
  && nullable(v.startedAtMs, number) && nullable(v.completedAtMs, number);
const contextFile = (v: unknown) => wireObject(v) && string(v.path) && string(v.name) && string(v.group)
  && typeof v.included === "boolean" && typeof v.selectable === "boolean"
  && optional(v.estimatedTokens, number) && optional(v.reason, string);

/** Validate fields used by each typed internal engine call. */
export function validEngineReply(method: string, value: unknown): boolean {
  const typed = ["config/read", "configRequirements/read", "thread/read", "thread/resume", "thread/revert",
    "thread/loaded/list", "thread/turns/list", "thread/items/list", "thread/contextFiles/list", "thread/contextFiles/set",
    "thread/elpisInstructions/read", "thread/approval/review"];
  if (!typed.includes(method)) return true;
  if (!wireObject(value)) return false;
  switch (method) {
    case "config/read": return optional(value.config, config) && optional(value.layers, x => nullable(x, y => Array.isArray(y)
      && y.every(layer => wireObject(layer) && optional(layer.config, config))));
    case "configRequirements/read": return optional(value.requirements, x => nullable(x, wireObject));
    case "thread/read": case "thread/resume": case "thread/revert": return optional(value.thread, isEngineThread)
      && optional(value.approvalPolicy, string) && optional(value.activePermissionProfile, x => nullable(x, y => wireObject(y) && optional(y.id, string)))
      && optional(value.turnsBackwardsCursor, x => nullable(x, string));
    case "thread/loaded/list": return optional(value.data, strings);
    case "thread/turns/list": return page(value, isTranscriptTurn);
    case "thread/items/list": return page(value, itemRow);
    case "thread/contextFiles/list": case "thread/contextFiles/set": return Array.isArray(value.files) && value.files.every(contextFile);
    case "thread/elpisInstructions/read": return [value.developerInstructions, value.agentsMd, value.continuity].every(x => optional(x, y => nullable(y, string)));
    case "thread/approval/review": return optional(value.decision, string) && optional(value.rationale, string);
    default: return true;
  }
}
