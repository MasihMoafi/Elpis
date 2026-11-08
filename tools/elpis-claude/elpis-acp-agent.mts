#!/usr/bin/env node
import { createEngineEvents } from './acp-engine-events.mts';
import { bridgeEndpoint, Engine } from './acp-engine-transport.mts';
import type { EngineTurn, Turn, Metadata, ClientMcpServer } from './acp-engine-protocol.mts';
// Elpis as an ACP agent (Agent Client Protocol v1, https://agentclientprotocol.com) over stdio, for any ACP client:
// Elpis's own agent graphs (apps/elpis-desktop/bridge/acp-nodes.mts), editors, or another agent.
//   elpis acp --model gpt-6-luna [--provider openai]          (elpis-wrapper)
//   node elpis-acp-agent.mts --model gpt-6-luna [--provider openai]
// Each ACP session is one Elpis thread on the running shared bridge, or a private app-server when none exists,
// with the session id being
// the thread id, so it stays in Elpis history. Turns stream as session updates; the engine's approval requests become
// session/request_permission (allow once, allow for the session, reject, as `fx acp` offers); session/cancel
// interrupts the turn. Instructions come from session/new `_meta.systemPrompt.append`, the convention
// claude-agent-acp and agy-acp.mts read. Client MCP servers are thread-local configuration overrides.

import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { agent, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import type { ContentBlock, PromptResponse, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
export type Session = { id: string; cwd: string; policy: ReturnType<typeof workflowPolicy>; turn: Turn | null; announced: Set<string>; phases: Map<string, string | null>; streamed: Map<string, string> };

import { redactSecrets } from "./log-redaction.mts";

import { defaultPermissionSettings, permissionSettingsAllowed } from './permission-policy.mts';
import { withoutUserMcp } from "./workflow-agents.mts";

const VERSION = "0.1.0";
const USAGE = "usage: elpis acp [--model MODEL] [--provider PROVIDER]";
let options;
try { options = parseArgs({ options: { model: { type: "string" }, provider: { type: "string" } } }).values; }
catch (error) { process.stderr.write(`${(error as Error).message}\n${USAGE}\n`); process.exit(2); }
const ENGINE = process.env.ELPIS_ENGINE_BIN ?? `${process.env.HOME}/.local/bin/elpis`;
// GPT models run on the OpenAI sign-in unless a provider is named; otherwise the thread would inherit the
// configured default provider (e.g. Claude credits), which cannot serve them.
const provider = options.provider ?? (/^gpt-/.test(options.model ?? "") ? "openai" : undefined);

const sessions = new Map<string, Session>(); // ACP session id = Elpis thread id -> session state
let engine: Engine;
let ready: Promise<void> | null = null;

async function startEngine() {
  engine = new Engine(ENGINE, bridgeEndpoint());
  engine.onMessage = onEngineMessage;
  engine.exited.then((error) => {
    if (engine.stopping) return;
    // Nothing more can run: every running prompt fails, then the agent exits with an error.
    for (const s of sessions.values()) s.turn?.fail(error);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 200);
  });
  await engine.opened;
  return engine.call("initialize", { clientInfo: { name: "elpis-acp", title: "Elpis ACP agent", version: VERSION }, capabilities: { experimentalApi: true } })
    .then(() => engine.notify("initialized", {}));
}
async function engineReady() {
  if (!ready) throw RequestError.invalidRequest(undefined, "Call initialize first");
  await ready;
  if (engine.dead) throw engine.dead;
}

const update = (s: Session, u: SessionUpdate) => connection.client.notify("session/update", { sessionId: s.id, update: u }).catch(() => {});

const { onEngineMessage, interrupt } = createEngineEvents({ sessions, update, getEngine: () => engine, requestPermission: params => connection.client.request<RequestPermissionResponse>("session/request_permission", params) });
// ACP prompt content as the engine's text input. Images and audio are not offered (promptCapabilities).
function promptText(blocks: ContentBlock[]) {
  return (blocks ?? []).map((b) => {
    if (b.type === "text") return b.text;
    if (b.type === "resource_link") return `[${b.name ?? b.uri}](${b.uri})`;
    if (b.type === "resource" && b.resource && typeof b.resource === "object" && "text" in b.resource && typeof b.resource.text === "string") return `${b.resource.uri}:\n${b.resource.text}`;
    return "";
  }).filter(Boolean).join("\n\n");
}

/** Workflows supplies scoped execution policy through ACP metadata; Love Spot keeps its ordinary session policy. */
function workflowPolicy(input: unknown, cwd: string) {
  if (input === undefined) return null;
  const value = input as { kind: string; writeScopes: string[]; reasoningEffort?: string; serviceTier?: string } | null;
  if (!value || !['implement', 'fix', 'verify', 'explore'].includes(value.kind) || !Array.isArray(value.writeScopes)) throw RequestError.invalidParams(undefined, "Invalid workflow policy");
  const writes = ['implement', 'fix'].includes(value.kind);
  // Writers need a folder; a check or an explorer may have one for its report.
  if (writes && !value.writeScopes.length) throw RequestError.invalidParams(undefined, "Invalid workflow write scopes");
  const base = fs.realpathSync(cwd);
  for (const scope of value.writeScopes) {
    if (typeof scope !== 'string' || path.isAbsolute(scope) || scope.split(/[\\/]/).includes('..')) throw RequestError.invalidParams(undefined, "Invalid workflow write scope");
    const root = fs.realpathSync(path.join(base, scope));
    if (root !== base && !root.startsWith(`${base}${path.sep}`) || !fs.statSync(root).isDirectory()) throw RequestError.invalidParams(undefined, "Workflow write scope must be a project folder");
  }
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || !/^[a-z]{2,16}$/.test(value.reasoningEffort))) throw RequestError.invalidParams(undefined, "Invalid workflow reasoning effort");
  if (value.serviceTier !== undefined && (typeof value.serviceTier !== 'string' || !/^[a-z]{2,16}$/.test(value.serviceTier))) throw RequestError.invalidParams(undefined, "Invalid workflow service tier");
  // The task protocol describes what to change; every automatic role uses Full access. Fast is the turn's service tier.
  return { turn: { approvalPolicy: 'never', permissions: ':danger-full-access', ...(value.reasoningEffort ? { effort: value.reasoningEffort } : {}), ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}) } };
}
function mcpConfig(servers: ClientMcpServer[] = []) {
  const config: Record<string, unknown> = Object.create(null);
  for (const server of servers) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(server.name) || Object.hasOwn(config, `mcp_servers.${server.name}`)) {
      throw RequestError.invalidParams(undefined, "MCP server names must be unique and contain only letters, numbers, underscores or hyphens");
    }
    let value;
    if (!server.type || server.type === "stdio") value = { command: server.command, args: server.args ?? [], env: Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])) };
    else if (server.type === "http") value = { url: server.url, http_headers: Object.fromEntries((server.headers ?? []).map(({ name, value }) => [name, value])) };
    else throw RequestError.invalidParams(undefined, `Unsupported MCP transport: ${server.type}`);
    config[`mcp_servers.${server.name}`] = value;
  }
  return config;
}

async function steer(s: Session, prompt: ContentBlock[]) {
  const turn = s.turn;
  if (!turn) return { outcome: "promptRequired", reason: "noRunningTurn" };
  const started = await turn.started;
  turn.id ??= started?.turn?.id ?? null;
  if (s.turn !== turn || turn.cancelled) return { outcome: "promptRequired", reason: "noRunningTurn" };
  await engine.call("turn/steer", { threadId: s.id, expectedTurnId: turn.id, input: [{ type: "text", text: promptText(prompt), text_elements: [] }] });
  return { outcome: "queued", _meta: { delivery: "currentTurn" } };
}

const app = agent({ name: "elpis" })
  .onRequest("initialize", async () => {
    ready ??= startEngine().catch(error => { throw new RequestError(-32603, `Could not connect to the Elpis engine: ${redactSecrets((error as Error).message)}`); });
    await engineReady();
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, mcpCapabilities: { http: true, sse: false }, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
      agentInfo: { name: "elpis", title: "Elpis", version: VERSION },
      authMethods: [],
    };
  })
  .onRequest("session/new", async ({ params }) => {
    await engineReady();
    if (!path.isAbsolute(params.cwd)) throw RequestError.invalidParams(undefined, "cwd must be an absolute path");
    const meta = params._meta as Metadata | null | undefined;
    const append = meta?.systemPrompt?.append;
    const ephemeral = meta?.elpis?.ephemeral === true;
    const policy = workflowPolicy(meta?.elpis?.workflow, params.cwd);
    const config = mcpConfig(params.mcpServers);
    // A Workflows node starts without the person's own MCP servers, as the runner's agents do; servers the client passes stay.
    if (policy) Object.assign(config, await withoutUserMcp(engine, { cwd: params.cwd, mcpServers: (params.mcpServers ?? []).map(server => server.name) }, line => process.stderr.write(`${line}\n`)));
    const access = defaultPermissionSettings(await engine.call('config/read', { includeLayers: true, cwd: params.cwd }), true);
    const requirements = (await engine.call('configRequirements/read', {})).requirements ?? {};
    if (!permissionSettingsAllowed(access, requirements)) throw new RequestError(-32602, 'Managed settings forbid these automatic agent permissions.');
    const started = await engine.call("thread/start", {
      cwd: params.cwd,
      ...(ephemeral ? { ephemeral: true } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(provider ? { modelProvider: provider } : {}),
      ...access,
      elpisPermissionSource: 'automatic',
      ...(Object.keys(config).length ? { config } : {}),
      ...(typeof append === "string" && append.trim() ? { developerInstructions: append } : {}),
    });
    const id = started?.thread?.id;
    if (typeof id !== "string") throw new RequestError(-32603, "The Elpis engine did not start a thread");
    sessions.set(id, { id, cwd: params.cwd, policy, turn: null, announced: new Set(), phases: new Map(), streamed: new Map() });
    const name = meta?.elpis?.name;
    if (!ephemeral && typeof name === "string" && name.trim()) await engine.call("thread/name/set", { threadId: id, name: name.trim().slice(0, 120) }).catch(() => {});
    return { sessionId: id };
  })
  .onRequest("session/prompt", async ({ params }) => {
    await engineReady();
    const s = sessions.get(params.sessionId);
    if (!s) throw RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);
    if (s.turn) {
      const turn = s.turn;
      const delivered = await steer(s, params.prompt);
      if (delivered.outcome !== "queued") throw RequestError.invalidRequest(undefined, "The turn ended before the steer arrived; send a new prompt");
      return turn.result;
    }
    const turn = s.turn = { id: null, cancelled: false, interrupting: false } as Turn;
    const done = new Promise<EngineTurn>((resolve, reject) => { turn.finish = resolve; turn.fail = reject; });
    done.catch(() => {});
    const result = (ended: EngineTurn): PromptResponse => {
      if (ended.status === "failed") throw new RequestError(-32603, ended.error?.message ?? "The Elpis turn failed");
      return { stopReason: turn.cancelled || ended.status === "interrupted" ? "cancelled" : "end_turn" };
    };
    turn.result = done.then(result);
    turn.result.catch(() => {});
    try {
      const access = defaultPermissionSettings(await engine.call('config/read', { includeLayers: true, cwd: s.cwd }), true);
      turn.started = engine.call("turn/start", { threadId: s.id, ...(s.policy?.turn ?? {}), ...access, input: [{ type: "text", text: promptText(params.prompt), text_elements: [] }] });
      const started = await turn.started;
      turn.id ??= started?.turn?.id ?? null;
      if (turn.cancelled) interrupt(s);
      return await turn.result;
    } catch (error) { turn.fail(error); throw error; }
    finally { if (s.turn === turn) s.turn = null; }
  })
  .onRequest("_session/steering", params => params as { sessionId: string; prompt: ContentBlock[] }, async ({ params }) => {
    const s = sessions.get(params.sessionId);
    if (!s) throw RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);
    return steer(s, params.prompt);
  })
  .onNotification("session/cancel", ({ params }) => {
    const s = sessions.get(params.sessionId);
    if (!s?.turn) return;
    s.turn.cancelled = true;
    interrupt(s);
  });

const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
// The client closed the connection (stdin ended): stop the engine and leave.
connection.closed.then(async () => {
  if (engine?.socket && !engine.dead) {
    for (const s of sessions.values()) {
      if (s.turn) { s.turn.cancelled = true; interrupt(s); }
      await engine.call("thread/unsubscribe", { threadId: s.id }).catch(() => {});
    }
  }
  if (engine && !engine.dead) await engine.stop();
  process.exit(process.exitCode ?? 0);
});
