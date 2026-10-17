/** One displayed line of a unified diff: added, removed, unchanged ("ctx"), a hunk header, or Git's "\ No newline" note.
 * `oldNo` and `newNo` are its line numbers in the old and the new file (null where the line is not in that file). */
export type DiffLine = { kind: "hunk" | "add" | "del" | "ctx" | "note"; text: string; oldNo: number | null; newNo: number | null };

/** Reads Git's unified diff of one file. The header (`diff --git`, `index`, `---`, `+++`) is dropped; inside a hunk
 * every line is judged by its first character alone, so a removed line that reads `--- x` stays a removed line. */
export function parseDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0, newNo = 0, inHunk = false;
  for (const raw of text.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); inHunk = true; lines.push({ kind: "hunk", text: raw, oldNo: null, newNo: null }); continue; }
    if (!inHunk || raw === "") continue;
    if (raw[0] === "+") lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    else if (raw[0] === "-") lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    else if (raw[0] === "\\") lines.push({ kind: "note", text: raw, oldNo: null, newNo: null });
    else lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return lines;
}

/** What a change did to its file: the three kinds the engine reports. */
export type FileKind = "add" | "update" | "delete";

/** The lines a file change shows. An update's `diff` is Git's unified diff (with "Moved to: …" after it when the file was
 * renamed); a created or deleted file's `diff` is the file's whole text, so every line of it is added or removed. A
 * diff with no hunk header at all is read as one hunk. */
export function changeLines(kind: FileKind, diff: string): DiffLine[] {
  if (kind !== "update") {
    const rows = diff.split("\n");
    if (rows.at(-1) === "") rows.pop();
    return rows.map((text, index): DiffLine => kind === "add" ? { kind: "add", text, oldNo: null, newNo: index + 1 } : { kind: "del", text, oldNo: index + 1, newNo: null });
  }
  const moved = /\n*Moved to: (.*)\s*$/.exec(diff), body = moved ? diff.slice(0, moved.index) : diff;
  const lines = /^@@ /m.test(body) ? parseDiff(body) : parseDiff(`@@ -1 +1 @@\n${body}`).slice(1);
  return moved ? [...lines, { kind: "note", text: `Moved to ${moved[1]}`, oldNo: null, newNo: null }] : lines;
}

/** The lines a change adds and removes: the "+N −M" of its row. */
export function lineCounts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of lines) if (line.kind === "add") added++; else if (line.kind === "del") removed++;
  return { added, removed };
}

/** One file touched by an agent: what was done, the lines to show for it and their counts. */
export type FileEdit = { path: string; kind: FileKind; status: string; lines: DiffLine[]; added: number; removed: number };
const textOf = (value: unknown) => typeof value === "string" ? value : "";

/** The files a fileChange item touched, one row each. */
export function fileEdits(item: Record<string, unknown>): FileEdit[] {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.flatMap((change): FileEdit[] => {
    const { path, kind, diff } = (change ?? {}) as { path?: unknown; kind?: { type?: unknown }; diff?: unknown };
    if (typeof path !== "string") return [];
    const type: FileKind = kind?.type === "add" || kind?.type === "delete" ? kind.type : "update";
    const lines = changeLines(type, textOf(diff));
    return [{ path, kind: type, status: textOf(item.status), lines, ...lineCounts(lines) }];
  });
}

/** What a turn did to files: the completed edits of its items, a file edited more than once as one file with the sums
 * (as Claude's "Edited 3 files" does), in the order the files were first touched. A failed or declined edit is no edit. */
export function turnEdits(items: Record<string, unknown>[]): { files: FileEdit[]; added: number; removed: number } {
  const files = new Map<string, FileEdit>();
  for (const item of items) {
    if (item.type !== "fileChange" || item.status !== "completed") continue;
    for (const edit of fileEdits(item)) {
      const key = edit.path.replace(/\\/g, "/"), known = files.get(key);
      if (!known) files.set(key, edit);
      else files.set(key, { ...known, kind: known.kind === "add" && edit.kind === "update" ? "add" : edit.kind, lines: [...known.lines, ...edit.lines], added: known.added + edit.added, removed: known.removed + edit.removed });
    }
  }
  const all = [...files.values()];
  return { files: all, added: all.reduce((sum, file) => sum + file.added, 0), removed: all.reduce((sum, file) => sum + file.removed, 0) };
}

/** A path as a row says it: the file's name, and the folders above it as a hint (the last two, "…/" when more lie
 * above them) so that an absolute path never reads as a long grey string. */
export function shortPath(path: string): { name: string; hint: string } {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean), name = parts.pop() ?? path, folders = parts.filter(part => !/^[A-Za-z]:$/.test(part));
  const near = folders.slice(-2).join("/");
  return { name, hint: near && (folders.length > 2 || /^(?:\/|[A-Za-z]:)/.test(path) ? `…/${near}` : near) };
}
