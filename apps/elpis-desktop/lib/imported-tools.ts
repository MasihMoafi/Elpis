import type { Entry, Item } from "@/lib/api";

/** A Claude Code chat brought in through Settings → Import chats arrives with its tool calls and results written into the
 * replies as tagged text (codex-rs/external-agent-migration/src/sessions/records_common.rs): the model needs them that
 * way to continue. The window shows them as steps, the way jcode keeps an imported chat's tool blocks apart from its text
 * (ext/jcode crates/jcode-base/src/import.rs). 10 Nov, Masih: the imported chats showed "[external_agent_tool_call: Bash]". */
const MARK = "[external_agent_tool_";
const BLOCK =
  /\[external_agent_tool_call: ([^\]\n]+)\]\n?([\s\S]*?)\n?\[\/external_agent_tool_call\]|\[external_agent_tool_result(: error)?\]\n?([\s\S]*?)\n?\[\/external_agent_tool_result\]/g;
const FIELD = /^(description|command|file|input): ?(.*)$/;

type Call = { name: string; description?: string; command?: string; file?: string; input?: string };

function parseCall(name: string, body: string): Call {
  const call: Call = { name: name.trim() };
  let key: keyof Omit<Call, "name"> | null = null;
  for (const line of body.split("\n")) {
    const field = FIELD.exec(line);
    if (field) {
      key = field[1] as keyof Omit<Call, "name">;
      call[key] = field[2] ?? "";
    } else if (key) call[key] += `\n${line}`;
  }
  return call;
}

const base = (file: string) => file.split("/").filter(Boolean).at(-1) ?? file;

function stepOf(id: string, call: Call): Item {
  if (call.command !== undefined && /^(bash|shell|run|exec)/i.test(call.name))
    return {
      id,
      type: "commandExecution",
      command: call.command,
      ...(call.description ? { description: call.description } : {}),
      aggregatedOutput: "",
      status: "completed",
    };
  const what = call.file ? base(call.file) : call.description;
  const args = Object.fromEntries(
    (["description", "file", "command", "input"] as const).flatMap(key => (call[key] ? [[key, call[key]]] : [])),
  );
  return {
    id,
    type: "dynamicToolCall",
    tool: what ? `${call.name} ${what}` : call.name,
    ...(Object.keys(args).length ? { arguments: args } : {}),
    contentItems: [],
    status: "completed",
  };
}

function attach(step: Item, output: string, failed: boolean) {
  if (step.type === "commandExecution") {
    step.aggregatedOutput = output;
    if (failed) step.exitCode = 1;
  } else {
    step.contentItems = output ? [{ type: "inputText", text: output }] : [];
    if (failed) step.error = { message: "The tool reported an error." };
  }
}

/** The entries with each imported reply split into its text and its tool steps; a result joins the oldest call of the
 * same turn still without one (Claude answers calls in order, often in the next message). Other entries pass unchanged. */
export function expandImportedTools(entries: Entry[]): Entry[] {
  if (!entries.some(entry => entry.item.type === "agentMessage" && entry.item.text?.includes(MARK))) return entries;
  const waiting = new Map<string, Item[]>();
  const out: Entry[] = [];
  for (const entry of entries) {
    const body = entry.item.type === "agentMessage" ? entry.item.text : undefined;
    if (!body?.includes(MARK)) {
      out.push(entry);
      continue;
    }
    const queue = waiting.get(entry.turnId) ?? [];
    waiting.set(entry.turnId, queue);
    let part = 0,
      last = 0;
    const push = (item: Item) => out.push({ ...entry, item });
    const said = (text: string) => {
      const trimmed = text.trim();
      if (trimmed) push({ ...entry.item, id: part++ ? `${entry.item.id}:${part}` : entry.item.id, text: trimmed });
    };
    for (const match of body.matchAll(BLOCK)) {
      said(body.slice(last, match.index));
      last = match.index + match[0].length;
      if (match[1] !== undefined) {
        const step = stepOf(`${entry.item.id}:tool${part++}`, parseCall(match[1], match[2] ?? ""));
        queue.push(step);
        push(step);
      } else {
        const output = (match[4] ?? "").trim();
        const step = queue.shift();
        if (step) attach(step, output, Boolean(match[3]));
        else {
          const orphan = stepOf(`${entry.item.id}:tool${part++}`, { name: "Tool result" });
          attach(orphan, output, Boolean(match[3]));
          push(orphan);
        }
      }
    }
    said(body.slice(last));
  }
  return out;
}
