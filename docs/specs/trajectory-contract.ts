/**
 * The JSON the Elpis Trajectory page reads from `GET /api/trajectory`.
 *
 * It is the data DeepSeek Harness's Trajectory view renders after its own layout step
 * (`packages/client/ui-trajectory/src/client/layout.ts` `TrajectoryTurnModel`,
 * `trajectory-record.ts` `TrajectoryCellProps`, `TrajectoryTable.tsx` `TrajectoryRequestNumber`),
 * restricted to plain data. The engine builds it from an Elpis rollout (JSONL); the page renders
 * it with the ported DeepSeek components. DeepSeek Harness is MIT licensed (Copyright 2026
 * DeepSeek); ported files keep that notice.
 *
 * Units: times are Unix epoch milliseconds; durations are seconds (`timeSeconds`). A value that
 * was not recorded is `null` or absent, never estimated.
 */

export interface TrajectoryDocument {
  /** Contract version; this file is version 1. */
  version: 1
  threadId: string
  /** Chat title, when the chat has one. */
  title?: string
  /** Workspace folder of the chat. */
  cwd?: string
  /** Last model and provider used. */
  model?: string
  provider?: string
  /** Model context window in tokens, when known. */
  contextWindow?: number
  /** Turns in display order (DeepSeek `TrajectoryTurnModel`). */
  turns: TrajectoryTurnModel[]
  /** One entry per model request, in order (DeepSeek `TrajectoryRequestNumber`). */
  requestNumbers: TrajectoryRequestNumber[]
  /** Whether the rollout could not be read to its end (a note is shown; earlier turns render). */
  truncated?: boolean
}

/** One sticky turn, or a standalone compaction section between turns (`turn: null`). */
export interface TrajectoryTurnModel {
  turn: number | null
  groups: TrajectoryGroupModel[]
}

/** One Message or Step group inside a turn. Titles: "Message", "Step {n}", "Compaction {seq}". */
export interface TrajectoryGroupModel {
  title: string
  /** DeepSeek shows the group's wall span here, e.g. "1,234 ms". */
  description?: string
  cells: TrajectoryCell[]
}

export type TrajectoryCellKind = 'system' | 'user' | 'context' | 'compacted' | 'message' | 'tool' | 'subtool'

/** One ledger row (DeepSeek `TrajectoryCellProps`, data fields only). */
export interface TrajectoryCell {
  /** 1-based record index shown as `#N`; unique across the document. */
  index: number
  recordId?: string
  kind: TrajectoryCellKind
  /** One-line summary shown in the row. */
  text: string
  previewMarkdown?: string
  /** Whether this user record opens a new model turn. */
  opensTurn?: boolean
  /** Rollout line number (0-based) of the record's source event; used as `seq`. */
  sourceSeq?: number
  /** Full input shown in the inspector's Input tab. */
  inputDetail?: string
  /** System prompt text, for a `system` record. */
  systemPromptDetail?: string
  /** Full output shown in the inspector's Output tab. */
  outputDetail?: string
  /** Assistant reasoning shown in the inspector, when the rollout holds it in clear text. */
  thinkingDetail?: string
  /** Tool JSON schema at call time, when known. */
  schemaDetail?: string
  assistantMetrics?: {
    timingRecorded: boolean
    stepStartTime: number | null
    firstTokenTime: number | null
    completedTime: number | null
    usageProvided: boolean
    outputTokens: number | null
  }
  /** Tool-only one-line result summary. */
  result?: string
  resultPreviewMarkdown?: string
  callId?: string
  toolName?: string
  isError?: boolean
  timeSeconds: number | null
  startedAt?: number | null
  /** Disjoint token buckets (uncached input, cache read, cache write, output, reasoning). */
  input?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  think?: number
}

/** Disjoint provider token buckets for one request or a session prefix. */
export interface TrajectoryUsage {
  input?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
}

export interface TrajectoryRequestNumber {
  /** The group title this request belongs to, e.g. "Step 2". */
  group: string
  /** Session-global request number, 1-based. */
  number: number
  purpose?: 'assistant' | 'compaction'
  seq?: number
  turn: number | null
  step: number
  status?: 'complete' | 'running' | 'error'
  startedAt?: number
  completedAt?: number | null
  error?: string
  provider?: string
  model?: string
  usage?: TrajectoryUsage
  cumulativeUsage?: TrajectoryUsage
  /**
   * Elpis addition: the request's prompt-cache verdict. `hitPercent` = cacheRead /
   * (input + cacheRead + cacheWrite) × 100, rounded. `cause` names the recorded change since the
   * previous request when the hit rate fell (e.g. "compaction", "model change", "Context Ledger
   * update"), or is absent.
   */
  cache?: { hitPercent: number; cause?: string }
}
