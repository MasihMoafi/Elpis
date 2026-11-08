export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number };

export type Metrics = {
  timingRecorded: boolean;
  stepStartTime: number | null;
  firstTokenTime: number | null;
  completedTime: number | null;
  usageProvided: boolean;
  outputTokens: number;
};

export type Cell = {
  index: number;
  kind: string;
  text: string;
  timeSeconds: number | null;
  sourceSeq?: number | undefined;
  inputDetail?: string | undefined;
  outputDetail?: string | undefined;
  thinkingDetail?: string | undefined;
  systemPromptDetail?: string | undefined;
  opensTurn?: boolean | undefined;
  callId?: string | undefined;
  toolName?: string | undefined;
  startedAt?: number | undefined;
  result?: string | undefined;
  isError?: boolean | undefined;
  assistantMetrics?: Metrics | undefined;
  input?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  output?: number | undefined;
  think?: number | undefined;
};

export type Group = { title: string; cells: Cell[]; description?: string };

export type Turn = { turn: number | null; groups: Group[] };

export type Document = {
  version: number;
  threadId: string;
  turns: Turn[];
  requestNumbers: Record<string, unknown>[];
  cwd?: string;
  provider?: string;
  model?: string;
  contextWindow?: number;
  truncated?: boolean;
};

export type Payload = {
  id?: unknown;
  cwd?: unknown;
  model_provider?: unknown;
  base_instructions?: { text?: unknown } | null;
  model?: unknown;
  full?: boolean;
  state?: unknown;
  usage?: unknown;
  type?: string;
  started_at?: unknown;
  model_context_window?: unknown;
  time_to_first_token_ms?: unknown;
  info?: { last_token_usage?: unknown } | null;
  item?: { id?: unknown } | null;
  started_at_ms?: unknown;
  completed_at_ms?: unknown;
  role?: string;
  content?: unknown;
  summary?: unknown;
  name?: unknown;
  arguments?: unknown;
  input?: unknown;
  action?: unknown;
  call_id?: unknown;
  output?: unknown;
  tools?: unknown;
  message?: unknown;
};

export type Row = { timestamp?: unknown; type?: string; payload?: Payload | null };

// Port of codex-rs/elpis-trajectory/src/projection.rs. Times and usage come from the rollout.
export const CACHE_DROP_POINTS = 20;

export const IDLE_REPORT_MS = 300_000;

export const PRUNE_PREFIX = "elpis.context-prune.v1:";

export const USAGE_RECORD = '"type":"token_usage_record"';

export const str = (value: unknown) => (typeof value === "string" ? value : undefined);

export const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

export const present = <T extends Record<string, unknown>>(entries: T): T =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as T;

export const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(k => [k, sorted((value as Record<string, unknown>)[k])]),
        )
      : value;

export const json = (value: unknown): string => JSON.stringify(sorted(value)) as string;

export const textOf = (parts: unknown) =>
  Array.isArray(parts)
    ? (parts as unknown[])
        .map(p => str((p as { text?: unknown } | null)?.text))
        .filter(v => v !== undefined)
        .join("\n")
    : "";

export const summary = (text: string) => {
  const line = (text.split(/\r?\n/).find(s => s.trim()) ?? "").trim();
  const chars = Array.from(line);
  return chars.length > 160 ? `${chars.slice(0, 160).join("")}…` : line;
};

export function timestamp(value: unknown) {
  if (typeof value !== "string" || !value.endsWith("Z")) return undefined;
  const match = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)(?:\.(.*))?Z$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d, h, min, s, fraction = "0"] = match;
  const ms = (fraction + "000").slice(0, 3);
  if (!/^\d{3}$/.test(ms)) return undefined;
  let year = Number(y);
  const month = Number(m);
  year -= month <= 2 ? 1 : 0;
  const era = Math.trunc((year >= 0 ? year : year - 399) / 400);
  const yoe = year - era * 400,
    mp = (month + 9) % 12;
  const doy = Math.trunc((153 * mp + 2) / 5) + Number(d) - 1;
  const days = era * 146097 + yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy - 719468;
  return ((days * 24 + Number(h)) * 60 + Number(min)) * 60000 + Number(s) * 1000 + Number(ms);
}

export function engineUsage(value: unknown) {
  if (value == null || typeof value !== "object" || !Object.hasOwn(value, "input_tokens")) return undefined;
  const num = (key: string) => Math.max(integer((value as Record<string, unknown>)[key]) ?? 0, 0);
  const cacheRead = num("cached_input_tokens"),
    cacheWrite = num("cache_write_input_tokens");
  return {
    input: Math.max(num("input_tokens") - cacheRead - cacheWrite, 0),
    cacheRead,
    cacheWrite,
    output: num("output_tokens"),
    reasoning: num("reasoning_output_tokens"),
  };
}

export function outputFailed(output: string) {
  const start = output.trimStart();
  if (start.startsWith("Error") || start.startsWith("error:")) return true;
  try {
    const object = JSON.parse(start);
    if (object && typeof object === "object" && !Array.isArray(object)) {
      if (object.success === false) return true;
      const code = integer(object.metadata?.exit_code ?? object.exit_code);
      if (code !== undefined) return code !== 0;
    }
  } catch {
    /* Not a JSON result. */
  }
  const exit = start.split(/\r?\n/).find(line => line.startsWith("Exit code: "));
  const code = exit?.slice(11).trim();
  return code !== undefined && /^[+-]?\d+$/.test(code) && Number(code) !== 0;
}

export const cell = (kind: string, text: string, extra: Partial<Cell> = {}): Cell =>
  present({ index: 0, kind, text, timeSeconds: null, ...extra }) as Cell;

export const injected = (text: string) =>
  [
    "<environment_context>",
    "<user_instructions>",
    "# AGENTS.md instructions",
    "## Elpis Admitted Context",
    "<turn_aborted>",
    "<user_shell_command>",
    "<permissions instructions>",
    "<skill>",
  ].some(marker => text.trimStart().startsWith(marker));
