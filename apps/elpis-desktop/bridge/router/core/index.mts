// Ported from dsh-superagent (MIT), src/core/index.ts
/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */
export * from "./model.mts";
export * from "./ports.mts";
export {
  Engine,
  type EngineForExecutor,
  type EngineForMainSession,
  type EngineForPeople,
  type EngineForSettings,
  type EngineForSources,
  type EngineOptions,
  type Outcome,
  type ReceiveResult,
  type Reply,
  type ReplyRequest,
  type WorkerReport,
} from "./engine.mts";
export { UserError, USER_ERRORS, type UserErrorCode } from "./errors.mts";
export { REASONS, reasonText, said, type Reason, type ReasonCode } from "./reasons.mts";
export { MemoryRepositories } from "./memory.mts";
export { canRetry, ticketStage, type TicketStage } from "./stage.mts";
export { key } from "./ids.mts";
