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
