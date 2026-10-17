"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";

/** The line height in pixels: the same number in components/files-pane.css (--fe-line), which every layer shares. */
const LINE = 20;
type Found = { line: number; start: number; end: number };
export type Marks = { line?: number; endLine?: number; /** Counts the times the lines were asked for, so a second click on the same lines scrolls there again. */ focus: number };

/** Every place `query` occurs (ignoring case), line by line. */
function search(lines: string[], query: string): Found[] {
  const needle = query.toLowerCase(), found: Found[] = [];
  if (!needle || needle.includes("\n")) return found;
  lines.forEach((text, line) => { const lower = text.toLowerCase(); for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) found.push({ line, start: at, end: at + needle.length }); });
  return found;
}
const mod = (n: number, size: number) => ((n % size) + size) % size;

/** One line of the layer behind the text: it marks the lines a reply pointed at and the places the find matched. The
 * letters are transparent (the textarea above draws them); only the marks show. */
const Line = memo(function Line({ text, hit, pieces, current }: { text: string; hit: boolean; pieces: (Found & { index: number })[]; current: number }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const piece of pieces) {
    parts.push(text.slice(at, piece.start), <mark key={piece.index} className={`fe-find-hit${piece.index === current ? " current" : ""}`}>{text.slice(piece.start, piece.end)}</mark>);
    at = piece.end;
  }
  parts.push(text.slice(at) || (pieces.length ? "" : " "));
  return <div className={`fe-line${hit ? " hit" : ""}`}>{parts}</div>;
});
const NO_PIECES: (Found & { index: number })[] = [];

/** A file's text, edited in place: line numbers, the lines a reply named marked, find in file (Ctrl+F) and Ctrl+S to save.
 * A textarea draws and edits the text; two layers behind it move with its scroll, the numbers and the marks. */
export function FileEditor({ label, value, marks, onChange, onSave }: { label: string; value: string; marks?: Marks; onChange: (value: string) => void; onSave: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null), layer = useRef<HTMLDivElement>(null), numbers = useRef<HTMLDivElement>(null), field = useRef<HTMLInputElement>(null);
  const [find, setFind] = useState<{ query: string; at: number; focus: number } | null>(null);
  const lines = useMemo(() => value.split("\n"), [value]);
  const found = useMemo(() => search(lines, find?.query ?? ""), [lines, find?.query]);
  const current = found.length && find ? mod(find.at, found.length) : -1;
  const byLine = useMemo(() => {
    const map = new Map<number, (Found & { index: number })[]>();
    found.forEach((item, index) => map.set(item.line, [...(map.get(item.line) ?? []), { ...item, index }]));
    return map;
  }, [found]);
  const first = marks?.line ?? 0, last = marks?.endLine ?? first;

  const sync = () => {
    const box = area.current;
    if (!box) return;
    if (layer.current) layer.current.style.transform = `translate(${-box.scrollLeft}px, ${-box.scrollTop}px)`;
    if (numbers.current) numbers.current.style.transform = `translateY(${-box.scrollTop}px)`;
  };
  /** Scrolls so that `line` (from 0) is in view; `middle` puts it a third of the way down even when it already is. */
  const show = (line: number, middle = false) => {
    const box = area.current;
    if (!box) return;
    const top = line * LINE, height = box.clientHeight;
    if (middle || top < box.scrollTop + LINE || top + 2 * LINE > box.scrollTop + height) box.scrollTop = Math.max(0, top - height / 3);
    sync();
  };
  useLayoutEffect(() => { if (marks?.line) show(marks.line - 1, true); }, [marks?.focus, label]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (current >= 0) show(found[current].line); }, [current, find?.query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (find?.focus) { field.current?.focus(); field.current?.select(); } }, [find?.focus]);

  const openFind = () => {
    const box = area.current, picked = box ? value.slice(box.selectionStart, box.selectionEnd) : "";
    setFind(old => ({ query: old?.query ?? (picked && !picked.includes("\n") ? picked : ""), at: 0, focus: (old?.focus ?? 0) + 1 }));
  };
  const closeFind = () => { setFind(null); area.current?.focus(); };
  const step = (by: number) => setFind(old => old && { ...old, at: (found.length ? mod(old.at, found.length) : 0) + by });
  const keys = (event: KeyboardEvent) => {
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") { event.preventDefault(); openFind(); }
    else if (ctrl && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); onSave(); }
    else if (event.key === "Escape" && find) { event.preventDefault(); closeFind(); }
  };
  const width = `${String(lines.length).length}ch`;
  return <div className="fe" onKeyDown={keys}>
    {find && <div className="fe-find" role="search" aria-label="Find in file">
      <SearchField ref={undefined} className="fe-find-field">
        <input ref={field} type="text" aria-label="Find in file" placeholder="Find in file…" value={find.query} spellCheck={false} autoComplete="off"
          onChange={event => setFind({ ...find, query: event.target.value, at: 0 })}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }} />
      </SearchField>
      <span role="status" className="fe-find-count">{!find.query ? "" : found.length ? `Finding ${current + 1} of ${found.length}` : "No matches"}</span>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Previous finding" title="Previous finding (Shift+Enter)" disabled={!found.length} onClick={() => step(-1)}><ChevronUp size={14} /></Button>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Next finding" title="Next finding (Enter)" disabled={!found.length} onClick={() => step(1)}><ChevronDown size={14} /></Button>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Close find" title="Close (Esc)" onClick={closeFind}><X size={14} /></Button>
    </div>}
    <div className="fe-body">
      <div className="fe-gutter" aria-hidden="true" style={{ minWidth: `calc(${width} + 22px)` }}>
        <div ref={numbers}>{lines.map((_, index) => <div key={index} className="fe-gutter-line">{index + 1}</div>)}</div>
      </div>
      <div className="fe-stage">
        <div className="fe-layer" aria-hidden="true"><div ref={layer}>{lines.map((text, index) => {
          const pieces = byLine.get(index) ?? NO_PIECES;
          return <Line key={index} text={text} hit={first > 0 && index + 1 >= first && index + 1 <= last} pieces={pieces} current={pieces === NO_PIECES ? -1 : current} />;
        })}</div></div>
        <textarea ref={area} className="fe-text" aria-label={label} value={value} wrap="off" dir="ltr" spellCheck={false} autoCapitalize="off" autoComplete="off" autoCorrect="off"
          onChange={event => onChange(event.target.value)} onScroll={sync} />
      </div>
    </div>
  </div>;
}
