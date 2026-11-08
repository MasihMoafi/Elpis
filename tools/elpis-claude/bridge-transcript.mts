import type { PromptInput,PatchHunk,ToolState,TranscriptItem,TranscriptTurn } from "./bridge-types.mts";
import { wireObject } from "./bridge-wire.mts";

const string = (v: unknown): v is string => typeof v === "string";
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optional = (v: unknown, check: (value: unknown) => boolean) => v === undefined || check(v);
const nullable = (v: unknown, check: (value: unknown) => boolean) => v === null || check(v);
const array = (v: unknown, check: (value: unknown) => boolean) => Array.isArray(v) && v.every(check);
export const isPromptInput = (v: unknown): v is PromptInput => wireObject(v) && string(v.type)
  && optional(v.text, string) && optional(v.path, string) && optional(v.url, string) && optional(v.name, string)
  && optional(v.text_elements, Array.isArray);
export const isTranscriptItem = (v: unknown): v is TranscriptItem => wireObject(v) && string(v.type) && optional(v.id, string)
  && optional(v.status, string) && optional(v.text, string) && optional(v.review, string)
  && optional(v.aggregatedOutput, x => nullable(x, string)) && optional(v.content, x => array(x, v.type === "reasoning" ? string : isPromptInput))
  && optional(v.commandActions, x => array(x, action => wireObject(action) && string(action.type) && optional(action.path, y => nullable(y, string))))
  && optional(v.changes, x => array(x, change => wireObject(change) && string(change.path) && string(change.diff)));
export const isTranscriptTurn = (v: unknown): v is TranscriptTurn => wireObject(v) && optional(v.id, string) && array(v.items, isTranscriptItem)
  && optional(v.startedAt, x => nullable(x, number)) && optional(v.startedAtMs, x => nullable(x, number))
  && optional(v.completedAt, x => nullable(x, number)) && optional(v.status, string)
  && optional(v.claudeMessageId, x => nullable(x, string));

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export async function toAcpPrompt(input: PromptInput[]) {
  const { readFile } = await import("node:fs/promises");
  const out = [];
  for (const c of input) {
    if (c.type === "text") out.push({ type: "text", text: c.text });
    else if (c.type === "localImage" && c.path) {
      const mimeType = MIME[(c.path.split(".").pop() ?? "").toLowerCase()] ?? "image/png";
      try { out.push({ type: "image", data: (await readFile(c.path)).toString("base64"), mimeType }); }
      catch (e) { out.push({ type: "text", text: `[image ${c.path} could not be read: ${(e as Error).message}]` }); }
    } else if (c.type === "image" && typeof c.url === "string") {
      const m = c.url.match(/^data:([^;,]+);base64,(.*)$/s);
      if (m) out.push({ type: "image", data: m[2], mimeType: m[1] });
      else if (/^https?:/.test(c.url)) out.push({ type: "image", uri: c.url });
    } else if (c.type === "mention" && c.path) out.push({ type: "text", text: `[The user referenced ${c.name ?? "a file"}: ${c.path}]` });
    else if (c.type === "skill" && c.path) out.push({ type: "text", text: `[Use the skill "${c.name}" described in ${c.path}]` });
  }
  return out;
}
export const inputSummary = (input: PromptInput[]) => input.map((c) => c.type === "text" ? c.text : c.type === "localImage" ? `[image: ${c.path}]` : c.type === "image" ? "[image]" : c.path ? `[${c.type}: ${c.path}]` : "").filter(Boolean).join("\n");

// Claude's tool calls drawn as Elpis's own items: the real command, clean output,
// reads as reads, edits as diffs.
export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const unfence = (s: string) => /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(s)?.[1] ?? s;
const hunks = (patch: PatchHunk[]) => patch.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}\n`).join("");
const wholeDiff = (a: string, b: string) => { const o = a.split("\n"), n = b.split("\n"); return `@@ -1,${o.length} +1,${n.length} @@\n${[...o.map((l) => `-${l}`), ...n.map((l) => `+${l}`)].join("\n")}\n`; };
// The TUI splits a command into words and quotes each again, so `a && b` showed as `a '&&' b`.
// Anything but plain words goes as `bash -lc '<script>'`, which the TUI shows as the script,
// as it does Elpis's own commands.
const PLAIN_WORDS = /^[\w@%+=:,./-]+( [\w@%+=:,./-]+)*$/;
const shownCommand = (s: string) => (PLAIN_WORDS.test(s) ? s : `bash -lc '${s.replaceAll("'", "'\\''")}'`);
export const plainCommand = (c: string) => (c.startsWith("bash -lc '") && c.endsWith("'") ? c.slice(10, -1).replaceAll("'\\''", "'") : c);
export function toolItem(id: string, t: ToolState, cwd: string): TranscriptItem {
  const r = t.raw, resp = t.response ?? {};
  const status = t.declined ? "declined" : t.status;
  const path = EDIT_TOOLS.has(t.name as string) && (resp.filePath ?? r.file_path ?? r.notebook_path ?? t.diffs.at(-1)?.path);
  if (path) {
    const d = t.diffs.at(-1);
    const change = resp.type === "create" || (!resp.structuredPatch && d && !d.oldText)
      ? { path, kind: { type: "add" }, diff: resp.content ?? r.content ?? d?.newText ?? "" }
      : { path, kind: { type: "update", move_path: null }, diff: resp.structuredPatch?.length ? hunks(resp.structuredPatch) : d ? wholeDiff(d.oldText ?? "", d.newText ?? "") : "" };
    return { type: "fileChange", id, changes: [change], status };
  }
  const command = shownCommand((t.name === "Bash" && r.command) || t.title || t.name || "tool");
  const commandActions = t.name === "Read" && r.file_path ? [{ type: "read", command, name: r.file_path.split("/").pop(), path: r.file_path }]
    : t.name === "Grep" || t.name === "Glob" ? [{ type: "search", command, query: r.pattern ?? null, path: r.path ?? null }]
      : t.name === "LS" ? [{ type: "listFiles", command, path: r.path ?? null }] : [];
  const output = t.name === "Bash" && typeof resp.stdout === "string" ? [resp.stdout, resp.stderr].filter(Boolean).join("\n") : t.text ? unfence(t.text) : null;
  // Bash's own one-line description of the command: the desktop app titles the step by it, as Claude's does.
  const description = t.name === "Bash" && typeof r.description === "string" && r.description.trim() ? { description: r.description.trim() } : {};
  return { type: "commandExecution", id, pluginId: null, scriptPath: null, command, cwd, processId: null, source: "agent", status, commandActions, aggregatedOutput: output, exitCode: status === "completed" ? 0 : status === "inProgress" ? null : 1, durationMs: t.end ? t.end - t.start : null, ...description };
}
// A finished turn as the store keeps it: long outputs and diffs cut.
const cut = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + "\n…" : s);
const clipItem = (it: TranscriptItem) => it.type === "fileChange" ? { ...it, changes: (it as TranscriptItem & { changes: NonNullable<TranscriptItem["changes"]> }).changes.map((c) => ({ ...c, diff: cut(c.diff) })) }
  : it.aggregatedOutput ? { ...it, aggregatedOutput: cut(it.aggregatedOutput) } : it;
export const clipTurn = <T extends { items: TranscriptItem[] }>(turn: T) => ({ ...turn, items: turn.items.map(clipItem) });

// The JSON object in a reply, re-serialized; null when there is none.
export function jsonIn(text: string) {
  const t = unfence(text.trim());
  for (const s of [t, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)]) { try { const v: unknown = JSON.parse(s); if (v && typeof v === "object") return JSON.stringify(v); } catch {} }
  return null;
}
