import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import type { McpServer, NewSessionRequest, RequestPermissionResponse, SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { withFileLock } from "./file-lock.mts";
import { redactSecrets } from "./log-redaction.mts";
import { createCreditClient, creditModels, promptContent, streamCreditResponse } from "./openai-credits.mts";
import { CreditTools } from "./openai-credits-tools.mts";

const api = createCreditClient();
const directory = join(process.env.ELPIS_HOME || join(homedir(), ".elpis-next"), "openai-credits");
type History = { version: number; cwd: string; items: ResponseInputItem[] };
type Session = { cwd: string; instructions: string; servers: McpServer[]; model: string; models: string[];
  plan: boolean; ephemeral: boolean; history: History; pending?: AbortController };
const sessions = new Map<string, Session>();
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function readHistory(id: string): Promise<History | null> {
  if (!uuid.test(id)) throw new Error("Invalid credit session ID.");
  try {
    // Earlier sessions stored SDK-only parse metadata alongside output items.
    const saved = JSON.parse(await readFile(join(directory, id + ".json"), "utf8"), (key, value) =>
      key === "parsed" || key === "parsed_arguments" ? undefined : value);
    if (!Number.isSafeInteger(saved.version) || typeof saved.cwd !== "string" || !Array.isArray(saved.items)) throw new Error("Invalid credit session history.");
    return saved;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function saveHistory(id: string, s: Session, items: ResponseInputItem[]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, id + ".json");
  await withFileLock(file, async () => {
    if (((await readHistory(id))?.version ?? 0) !== s.history.version) throw new Error("This credit chat changed in another window. Reopen it before sending again.");
    const next = { version: s.history.version + 1, cwd: s.cwd, items };
    const tmp = file + ".tmp";
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, file);
    s.history = next;
  });
}

function session(id: string) {
  const s = sessions.get(id);
  if (!s) throw RequestError.invalidParams(undefined, "Reopen this credit chat.");
  return s;
}

function config(s: Session): SessionConfigOption[] {
  return [{ type: "select", id: "model", name: "Model", currentValue: s.model, options: s.models.map(value => ({ name: value, value })) }];
}

let inventory: Promise<string[]> | undefined;
async function start(params: Pick<NewSessionRequest, "cwd" | "mcpServers" | "_meta">, id: string, history?: History) {
  inventory ??= creditModels(api).catch(e => { inventory = undefined; throw e; });
  const models = await inventory;
  if (!models.length) throw new Error("The credit organization has no supported GPT models.");
  const extra = params._meta?.systemPrompt;
  const instructions = typeof extra === "string" ? extra : extra && typeof extra === "object" && "append" in extra && typeof extra.append === "string" ? extra.append : "";
  const s: Session = { cwd: params.cwd, servers: params.mcpServers, instructions, model: models[0]!, models, plan: false, ephemeral: params._meta?.ephemeral === true,
    history: history ?? { version: 0, cwd: params.cwd, items: [] } };
  sessions.set(id, s);
  return { sessionId: id, configOptions: config(s) };
}

const notify = (id: string, update: SessionUpdate): Promise<void> => connection.client.notify("session/update", { sessionId: id, update });

const app = agent({ name: "elpis-openai-credits" })
  .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } }, authMethods: [] }))
  .onRequest("session/new", ({ params }) => start(params, randomUUID()))
  .onRequest("session/load", async ({ params }) => {
    const saved = await readHistory(params.sessionId);
    if (!saved || saved.cwd !== params.cwd) throw RequestError.invalidParams(undefined, "Credit history is unavailable for this workspace.");
    return start(params, params.sessionId, saved);
  })
  .onRequest("session/set_config_option", async ({ params }) => {
    const s = session(params.sessionId);
    if (s.pending || params.configId !== "model" || typeof params.value !== "string" || !s.models.includes(params.value)) throw RequestError.invalidParams(undefined, "Unavailable credit model.");
    s.model = params.value;
    return { configOptions: config(s) };
  })
  .onRequest("session/set_mode", async ({ params }) => {
    const s = session(params.sessionId);
    if (s.pending) throw RequestError.invalidRequest(undefined, "Finish or cancel the active turn before changing mode.");
    s.plan = params.modeId === "plan";
    return {};
  })
  .onRequest("session/prompt", async ({ params }) => {
    const id = params.sessionId, s = session(id);
    if (s.pending) throw RequestError.invalidRequest(undefined, "A turn is already running in this credit chat.");
    const content = promptContent(params.prompt);
    const pending = new AbortController();
    const signal = pending.signal;
    s.pending = pending;
    const tools = new CreditTools();
    try {
      if (!s.plan) await tools.connect(s.servers, s.cwd, signal);
      const items: ResponseInputItem[] = [...s.history.items, { role: "user", content }];
      let inputTokens = 0, outputTokens = 0;
      for (;;) {
        const response = await streamCreditResponse(api, { model: s.model, instructions: s.instructions || undefined, stream: true, store: false,
          include: ["reasoning.encrypted_content"], input: items, tools: tools.definitions }, signal,
          text => notify(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }));
        inputTokens += response.usage?.input_tokens ?? 0;
        outputTokens += response.usage?.output_tokens ?? 0;
        for (const item of response.output) {
          if (item.type === "message" || item.type === "reasoning" || item.type === "function_call") items.push(item);
          else throw new Error(`Unexpected output from the OpenAI API: ${item.type}`);
        }
        const calls = response.output.filter(item => item.type === "function_call");
        if (!calls.length) {
          if (!s.ephemeral) await saveHistory(id, s, items);
          return { stopReason: "end_turn", usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
        }
        for (const call of calls) {
          const output = await tools.run(call.name, call.arguments, async (title, rawInput) => {
            const toolCall = { toolCallId: call.call_id, title, kind: "other" as const, rawInput };
            await notify(id, { sessionUpdate: "tool_call", ...toolCall, status: "pending" });
            const decision = await connection.client.request<RequestPermissionResponse>("session/request_permission", {
              sessionId: id, toolCall, options: [{ optionId: "allow", kind: "allow_once", name: "Allow once" }, { optionId: "deny", kind: "reject_once", name: "Decline" }] });
            return decision.outcome.outcome === "selected" && decision.outcome.optionId === "allow";
          }, signal);
          items.push({ type: "function_call_output", call_id: call.call_id, output });
          await notify(id, { sessionUpdate: "tool_call_update", toolCallId: call.call_id, status: "completed" });
        }
      }
    } catch (error) {
      if (signal.aborted) return { stopReason: "cancelled" };
      throw RequestError.internalError(undefined, redactSecrets(error instanceof Error ? error.message : "Credit request failed.").slice(0, 500));
    } finally {
      await tools.close();
      delete s.pending;
    }
  })
  .onNotification("session/cancel", ({ params }) => { sessions.get(params.sessionId)?.pending?.abort(); })
  .onRequest("session/delete", async ({ params }) => {
    // The bridge uses a disposable session for catalog discovery.
    sessions.get(params.sessionId)?.pending?.abort();
    sessions.delete(params.sessionId);
    return {};
  });
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
await connection.closed;
for (const s of sessions.values()) s.pending?.abort();
