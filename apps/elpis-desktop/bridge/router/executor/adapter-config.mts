import type { RoleModel } from "./settings.mts";
import { WORKER_ENV_EXCLUDE } from "../infra/git-environment.mts";
import type { Tool } from "../app/tools/tool.mts";
import type { TranscriptEvent } from "../app/host.mts";
import type { McpRuntime } from "./tool-runtime.mts";

export type Runtime = "elpis" | "codex" | "claude" | "gemini";

export interface Connection {
  readonly ready: Promise<unknown>;
  readonly closed: boolean;
  readonly listeners: Set<(message: unknown) => void>;
  readonly requests?: Set<(message: unknown) => boolean>;
  respond?(id: string | number, result: object): void;
  call(method: string, params: object): Promise<unknown>;
  onClose(listener: (why: string) => void): unknown;
  close(): void;
}

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const shellConfig = (values: Record<string, string | undefined>) => ({
  "shell_environment_policy.inherit": "all",
  "shell_environment_policy.ignore_default_excludes": false,
  "shell_environment_policy.exclude": ["*KEY*", "*PASSWORD*", "*SECRET*", "*TOKEN*", ...WORKER_ENV_EXCLUDE],
  "shell_environment_policy.set": Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
});

export const string = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

export const managedInstructions =
  "This is a managed Elpis session. Its current role instructions are supplied at each turn in collaboration mode developer instructions.";

/** Main work stays in the domain queue; workers keep native coding tools without independent goals or interactive prompts. */
export function roleConfig(role: OpenOptions["role"]): Record<string, unknown> {
  return {
    "features.code_mode": false,
    "features.apps": false,
    "features.plugins": false,
    "features.goals": false,
    "features.image_generation": false,
    "tools.experimental_request_user_input.enabled": false,
    ...(role === "orchestrator"
      ? {
          "features.shell_tool": false,
          "features.unified_exec": false,
          "features.apply_patch_freeform": false,
          "features.view_image": false,
          "features.multi_agent": false,
          "features.multi_agent_v2": false,
          web_search: "disabled",
        }
      : {}),
  };
}

export function runtimeOf(model: RoleModel | null): Runtime {
  if (model?.provider === "claude" || model?.model.startsWith("claude/")) return "claude";
  if (["agy", "gemini"].includes(model?.provider ?? "") || model?.model.startsWith("agy/")) return "gemini";
  return model?.provider === "codex" ? "codex" : "elpis";
}

export interface WorkerSession {
  threadId: string;
  activeTurn: string | null;
  model: string | null;
  messages: { id: string; text: string }[];
  result?: { id: string; text: string };
  transcript?: TranscriptEvent[];
}

export interface ToolBinding {
  tools(): Tool[];
  instructions(): string;
  authorize(): void;
  signal: AbortSignal;
  environment?(): Record<string, string | undefined>;
  mcp?(): Promise<McpRuntime>;
}

export interface OpenOptions {
  cwd: string;
  name: string;
  model: RoleModel | null;
  parentThreadId?: string;
  instructions?: string;
  tools?: Tool[];
  role?: "orchestrator" | "worker";
  environment?: Record<string, string | undefined>;
  mcp?: McpRuntime;
}

export interface RuntimeAdapter {
  readonly runtime: Runtime;
  open(options: OpenOptions): Promise<WorkerSession>;
  read(threadId: string): Promise<WorkerSession>;
  archive?(threadId: string): Promise<void>;
  send(
    threadId: string,
    id: string,
    text: string,
    activeTurn: string | null,
    includedIds?: readonly string[],
  ): Promise<string>;
  stop(threadId: string, turnId: string): Promise<void>;
  background(threadId: string): Promise<{ jobs: { id: string; label: string }[]; children: { id: string }[] }>;
  killJob(threadId: string, processId: string): Promise<void>;
  subscribe(threadId: string, listener: (message: unknown) => void): () => void;
  bind?(threadId: string, binding: ToolBinding): void;
  configure?(threadId: string, mcp: McpRuntime, environment?: Record<string, string | undefined>): Promise<void>;
  drain?(): Promise<void>;
  close(): void;
}

/** Stable delivery IDs also live in the runtime's own history, covering a crash before the local receipt commits. */
export const marker = (id: string, includedIds: readonly string[]): string =>
  `<elpis-router-message id="${encodeURIComponent(id)}"${includedIds.length ? ` includes="${includedIds.map(encodeURIComponent).join(",")}"` : ""}>`;

export function messages(turns: unknown[]): WorkerSession["messages"] {
  return turns.flatMap(turn => {
    const items = object(turn).items;
    if (!Array.isArray(items)) return [];
    return items.flatMap(item => {
      const value = object(item);
      if (value.type !== "userMessage" || !Array.isArray(value.content)) return [];
      const text = value.content.map(block => string(object(block).text) ?? "").join("\n");
      const match = /^<elpis-router-message id="([^"]+)"(?: includes="([^"]*)")?>\n/.exec(text);
      if (!match?.[1]) return [];
      // Only the host's first-line envelope is a receipt; quoted incoming text cannot forge another one.
      try {
        return [match[1], ...(match[2]?.split(",") ?? [])].map(id => ({ id: decodeURIComponent(id), text }));
      } catch {
        return [];
      }
    });
  });
}
