import { wireEnvelope, wireId, wireObject } from "./bridge-wire.mts";
import { isPromptInput } from "./bridge-transcript.mts";
import { isApprovalPolicy } from './approval-policy.mts';
import type { GlobalParams, GlobalRequest, ThreadRequest } from "./bridge-types.mts";

const string = (v: unknown): v is string => typeof v === "string";
const bool = (v: unknown) => typeof v === "boolean";
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const optional = (v: unknown, check: (value: unknown) => boolean) => v === undefined || check(v);
const nullable = (v: unknown, check: (value: unknown) => boolean) => v === null || check(v);
const array = (v: unknown, check: (value: unknown) => boolean) => Array.isArray(v) && v.every(check);
const strings = (v: unknown) => array(v, string);
const historyOptions = (v: unknown) => wireObject(v) && optional(v.limit, x => nullable(x, number))
  && [v.sortDirection, v.itemsView].every(x => optional(x, y => nullable(y, string))) && optional(v.cursor, string) && optional(v.turnId, string);
const params = (v: unknown): v is GlobalParams => wireObject(v)
  && [v.threadId, v.approvalsReviewer, v.permissions, v.rootThreadId, v.action, v.id, v.code,
    v.scriptPath, v.resumeFromRunId, v.sortDirection, v.itemsView, v.cursor, v.turnId, v.beforeTurnId, v.lastTurnId,
    v.queuedSubmissionId, v.objective, v.status, v.instructions, v.ancestorThreadId, v.sortKey, v.searchTerm,
    v.elpisParentThreadId, v.elpisRequestedScope, v.parentThreadId].every(x => optional(x, string))
  && [v.model, v.effort, v.script, v.clientUserMessageId].every(x => optional(x, y => nullable(y, string)))
  && [v.excludeTurns, v.includeTurns, v.archived].every(x => optional(x, bool))
  && optional(v.approvalPolicy, isApprovalPolicy)
  && optional(v.limit, number) && [v.budget, v.tokenBudget].every(x => optional(x, y => nullable(y, number)))
  && optional(v.cwd, x => string(x) || strings(x)) && optional(v.input, x => array(x, isPromptInput))
  && [v.queuedSubmissionIds, v.clientUserMessageIds, v.sourceKinds, v.modelProviders].every(x => optional(x, strings))
  && optional(v.initialTurnsPage, historyOptions) && optional(v.config, wireObject)
  && optional(v.sandbox, x => x === "read-only" || x === "workspace-write" || x === "danger-full-access")
  && optional(v.sandboxPolicy, x => string(x) || (wireObject(x) && optional(x.type, string)))
  && optional(v.target, x => wireObject(x) && [x.type, x.branch, x.sha, x.title, x.instructions].every(y => optional(y, string)))
  && optional(v.clientInfo, x => wireObject(x) && optional(x.name, string))
  && optional(v.edits, x => array(x, edit => wireObject(edit) && string(edit.keyPath)))
  && optional(v.elpisWorkflow, x => wireObject(x) && optional(x.runId, string) && optional(x.agentId, y => nullable(y, string)))
  && optional(v.collaborationMode, x => wireObject(x) && optional(x.mode, string)
    && optional(x.settings, y => wireObject(y) && optional(y.model, z => nullable(z, string)) && optional(y.developer_instructions, z => nullable(z, string))));

/** Accept objects only after checking every field the bridge reads. Other envelopes pass through. */
export function readClientRequest(value: unknown): GlobalRequest | null {
  if (!wireEnvelope(value) || !wireId(value.id) || !string(value.method)) return null;
  const raw = value.params == null ? {} : value.params;
  // In the app-server schema these null overrides mean the same as omission.
  const optionalNulls = ["threadId", "cwd", "config", "approvalPolicy", "approvalsReviewer", "permissions", "sandbox", "sandboxPolicy",
    "cursor", "limit", "sortKey", "sortDirection", "itemsView", "turnId", "modelProviders", "sourceKinds", "archived", "searchTerm",
    "beforeTurnId", "lastTurnId", "initialTurnsPage", "collaborationMode"];
  const p = wireObject(raw) ? { ...raw } : raw;
  if (wireObject(p)) for (const key of optionalNulls) if (p[key] === null) delete p[key];
  if (!params(p)) return null;
  return { ...value, id: value.id, method: value.method, params: p };
}

export function isThreadRequest(value: GlobalRequest): value is ThreadRequest {
  return string(value.params.threadId) && (value.params.cwd === undefined || string(value.params.cwd));
}

export function isStartRequest(value: GlobalRequest): value is GlobalRequest & { params: GlobalParams & { cwd?: string; config?: Record<string, unknown> & { model_reasoning_effort?: string | null } } } {
  const config = value.params.config;
  return (value.params.cwd === undefined || string(value.params.cwd))
    && (config === undefined || optional(config.model_reasoning_effort, x => nullable(x, string)));
}
