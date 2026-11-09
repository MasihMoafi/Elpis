import type {
  FixtureThread,
  FixtureProvider,
  FixtureLayer,
  FixtureGraph,
  FixtureOptions,
} from "./bridge-fixture-types.fixtures.mts";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import assert from "node:assert/strict";

export function fixtureData({
  prunerSupported = false,
  omitWorkflowParentInList = false,
  replacementPages,
  promptPages,
  browserConfig,
  threadListPaging = false,
  archiveDirectory = path.join(os.tmpdir(), `bridge-archives-${randomUUID()}`),
  clientOptions = {},
}: FixtureOptions = {}) {
  const workflowRecords: FixtureGraph[] = [];
  const pruner: {
    model: string;
    provider: string;
    version: string;
    providers: { id: string; displayName: string }[];
    systemPrompt: string;
    reasoningEffort?: string | null;
  } = {
    model: "optimizer-original",
    provider: "openai",
    version: "pruner-v1",
    providers: [{ id: "openai", displayName: "OpenAI" }],
    systemPrompt: "PRIVATE CONFIG SECRET",
  };
  const configRead = {
    config: Object.assign(
      {
        model: MODEL,
        model_provider: "openai",
        background_model: "cheap-model",
        background_provider: "local",
        features: { automatic_context_pruning: true } as Record<string, boolean | undefined>,
        memories: { use_memories: true, generate_memories: false } as Record<string, boolean>,
        model_providers: {
          local: {
            name: "Local provider",
            base_url: "http://127.0.0.1:1234/v1?key=PRIVATE CONFIG SECRET",
            http_headers: { Authorization: "PRIVATE CONFIG SECRET" },
          },
          openrouter: {
            name: "OpenRouter",
            base_url: "https://openrouter.ai/api/v1",
            env_key: "APP_TEST_OPENROUTER_KEY",
          },
        } as Record<string, FixtureProvider> & { local: FixtureProvider; openrouter: FixtureProvider },
        mcp_servers: {
          rag: {
            command: "/usr/bin/python",
            args: ["--token", "PRIVATE CONFIG SECRET"],
            env: { OPENROUTER_API_KEY: "PRIVATE CONFIG SECRET", RAG_MCP_BACKEND: "lancedb" },
          },
          whispertype: {
            command: "python",
            env_vars: ["APP_TEST_COMPANY_KEY"],
            env: { WHISPERTYPE_BACKEND: "local", WHISPERTYPE_CLOUD_MODEL: "openai/gpt-4o-mini-transcribe" },
          },
          remote: {
            url: "https://mcp.example/path?token=PRIVATE CONFIG SECRET",
            bearer_token_env_var: "APP_TEST_BEARER",
            enabled: false,
          },
        } as {
          rag?: { command: string; args: string[]; env: Record<string, string>; enabled?: boolean };
          whispertype: { command: string; env_vars: string[]; env: Record<string, string> };
          remote: { url: string; bearer_token_env_var: string; enabled: boolean };
        },
        api_key: "PRIVATE CONFIG SECRET",
      },
      {} as { approval_policy?: string; default_permissions?: string; approvals_reviewer?: string },
    ),
    layers: [
      {
        name: { type: "user", file: "/private/config.toml" },
        version: "user-version",
        config: { secret: "PRIVATE CONFIG SECRET" },
      },
    ] as FixtureLayer[],
  };
  const requirementsRead: { requirements: ({ modelProvider?: string | null } & Record<string, unknown>) | null } = {
    requirements: null,
  };
  const hooksList = {
    data: [
      {
        cwd: "/work",
        warnings: ["hooks.json: unknown field ignored"],
        errors: [],
        hooks: [
          {
            key: "user:/private/hooks.json:pre_tool_use:0:0",
            eventName: "preToolUse",
            handlerType: "command",
            command: "rtk hook claude",
            async: false,
            matcher: "^Bash$",
            timeoutSec: 5,
            statusMessage: "compressing shell output",
            sourcePath: "/home/person/.elpis-next/hooks.json",
            source: "user",
            pluginId: null,
            displayOrder: 0,
            enabled: true,
            isManaged: false,
            currentHash: "sha256:current",
            trustStatus: "untrusted",
          },
          {
            key: "managed:/etc/requirements.toml:stop:0:0",
            eventName: "stop",
            handlerType: "command",
            command: "audit",
            matcher: null,
            timeoutSec: 30,
            statusMessage: null,
            sourcePath: "/etc/requirements.toml",
            source: "system",
            pluginId: null,
            displayOrder: 1,
            enabled: true,
            isManaged: true,
            currentHash: "sha256:managed",
            trustStatus: "managed",
          },
        ],
      },
    ],
  };
  const threads = new Map<string, FixtureThread>([
    [
      ROOT,
      {
        id: ROOT,
        name: "Existing root",
        source: "cli",
        cwd: os.tmpdir(),
        model: MODEL,
        modelProvider: "openai",
        status: { type: "idle" },
      },
    ],
    [
      CHILD,
      {
        id: CHILD,
        name: null,
        preview: "",
        agentNickname: "Sagan",
        model: MODEL,
        modelProvider: "openai",
        parentThreadId: ROOT,
        canAcceptDirectInput: false,
        source: { subAgent: { thread_spawn: { parent_thread_id: ROOT, agent_path: "/root/failure_reporting" } } },
        status: { type: "active" },
      },
    ],
  ]);
  return {
    workflowRecords,
    pruner,
    configRead,
    requirementsRead,
    hooksList,
    threads,
    prunerSupported,
    omitWorkflowParentInList,
    replacementPages,
    promptPages,
    browserConfig,
    threadListPaging,
    archiveDirectory,
    clientOptions,
  };
}

export type FixtureData = ReturnType<typeof fixtureData>;

export function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

export const ROOT = "00000000-0000-0000-0000-000000000001";

export const CHILD = "00000000-0000-0000-0000-000000000002";

export const CREATED = "00000000-0000-0000-0000-000000000003";

export const MODEL = "test-model";

export const FORK = "00000000-0000-0000-0000-000000000007";

// The engine's built-in permission profiles and the sandbox each one runs.
export const PROFILE_SANDBOX: Record<string, { type: string }> = {
  ":workspace": { type: "workspaceWrite" },
  ":danger-full-access": { type: "dangerFullAccess" },
  ":bypass-permissions": { type: "dangerFullAccess" },
};
