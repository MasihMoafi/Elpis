"use client";

import type { ReactNode } from "react";
import { BranchIcon, BrowserIcon, ContextIcon, FileEditIcon, TerminalIcon, ToolIcon } from "@/components/elpis-icons";
import type { Entry, Item } from "@/lib/api";

/** The conversation as the ChatGPT app shows it: each user message, then the turn's work
 * collapsed into short activity lines, and once a turn ends everything before its final reply
 * folds into "Worked for …". `renderItem` draws one message or activity in full. */
export function Transcript({ entries, activeTurnId, renderItem }: { entries: Entry[]; activeTurnId: string | null; renderItem: (entry: Entry) => ReactNode }) {
  return <>{turnsOf(entries).map(turn => <Turn key={turn.id} turn={turn} active={turn.id === activeTurnId} renderItem={renderItem} />)}</>;
}

type TurnEntries = { id: string; entries: Entry[] };

function turnsOf(entries: Entry[]): TurnEntries[] {
  const turns: TurnEntries[] = [];
  for (const entry of entries) {
    const last = turns.at(-1);
    if (last && last.id === entry.turnId) last.entries.push(entry);
    else turns.push({ id: entry.turnId, entries: [entry] });
  }
  return turns;
}

function Turn({ turn, active, renderItem }: { turn: TurnEntries; active: boolean; renderItem: (entry: Entry) => ReactNode }) {
  const users = turn.entries.filter(entry => entry.item.type === "userMessage");
  const work = turn.entries.filter(entry => entry.item.type !== "userMessage");
  // A proposed plan is the turn's answer as much as its last reply, so neither folds away.
  const lastReply = findLastIndex(work, entry => entry.item.type === "agentMessage"), plan = work.findIndex(entry => entry.item.type === "plan");
  const finalReply = active ? -1 : plan >= 0 && (lastReply < 0 || plan < lastReply) ? plan : lastReply;
  const folded = finalReply > 0 ? work.slice(0, finalReply) : [];
  const visible = finalReply > 0 ? work.slice(finalReply) : work;
  return <section className="turn" aria-label="Turn">
    {users.map(renderItem)}
    {folded.length > 0 && <details className="worked-for">
      <summary><span>{workedFor(turn.entries)}</span></summary>
      <div className="worked-for-body"><Flow entries={folded} renderItem={renderItem} /></div>
    </details>}
    <Flow entries={visible} renderItem={renderItem} live={active} />
    {active && <div className="turn-working" role="status"><i aria-hidden="true" />Working</div>}
  </section>;
}

/** Replies stay as they are; each run of tool activity between them becomes one line. */
function Flow({ entries, renderItem, live = false }: { entries: Entry[]; renderItem: (entry: Entry) => ReactNode; live?: boolean }) {
  const blocks: ReactNode[] = [];
  let run: Entry[] = [];
  const flush = () => {
    if (run.length) blocks.push(<ActivityGroup key={`group-${run[0].item.id}`} entries={run} renderItem={renderItem} live={live} />);
    run = [];
  };
  for (const entry of entries) {
    if (entry.item.type === "agentMessage" || entry.item.type === "plan") {
      flush();
      blocks.push(<div key={entry.item.id}>{renderItem(entry)}</div>);
    } else run.push(entry);
  }
  flush();
  return <>{blocks}</>;
}

function ActivityGroup({ entries, renderItem, live }: { entries: Entry[]; renderItem: (entry: Entry) => ReactNode; live: boolean }) {
  const items = entries.map(entry => entry.item);
  const running = live ? items.find(item => item.status === "inProgress") : undefined;
  const failed = items.filter(item => item.status === "failed").length;
  const Icon = iconFor(items);
  return <details className="activity-group">
    <summary>
      <Icon size={14} aria-hidden="true" />
      <span className={running ? "activity-group-live" : undefined}>{running ? runningLabel(running) : summarize(items)}</span>
      {failed > 0 && <span className="activity-group-failed">{failed} failed</span>}
    </summary>
    <div className="activity-group-body">{entries.map(entry => <div key={entry.item.id}>{renderItem(entry)}</div>)}</div>
  </details>;
}

const count = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));

/** "Ran 3 commands, edited 2 files, used rag", in the order the work happened. */
export function summarize(items: Item[]): string {
  const phrases = new Map<string, string>();
  const commands = items.filter(item => item.type === "commandExecution").length;
  const files = items.filter(item => item.type === "fileChange").reduce((sum, item) => sum + (Array.isArray(item.changes) ? item.changes.length : 1), 0);
  const servers = [...new Set(items.filter(item => item.type === "mcpToolCall").map(item => String(item.server || "a tool")))];
  const tools = items.filter(item => item.type === "dynamicToolCall" || item.type === "functionCallOutput").length;
  const searches = items.filter(item => item.type === "webSearch").length;
  const agents = items.filter(item => item.type === "collabAgentToolCall" || item.type === "subAgentActivity").length;
  for (const item of items) {
    if (item.type === "commandExecution") phrases.set("commands", count(commands, "ran a command", "ran # commands"));
    else if (item.type === "fileChange") phrases.set("files", count(files, "edited a file", "edited # files"));
    else if (item.type === "mcpToolCall") phrases.set("mcp", `used ${servers.join(" and ")}`);
    else if (item.type === "dynamicToolCall" || item.type === "functionCallOutput") phrases.set("tools", count(tools, "used a tool", "used # tools"));
    else if (item.type === "webSearch") phrases.set("search", count(searches, "searched the web", "searched the web # times"));
    else if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") phrases.set("agents", count(agents, "worked with an agent", "worked with agents"));
    else if (item.type === "contextCompaction") phrases.set("compaction", "compacted the context");
  }
  const text = [...phrases.values()].join(", ") || (items.some(item => item.type === "reasoning") ? "thought" : `${items.length} steps`);
  return text[0].toUpperCase() + text.slice(1);
}

function runningLabel(item: Item): string {
  if (item.type === "commandExecution") return `Running ${String(item.command ?? "").split("\n")[0]}`;
  if (item.type === "mcpToolCall") return `Using ${String(item.server ?? "")} ${String(item.tool ?? "")}`.trim();
  if (item.type === "fileChange") return "Editing files";
  if (item.type === "webSearch") return `Searching ${String(item.query ?? "the web")}`;
  return "Working";
}

function iconFor(items: Item[]) {
  const types = new Set(items.map(item => item.type));
  if (types.has("commandExecution")) return TerminalIcon;
  if (types.has("fileChange")) return FileEditIcon;
  if (types.has("webSearch")) return BrowserIcon;
  if (types.has("collabAgentToolCall") || types.has("subAgentActivity")) return BranchIcon;
  if (types.has("mcpToolCall") || types.has("dynamicToolCall")) return ToolIcon;
  return ContextIcon;
}

/** "Worked for 14m 42s": from the user's message to the last recorded item. */
export function workedFor(entries: Entry[]): string {
  const starts = entries.map(entry => entry.startedAtMs).filter((value): value is number => typeof value === "number");
  const ends = entries.map(entry => entry.completedAtMs ?? entry.startedAtMs).filter((value): value is number => typeof value === "number");
  if (!starts.length || !ends.length) return "Worked";
  const seconds = Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000));
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  const label = hours ? `${hours}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  return `Worked for ${label}`;
}

function findLastIndex<T>(values: T[], test: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) if (test(values[index])) return index;
  return -1;
}
