import type { DesktopClientOptions } from "./client.mts";
import type { BrowserConfig } from "./client-state.mts";

export type FixtureThread = {
  id: string;
  name?: string | null;
  preview?: string | null;
  agentNickname?: string;
  source?:
    string | { subAgent?: { thread_spawn?: { parent_thread_id?: string; agent_path?: string }; other?: string } };
  cwd?: string;
  path?: string;
  model?: string | null;
  modelProvider?: string;
  status: { type: string };
  archived?: boolean;
  parentThreadId?: string | null;
  forkedFromId?: string;
  canAcceptDirectInput?: boolean;
  collaborationMode?: { mode: string; settings?: object };
  reasoningEffort?: string;
};

export type FixtureParams = {
  threadId?: string;
  rootThreadId?: string;
  turnId?: string;
  expectedTurnId?: string;
  lastTurnId?: string;
  name?: string;
  model?: string;
  modelProvider?: string;
  provider?: string;
  reasoningEffort?: string;
  cursor?: string | null;
  limit?: number;
  archived?: boolean;
  ancestorThreadId?: string;
  sourceKinds?: string[];
  searchTerm?: string;
  config?: Record<string, unknown>;
  edits?: { keyPath: string; value: unknown; mergeStrategy?: string }[];
  input?: { type: string; text?: string }[];
  includeTurns?: boolean;
  additionalContext?: Record<string, { kind: string; value: string }>;
  collaborationMode?: { mode: string; settings: { model: string } };
  [key: string]: unknown;
};

export type FixtureRequest = {
  id?: string | number;
  method?: string;
  params?: FixtureParams;
  result?: unknown;
  error?: { code: number; message?: string };
};

export type FixtureProvider = {
  name?: string;
  base_url?: string;
  env_key?: string;
  wire_api?: string;
  experimental_bearer_token?: string;
  http_headers?: Record<string, string>;
  requires_openai_auth?: boolean;
  auth?: { command: string };
};

export type FixtureLayer = {
  name: { type: string; file: string };
  version: string;
  config: Record<string, unknown>;
  disabledReason?: string;
};

export type FixtureGraph = {
  id: string;
  rootThreadId: string;
  name?: string;
  status?: string;
  tasks: { id: string; title?: string; assignedThreadId?: string; status?: string }[];
};

export type ApprovalEvent =
  | {
      type: "approval";
      data: {
        id: string;
        wireId?: string;
        ownerThreadId: string;
        thread: { name: string };
        params: { threadId: string };
      };
    }
  | { type: "approvalResolved"; data: { id: string } };

export type FixtureOptions = {
  prunerSupported?: boolean;
  omitWorkflowParentInList?: boolean;
  replacementPages?: Record<string, unknown>;
  promptPages?: Record<string, unknown>;
  browserConfig?: BrowserConfig;
  threadListPaging?: boolean;
  archiveDirectory?: string;
  clientOptions?: DesktopClientOptions;
};
