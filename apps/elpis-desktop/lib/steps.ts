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

/** One step as a sentence: "Running npm test", "Read app.ts", "Searched for TODO"; `running` words it as now. */
export function stepLabel(item: Item, running = item.status === "inProgress"): string {
  const say = (now: string, done: string, rest = "") => `${running ? now : done}${rest ? ` ${rest}` : ""}`;
  if (item.type === "commandExecution") {
    const kind = exploration(item), actions = actionsOf(item);
    if (kind === "read") return say("Reading", "Read", fileList(readNames(item)));
    if (kind === "search") { const query = firstText(actions.map(action => action.query)); return say("Searching", "Searched", query ? `for ${query}` : "the files"); }
    if (kind === "listFiles") { const path = firstText(actions.map(action => action.path)); return say("Listing files", "Listed files", path ? `in ${path}` : ""); }
    return say("Running", "Ran", commandGist(String(item.command ?? "")));
  }
  if (item.type === "mcpToolCall") return say("Using", "Used", `${String(item.server ?? "")} ${String(item.tool ?? "")}`.trim());
  if (item.type === "fileChange") return say("Editing files", "Edited files");
  if (item.type === "webSearch") return say("Searching", "Searched", String(item.query ?? "the web"));
  return say("Working", "Worked");
}

/** A step that failed: so reported, or a command that exited with an error. */
export const stepFailed = (item: Item) => item.status === "failed" || (item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0);

/** A running step's elapsed time: "39s", then "1:02", then "1:02:09". */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000)), seconds = total % 60, minutes = Math.floor(total / 60) % 60, hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : total >= 60 ? `${minutes}:${pad(seconds)}` : `${seconds}s`;
}
