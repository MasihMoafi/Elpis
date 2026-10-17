// The files a reply names, found as Claude's desktop app finds them (its transcript's file refs), so a path in
// what the agent wrote can be clicked: an inline code span that is a path with a folder and an extension, a
// Markdown link to a path, to a file:/// address or to path#L5-L20, and an absolute path in plain text. Each can
// carry :line, :line-endLine or :line:column (the column is dropped). Pure: components/markdown-text.tsx draws them.

/** A file a reply names: its path as written (relative to the chat's folder, or absolute) and the lines it points at. */
export type FileRef = { path: string; line?: number; endLine?: number };

const LETTERS = String.raw`\p{L}\p{N}\p{M}_`;
/** Inline code that is a path: folders joined by "/", then a file name with an extension, then maybe :line, :line-end or :line:column. */
const CODE = new RegExp(String.raw`^([${LETTERS}.()[\]-]*(?:/[${LETTERS}.()[\]-]+)*/[${LETTERS}()[\]-]*\.\w[\w.-]*)(?::(\d+)(?:-(\d+)|:\d+)?)?$`, "u");
/** An absolute path in plain text: at least a folder and a file name with an extension, not the tail of a web address or a longer word. */
const ABSOLUTE = new RegExp(String.raw`(?<![${LETTERS}~/.:])(?:/[${LETTERS}.@+,()[\]-]+)+/[${LETTERS}@+,()[\]-]*\.\w[\w.-]*(?::\d+){0,2}(?![${LETTERS}/])`, "gu");
const SCHEME = /^[a-z][a-z0-9+-]+:(?!\d+(?:[-:]\d+)?$)/i;
const LINE_SUFFIX = /:(\d+)(?:-(\d+)|:\d+)?$/;
const LINE_HASH = /^L(\d+)(?:-L?(\d+))?$/;

/** `{ line, endLine }` from the digits of "12" or "12-20" (a backwards range is turned round; line 0 is no line). */
function lines(first?: string, last?: string): Pick<FileRef, "line" | "endLine"> {
  const line = Number(first);
  if (!first || !Number.isSafeInteger(line) || line < 1) return {};
  const end = Number(last);
  if (!last || !Number.isSafeInteger(end) || end < 1 || end === line) return { line };
  return end < line ? { line: end, endLine: line } : { line, endLine: end };
}

/** The file an inline code span names, or null when the span is not a path. */
export function parseCodeRef(text: string): FileRef | null {
  const match = CODE.exec(text);
  return match ? { path: match[1], ...lines(match[2], match[3]) } : null;
}

/** The file a Markdown link's target names, or null for a web address, a mail address, an anchor or anything else. */
export function parseHref(href: string): FileRef | null {
  const file = href.startsWith("file:///");
  let text = file ? href.slice(7) : href;
  if (!text || (!file && (text.startsWith("#") || text.startsWith("//") || SCHEME.test(text)))) return null;
  const hash = text.indexOf("#"), fragment = hash < 0 ? "" : text.slice(hash + 1);
  text = hash < 0 ? text : text.slice(0, hash);
  if (!text || text.includes("?") || (file && fragment && !LINE_HASH.test(fragment))) return null;
  try { text = decodeURIComponent(text); } catch { if (file) return null; }
  if (/[\x00-\x1f\x7f]/.test(text)) return null;
  const suffix = LINE_SUFFIX.exec(text);
  if (suffix) return { path: text.slice(0, suffix.index), ...lines(suffix[1], suffix[2]) };
  const anchor = LINE_HASH.exec(fragment);
  return { path: text, ...(anchor ? lines(anchor[1], anchor[2]) : {}) };
}

/** A sentence's last mark and any closing bracket it opened nothing for are not part of the path before them. */
function withoutTail(text: string) {
  if (/[.,;:!?]$/.test(text)) text = text.slice(0, -1);
  for (const [open, close] of ["()", "[]"]) {
    let opened = text.split(open).length - 1, closed = text.split(close).length - 1;
    while (closed > opened && text.endsWith(close)) { text = text.slice(0, -1); closed--; }
  }
  return text;
}

/** Plain text cut into the text between and the absolute paths in it (each with the file it names). */
export function findPaths(text: string): (string | { text: string; ref: FileRef })[] {
  const parts: (string | { text: string; ref: FileRef })[] = [];
  let at = 0;
  const say = (value: string) => { if (value) parts.push(typeof parts.at(-1) === "string" ? (parts.pop() as string) + value : value); };
  for (const match of text.matchAll(ABSOLUTE)) {
    const found = withoutTail(match[0]), ref = parseCodeRef(found);
    if (!ref) continue;
    say(text.slice(at, match.index)); parts.push({ text: found, ref });
    at = match.index + found.length;
  }
  say(text.slice(at));
  return parts;
}

/** A ref against the chat's folder: where the file is and whether it lies inside the folder (the Files pane reads only
 * inside it). Outside, or with no folder to resolve against, `rel` is the path itself. */
export function resolveRef(ref: FileRef, cwd: string): { abs: string; rel: string; inside: boolean; line?: number; endLine?: number } {
  const lineOf = { ...(ref.line ? { line: ref.line } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) };
  const root = cwd.replace(/\/+$/, "");
  if (!ref.path.startsWith("/") && !root) return { abs: ref.path, rel: ref.path, inside: false, ...lineOf };
  const parts: string[] = [];
  for (const part of `${ref.path.startsWith("/") ? "" : `${root}/`}${ref.path}`.split("/")) {
    if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part);
  }
  const abs = `/${parts.join("/")}`, inside = !!root && abs.startsWith(`${root}/`);
  return { abs, rel: inside ? abs.slice(root.length + 1) : abs, inside, ...lineOf };
}

type Node = { type: string; value?: string; url?: string; children?: Node[] };
/** A remark plugin: inline code that names a file and absolute paths in plain text become links whose target is the
 * path as written (components/markdown-text.tsx draws every link to a file as one file ref). */
export function linkFilePaths() {
  const walk = (node: Node) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((child): Node[] => {
      if (child.type === "inlineCode" && child.value && parseCodeRef(child.value)) return [{ type: "link", url: child.value, children: [child] }];
      if (child.type === "text" && child.value) {
        return findPaths(child.value).map((part): Node => typeof part === "string" ? { type: "text", value: part } : { type: "link", url: part.text, children: [{ type: "text", value: part.text }] });
      }
      walk(child); return [child];
    });
  };
  return (tree: Node) => walk(tree);
}
