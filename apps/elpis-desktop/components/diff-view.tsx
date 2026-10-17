import { FileRefLink } from "@/components/file-ref";
import type { DiffLine } from "@/lib/diff";
import "@/components/diff-view.css";

/** More lines than this stay out of the page; the file's own diff is still whole in Git. */
export const DIFF_LINE_LIMIT = 4000;

/** One +/- pair: the lines a file adds and removes, in the colours of the diff. Rows, footers and the Changes tab all draw it. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  return <span className="change-counts"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>;
}

/** A diff's lines, numbered and coloured. The Changes tab and an edit row in the chat both draw their lines with this,
 * so the two read the same. Wrap it in `.diff-body` to scroll. */
export function DiffLines({ lines, path }: { lines: DiffLine[]; path?: string }) {
  return <div className="diff-lines">{lines.slice(0, DIFF_LINE_LIMIT).map((line, index) => line.kind === "hunk"
    ? <div key={index} className="diff-line hunk"><span className="diff-hunk">{line.text}</span></div>
    : <div key={index} className={`diff-line ${line.kind}`}>
      <span className="diff-no">{line.oldNo ?? ""}</span><span className="diff-no">{path && line.newNo ? <FileRefLink label={`Open line ${line.newNo}`} target={{ path, line: line.newNo }}>{line.newNo}</FileRefLink> : line.newNo ?? ""}</span>
      <span className="diff-sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span><span className="diff-text">{line.text || " "}</span>
    </div>)}</div>;
}
