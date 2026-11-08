export const NOTIFICATIONS = new Set([
  "thread/realtime/sdp",
  "thread/realtime/started",
  "thread/realtime/error",
  "thread/realtime/closed",
  "thread/tokenUsage/updated",
  "thread/smartPrune/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/started",
  "thread/status/changed",
  "thread/name/updated",
  "thread/settings/updated",
  "thread/closed",
  "thread/archived",
  "thread/unarchived",
  "thread/deleted",
  "turn/started",
  "turn/completed",
  "turn/aborted",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "turn/activityUpdated",
  "turn/costUpdated",
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "error",
  "serverRequest/resolved",
]);

export const APPROVALS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
]);

// Account changes have no thread; every app window may show them.
export const LISTED = new Set(["thread/started", "thread/status/changed", "thread/name/updated"]);

export const ACCOUNT_NOTIFICATIONS = new Set([
  "account/updated",
  "account/login/completed",
  "account/rateLimits/updated",
]);

const READ_RPCS = new Set([
  "initialize",
  "externalAgentConfig/detect",
  "externalAgentConfig/import/readHistories",
  "thread/list",
  "thread/read",
  "thread/items/list",
  "thread/turns/list",
  "model/list",
  "experimentalFeature/list",
  "claudeAccounts/read",
  "account/read",
  "account/rateLimits/read",
  "config/read",
  "configRequirements/read",
  "pruner/read",
  "workGraph/list",
  "hooks/list",
  "workflowRun/list",
  "workflowRun/read",
]);

export const readRpc = (method: string, params: unknown) =>
  READ_RPCS.has(method) ||
  ["thread/goal/get", "thread/contextFiles/list"].includes(method) ||
  (method === "thread/resume" &&
    Object.keys((params || {}) as object).every(key => ["threadId", "excludeTurns", "initialTurnsPage"].includes(key)));

/** Requests that download (a Git clone, a plugin bundle) can take minutes; the rest answer within the default wait. */
export const DOWNLOADS = new Set(["marketplace/add", "marketplace/upgrade", "plugin/install"]);

// The engine refuses to resume an archived chat and names its terminal command (`codex unarchive`), which this app does not have.
export const ARCHIVED_SESSION = /^session \S+ is archived\./;

export const archivedSession = (error: unknown) =>
  ARCHIVED_SESSION.test((error as { engineMessage?: string } | null | undefined)?.engineMessage ?? "");

// thread/read opens a chat before any change since 31 Oct (it used to be thread/resume): a missing chat still says so.
export const EXPLAINED = new Set([
  "externalAgentConfig/import",
  "thread/read",
  "thread/settings/update",
  "model/list",
  "account/read",
  "account/rateLimits/read",
  "thread/delete",
  "thread/fork",
  "thread/start",
  "thread/resume",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/revert",
  "thread/compact/start",
  "review/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "config/batchWrite",
  "account/login/start",
  "account/logout",
  "claudeSubscription/write",
  "hooks/list",
  "memory/reset",
  "plugin/list",
  "plugin/search",
  "plugin/install",
  "plugin/uninstall",
  "marketplace/add",
  "marketplace/remove",
]);

/** What a module with a conversation of its own (bridge/side-turn.mts: the canvas planner and chat titles) may ask of the
 * engine; see `sideRpc`. config/read names the MCP servers a chat-title conversation switches off. */
export const SIDE_RPCS = new Set([
  "thread/start",
  "turn/start",
  "turn/interrupt",
  "thread/unsubscribe",
  "thread/delete",
  "config/read",
]);
