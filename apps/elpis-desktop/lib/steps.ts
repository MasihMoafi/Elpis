import type { Item } from "./api";

/** How the chat words and draws one step of agent work, as Claude's desktop app does: a command's script without
 * its shell wrapper, coloured as shell, and the sentence a running or finished step reads as. No dependencies. */

/** The script inside `/bin/bash -lc '…'` (or sh/zsh/dash -c), as Elpis records shell commands; anything else as is. */
export function unwrapShell(command: string): string {
  const match = command.trim().match(/^(?:\S*\/)?(?:bash|sh|zsh|dash)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/);
  if (!match) return command;
  const [, quote, body] = match;
  return quote === "'" ? body.replace(/'\\''|'"'"'/g, "'") : body.replace(/\\(["\\$`])/g, "$1");
}

export type ShellTokenKind = "command" | "flag" | "string" | "variable" | "operator" | "comment" | "text";
export type ShellToken = { kind: ShellTokenKind; text: string };

/** Words after which the next word is still a command (`sudo rm`, `if test`, `xargs rg`). */
const LEADS = new Set(["sudo", "time", "nohup", "exec", "env", "xargs", "command", "builtin", "then", "do", "else", "if", "elif", "while", "until", "!"]);
/** Operators after which a new command starts. */
const STARTS = new Set(["&&", "||", ";;", "|&", "|", "&", ";", "(", "$(", "`"]);
const OPERATOR = /^(?:&&|\|\||;;|\|&|\$\(|\d*(?:>>|&>|>&\d*|<&\d*|<<-|<<|>|<)|[|&;()`])/;
const WORD_END = /[\s|&;()<>`]/;

/** Splits a shell script into commands, flags, strings, variables, operators and comments for colouring.
 * Concatenating the tokens' text gives the script back unchanged. */
export function shellTokens(source: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const push = (kind: ShellTokenKind, text: string) => {
    const last = tokens.at(-1);
    if (last && last.kind === kind && kind !== "operator") last.text += text; else if (text) tokens.push({ kind, text });
  };
  let i = 0, start = true, heredoc: "" | "next" | "word" = "";
  const delimiters: { word: string; tabs: boolean }[] = [];
  let tabs = false;
  while (i < source.length) {
    const char = source[i];
    if (char === "\n") {
      push("text", char); i++; start = true;
      // Heredoc bodies follow the line that opened them, up to their delimiter line; they are text, not commands.
      for (const { word, tabs: strip } of delimiters.splice(0)) {
        let end = i;
        while (end < source.length) {
          const next = source.indexOf("\n", end), stop = next < 0 ? source.length : next + 1;
          const line = source.slice(end, next < 0 ? source.length : next);
          end = stop;
          if ((strip ? line.replace(/^\t+/, "") : line) === word) break;
        }
        push("text", source.slice(i, end)); i = end;
      }
      continue;
    }
    if (/\s/.test(char)) { push("text", char); i++; continue; }
    if (char === "\\" && source[i + 1] === "\n") { push("text", "\\\n"); i += 2; continue; }
    if (char === "#") { const end = source.indexOf("\n", i), stop = end < 0 ? source.length : end; push("comment", source.slice(i, stop)); i = stop; continue; }
    const operator = source.slice(i).match(OPERATOR)?.[0];
    if (operator) {
      push("operator", operator); i += operator.length;
      if (STARTS.has(operator)) start = true;
      if (operator === "<<" || operator === "<<-") { heredoc = "next"; tabs = operator === "<<-"; }
      continue;
    }
    // A word: plain characters, quoted strings and variables, up to a space or an operator.
    const parts: [ShellTokenKind | "plain", string][] = [];
    let j = i;
    while (j < source.length && !WORD_END.test(source[j])) {
      const c = source[j];
      if (c === "'" || (c === "$" && source[j + 1] === "'")) {
        const open = c === "$" ? j + 1 : j, end = source.indexOf("'", open + 1), stop = end < 0 ? source.length : end + 1;
        parts.push(["string", source.slice(j, stop)]); j = stop; continue;
      }
      if (c === '"') {
        let k = j + 1;
        while (k < source.length && source[k] !== '"') k += source[k] === "\\" ? 2 : 1;
        const stop = Math.min(k + 1, source.length);
        parts.push(["string", source.slice(j, stop)]); j = stop; continue;
      }
      if (c === "$") {
        if (source[j + 1] === "(") break;
        const variable = source.slice(j).match(/^\$(?:\{[^}\n]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/)?.[0];
        if (variable) { parts.push(["variable", variable]); j += variable.length; continue; }
      }
      const step = c === "\\" ? 2 : 1;
      parts.push(["plain", source.slice(j, j + step)]); j += step;
    }
    const word = source.slice(i, j);
    let plain: ShellTokenKind = "text";
    if (heredoc === "next") { heredoc = ""; delimiters.push({ word: word.replace(/['"\\]/g, ""), tabs }); }
    else if (start && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) plain = "text"; // FOO=1 cmd: the command follows
    else if (word.startsWith("-")) plain = "flag";
    else if (start) { plain = "command"; start = LEADS.has(word); }
    for (const [kind, text] of parts) push(kind === "plain" ? plain : kind, text);
    if (!word) { push("text", char); j = i + 1; } // unreachable guard: never loop on an empty word
    i = j;
  }
  return tokens;
}

type Action = { type?: unknown; name?: unknown; path?: unknown; query?: unknown };
const actionsOf = (item: Item): Action[] => Array.isArray(item.commandActions) ? item.commandActions.filter((action): action is Action => !!action && typeof action === "object") : [];
const baseName = (path: unknown) => typeof path === "string" ? path.split(/[\\/]/).filter(Boolean).at(-1) ?? "" : "";
const firstText = (values: unknown[]) => values.find((value): value is string => typeof value === "string" && !!value.trim());

/** What a command did when Elpis parsed it as only reading, only searching or only listing files; otherwise null. */
export function exploration(item: Item): "read" | "search" | "listFiles" | null {
  if (item.type !== "commandExecution") return null;
  const types = new Set(actionsOf(item).map(action => action.type));
  const [type] = types;
  return types.size === 1 && (type === "read" || type === "search" || type === "listFiles") ? type : null;
}
/** The files a reading command read, by name. */
export function readNames(item: Item): string[] {
  return [...new Set(actionsOf(item).filter(action => action.type === "read").map(action => (typeof action.name === "string" && action.name) || baseName(action.path)).filter(Boolean))];
}
/** "app.ts", "app.ts and api.ts", "3 files". */
export const fileList = (names: string[]) => !names.length ? "a file" : names.length <= 2 ? names.join(" and ") : `${names.length} files`;

/** The line a person recognises a command by: its script's first line, without a leading `cd … &&`, shortened. */
export function commandGist(command: string): string {
  const line = unwrapShell(command).split("\n").find(value => value.trim()) ?? "";
  const gist = line.replace(/^\s*cd\s+\S+\s*&&\s*/, "").replace(/\s+/g, " ").trim();
  return gist.length > 80 ? `${gist.slice(0, 79)}…` : gist;
}

/** The sentence the model gave a command ("Stopping local site and moving worktree"), first line only: Claude's Bash
 * steps are titled by it, running and done alike, and fall back to the command when there is none. Elpis's engine
 * records none; the Claude bridge passes Bash's `description` on. */
export function describedAs(item: Item): string | undefined {
  if (item.type !== "commandExecution") return undefined;
  const line = firstText([item.description, item.title])?.split("\n").map(value => value.replace(/\s+/g, " ").trim()).find(Boolean);
  return line || undefined;
}

type FileKind = "add" | "update" | "delete";
type Change = { path: string | null; kind: FileKind };
/** The files a fileChange item touched, each with what was done to it; an item without a readable list is one edit. */
function changesOf(item: Item): Change[] {
  const list = Array.isArray(item.changes) ? item.changes : [];
  const changes = list.flatMap((change): Change[] => {
    const { path, kind } = (change ?? {}) as { path?: unknown; kind?: { type?: unknown } };
    return typeof path === "string" ? [{ path, kind: kind?.type === "add" || kind?.type === "delete" ? kind.type : "update" }] : [];
  });
  return changes.length ? changes : [{ path: null, kind: "update" }];
}
/** Relative and absolute paths of one file are the same file: one ends with the other, from a folder boundary. */
const normal = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");
const sameFile = (a: string, b: string) => { const x = normal(a), y = normal(b); return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`); };
/** How many different files the references name; a reference with no path (`null`) is a file of its own. */
function distinctFiles(paths: (string | null)[]): string[] {
  const files: string[] = [];
  for (const path of paths) if (path === null || !files.some(file => file && sameFile(file, path))) files.push(path ?? "");
  return files;
}
const fileWord = (n: number, name?: string) => name ?? (n === 1 ? "a file" : `${n} files`);

/** One step as a sentence: "Running npm test", "Read app.ts", "Searched for TODO"; `running` words it as now. A command
 * the model described reads as its own sentence, as Claude's does. */
export function stepLabel(item: Item, running = item.status === "inProgress"): string {
  const say = (now: string, done: string, rest = "") => `${running ? now : done}${rest ? ` ${rest}` : ""}`;
  if (item.type === "commandExecution") {
    const said = describedAs(item);
    if (said) return said;
    const kind = exploration(item), actions = actionsOf(item);
    if (kind === "read") return say("Reading", "Read", fileList(readNames(item)));
    if (kind === "search") { const query = firstText(actions.map(action => action.query)); return say("Searching", "Searched", query ? `for ${query}` : "the files"); }
    if (kind === "listFiles") { const path = firstText(actions.map(action => action.path)); return say("Listing files", "Listed files", path ? `in ${path}` : ""); }
    return say("Running", "Ran", commandGist(String(item.command ?? "")));
  }
  if (item.type === "mcpToolCall") return say("Using", "Used", `${String(item.server ?? "")} ${String(item.tool ?? "")}`.trim());
  if (item.type === "fileChange") {
    const changes = changesOf(item), kinds = new Set(changes.map(change => change.kind)), [kind] = kinds;
    const files = distinctFiles(changes.map(change => change.path)), name = files.length === 1 && files[0] ? baseName(files[0]) : undefined;
    const [now, done] = kinds.size === 1 && kind === "add" ? ["Creating", "Created"] : kinds.size === 1 && kind === "delete" ? ["Deleting", "Deleted"] : ["Editing", "Edited"];
    return say(now, done, fileWord(files.length, name));
  }
  if (item.type === "webSearch") return say("Searching", "Searched", String(item.query ?? "the web"));
  return say("Working", "Worked");
}

/** A step that failed: so reported, or a command that exited with an error. */
export const stepFailed = (item: Item) => item.status === "failed" || (item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0);

/** A running step's elapsed time as Claude's row reads it (Intl narrow units): "39s", "1m 2s", "1h 2m 3s". */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000)), seconds = total % 60, minutes = Math.floor(total / 60) % 60, hours = Math.floor(total / 3600);
  return hours ? `${hours}h ${minutes}m ${seconds}s` : total >= 60 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** How long a finished step took, as its row says it: nothing under a tenth of a second (a 30 ms command is not "0.0s"),
 * then "0.8s" and "9.0s", then "12s" and "1m 2s" like the running timer. */
export function stepDuration(ms: unknown): string {
  if (typeof ms !== "number" || ms < 100) return "";
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : elapsed(ms);
}

/** One phrase of a group's summary ("ran 2 commands") and how many of its steps failed. */
export type SummaryPart = { text: string; failed: number };
const countWord = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));
const andList = (values: string[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(values);
const FILE_VERBS: Record<FileKind, string> = { add: "created", update: "edited", delete: "deleted" };

/** What a run of steps did, as Claude's desktop app words a finished group: one "verb + what" phrase per kind of work, in
 * the order the work began, counting the files and commands; one file read and then edited is one phrase that names
 * it ("Edited and read app.ts"); a failure is counted on its own phrase; a lone step the model described is that
 * sentence. Elpis keeps the MCP server's name where Claude says "used a tool". */
export function summaryParts(items: Item[]): SummaryPart[] {
  const said = items.length === 1 ? describedAs(items[0]) : undefined;
  if (said) return [{ text: said, failed: stepFailed(items[0]) ? 1 : 0 }];
  type FileOp = { verb: string; path: string | null; failed: boolean };
  const order: string[] = [], members = new Map<string, Item[]>(), fileOps: FileOp[] = [];
  const note = (key: string, item: Item) => { if (!members.has(key)) { members.set(key, []); order.push(key); } members.get(key)!.push(item); };
  for (const item of items) {
    const kind = exploration(item), failed = stepFailed(item);
    if (kind === "read") {
      const paths = actionsOf(item).filter(action => action.type === "read").map(action => firstText([action.path, action.name]) ?? null);
      for (const path of paths.length ? paths : [null]) { note("file:read", item); fileOps.push({ verb: "read", path, failed }); }
    } else if (kind === "search") note("search", item);
    else if (kind === "listFiles") note("listFiles", item);
    else if (item.type === "commandExecution") note("commands", item);
    else if (item.type === "fileChange") for (const change of changesOf(item)) { note(`file:${FILE_VERBS[change.kind]}`, item); fileOps.push({ verb: FILE_VERBS[change.kind], path: change.path, failed }); }
    else if (item.type === "mcpToolCall") note("mcp", item);
    else if (item.type === "dynamicToolCall" || item.type === "functionCallOutput") note("tools", item);
    else if (item.type === "webSearch") note("web", item);
    else if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") note("agents", item);
    else if (item.type === "contextCompaction") note("compaction", item);
    else if (item.type === "imageView") note("images", item);
  }
  const fileVerbs = order.filter(key => key.startsWith("file:")).map(key => key.slice(5));
  const named = fileOps.every(op => op.path !== null) && distinctFiles(fileOps.map(op => op.path)).length === 1;
  const keys = named ? order.filter((key, index) => !key.startsWith("file:") || index === order.findIndex(other => other.startsWith("file:"))).map(key => key.startsWith("file:") ? "files" : key) : order;
  const failures = (list: Item[]) => list.filter(stepFailed).length;
  const parts = keys.map((key): SummaryPart => {
    const list = members.get(key) ?? [], failed = failures(list);
    if (key === "files") return { text: `${andList(fileVerbs)} ${baseName(fileOps[0].path)}`, failed: fileVerbs.filter(verb => fileOps.some(op => op.verb === verb && op.failed)).length };
    if (key.startsWith("file:")) {
      const ops = fileOps.filter(op => op.verb === key.slice(5));
      return { text: `${key.slice(5)} ${fileWord(distinctFiles(ops.map(op => op.path)).length)}`, failed: distinctFiles(ops.filter(op => op.failed).map(op => op.path)).filter(Boolean).length };
    }
    switch (key) {
      case "commands": return { text: countWord(list.length, "ran a command", "ran # commands"), failed };
      case "search": return { text: "searched code", failed };
      case "listFiles": return { text: "listed files", failed };
      case "mcp": return { text: `used ${andList([...new Set(list.map(item => String(item.server || "a tool")))])}`, failed };
      case "tools": return { text: countWord(list.length, "used a tool", "used # tools"), failed };
      case "web": return { text: "browsed the web", failed };
      case "agents": return { text: countWord(list.length, "worked with an agent", "worked with agents"), failed };
      case "compaction": return { text: "compacted the context", failed };
      default: return { text: countWord(list.length, "viewed an image", "viewed # images"), failed };
    }
  });
  if (!parts.length) parts.push({ text: items.some(item => item.type === "reasoning") ? "thought" : `${items.length} steps`, failed: 0 });
  parts[0] = { ...parts[0], text: parts[0].text[0].toUpperCase() + parts[0].text.slice(1) };
  return parts;
}

/** "Ran 3 commands, edited 2 files (1 failed)": the group's parts as one line. */
export const summarize = (items: Item[]) => summaryParts(items).map(part => part.failed > 0 ? `${part.text} (${part.failed} failed)` : part.text).join(", ");
