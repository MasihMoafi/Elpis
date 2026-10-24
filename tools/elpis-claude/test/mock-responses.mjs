// A local stand-in for the OpenAI Responses API, for real-engine tests without credentials or inference.
// It answers concurrent requests, deterministically by prompt, with structured output when the engine asks for it.
//   node mock-responses.mjs <port> <dir>   (<dir>/scripts.json: { tag: { script, args } }; requests go to <dir>/requests.jsonl)
// What it does, by the last user message:
//   "... WF:<tag> ..."               calls the chat's workflow tool with scripts[tag] (whether or not the person asked)
//   "<workflow-notification> ..."     answers "NOTICE RECEIVED <run-id> <status>: <result JSON>"
//   a workflow agent's prompt         "ANSWER(<prompt>)", or a JSON object built from the schema; markers in the prompt:
//       SLOWONCE:<ms>  waits that long the first time it sees that prompt;  FAILALWAYS  answers HTTP 500
//   after a tool call                 "TOOL SAID: <the tool's output>"
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";

const [port, dir] = [Number(process.argv[2]), process.argv[3]];
const scripts = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "scripts.json"), "utf8")); } catch { return {}; } };
const record = (entry) => fs.appendFileSync(path.join(dir, "requests.jsonl"), `${JSON.stringify(entry)}\n`);
const seen = new Map();
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

const textOf = (item) => (Array.isArray(item?.content) ? item.content.map((c) => c?.text ?? "").join("") : typeof item?.content === "string" ? item.content : "");
// Built from the schema so the same prompt always gives the same object.
export function answerFor(schema, prompt, name = "") {
  const t = Array.isArray(schema?.type) ? schema.type.find((x) => x !== "null") : schema?.type;
  if (schema?.anyOf) return answerFor(schema.anyOf.find((s) => s.type !== "null") ?? schema.anyOf[0], prompt, name);
  if (t === "object") return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, s]) => [k, answerFor(s, prompt, k)]));
  if (t === "array") return [answerFor(schema.items ?? { type: "string" }, prompt, name)];
  if (t === "integer" || t === "number") return prompt.length % 97;
  if (t === "boolean") return true;
  if (schema?.enum) return schema.enum[0];
  return `${name}:${prompt.split("\n\n").at(-1).slice(0, 40)}`;
}

function reply(res, k, items) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("response.created", { response: { id: `resp_${k}` } });
  for (const item of items) ev("response.output_item.done", { item });
  ev("response.completed", { response: { id: `resp_${k}`, usage: { input_tokens: 100, input_tokens_details: null, output_tokens: 10, output_tokens_details: null, total_tokens: 110 } } });
  res.end();
}
const message = (k, text) => ({ type: "message", role: "assistant", id: `msg_${k}`, content: [{ type: "output_text", text }] });

let count = 0;
http.createServer((req, res) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "mock-model", object: "model" }], models: [] })); return; }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const k = ++count;
    let r = {};
    try { r = JSON.parse(body || "{}"); } catch {}
    if (req.url.endsWith("/compact")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "mock" }] })); return; }
    const input = Array.isArray(r.input) ? r.input : [];
    const last = input.at(-1);
    const users = input.filter((i) => i?.role === "user");
    const prompt = textOf(users.at(-1));
    const tools = (r.tools ?? []).flatMap((t) => (t.type === "namespace" ? (t.tools ?? []).map((x) => ({ ...x, ns: t.name })) : [t]));
    const workflowTool = tools.find((t) => /workflow$/.test(t.name ?? ""));
    const schema = r.text?.format?.type === "json_schema" ? r.text.format.schema : null;
    const agent = /You are an agent in the workflow/.test(prompt);
    const entry = { k, at: Date.now(), kind: "chat", prompt: prompt.split("\n\n").at(-1).slice(0, 200), tools: tools.map((t) => (t.ns ? `${t.ns}.${t.name}` : t.name)).filter(Boolean).slice(0, 80), schema: Boolean(schema) };
    if (last?.type === "function_call_output") {
      record({ ...entry, kind: "tool-output", output: String(last.output?.content ?? last.output ?? "").slice(0, 2000) });
      reply(res, k, [message(k, `TOOL SAID: ${typeof last.output === "string" ? last.output : JSON.stringify(last.output)}`)]);
      return;
    }
    if (prompt.trimStart().startsWith("<workflow-notification>")) {
      const id = /<run-id>(.*?)<\/run-id>/.exec(prompt)?.[1], status = /<status>(.*?)<\/status>/.exec(prompt)?.[1];
      const result = /<result>\n([\s\S]*?)\n<\/result>/.exec(prompt)?.[1] ?? "null";
      record({ ...entry, kind: "notice", runId: id, status });
      reply(res, k, [message(k, `NOTICE RECEIVED ${id} ${status}: ${JSON.stringify(JSON.parse(result))}`)]);
      return;
    }
    const tag = /\bWF:([\w-]+)/.exec(prompt)?.[1];
    if (tag && !agent) {
      const wf = scripts()[tag];
      record({ ...entry, kind: "launch", tag, tool: workflowTool ? (workflowTool.ns ? `${workflowTool.ns}.${workflowTool.name}` : workflowTool.name) : null });
      if (!workflowTool || !wf) { reply(res, k, [message(k, `NO WORKFLOW TOOL (${entry.tools.join(", ")})`)]); return; }
      const call = { type: "function_call", id: `fc_${k}`, call_id: `call_${k}`, name: workflowTool.name, arguments: JSON.stringify({ script: wf.script, ...(wf.args !== undefined && { args: wf.args }) }) };
      if (workflowTool.ns) call.namespace = workflowTool.ns;
      reply(res, k, [call]);
      return;
    }
    const key = entry.prompt;
    const times = (seen.get(key) ?? 0) + 1;
    seen.set(key, times);
    record({ ...entry, kind: agent ? "agent" : "chat", times });
    if (agent && /FAILALWAYS/.test(prompt)) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "mock failure", type: "server_error" } })); return; }
    const slow = /SLOWONCE:(\d+)/.exec(prompt);
    if (agent && slow && times === 1) await new Promise((r) => setTimeout(r, Number(slow[1])));
    const text = schema ? JSON.stringify(answerFor(schema, entry.prompt)) : agent ? `ANSWER(${entry.prompt})` : `reply ${hash(prompt)}`;
    reply(res, k, [message(k, text)]);
  });
}).listen(port, "127.0.0.1", () => process.stdout.write(`listening ${port}\n`));
