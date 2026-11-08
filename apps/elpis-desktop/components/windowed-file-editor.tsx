"use client";

import { findFieldEvents } from "@/lib/find-in-file";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Compartment, EditorState, StateEffect, StateField, Transaction, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { languageOf } from "@/lib/file-language";
import type { Marks } from "@/components/file-editor";
import type { HighlightReply, HighlightRequest } from "@/components/file-highlight.worker";

const syntax = StateEffect.define<DecorationSet>(),
  refreshMarks = StateEffect.define<null>();
const colours = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (old, transaction) => {
    for (const effect of transaction.effects) if (effect.is(syntax)) return effect.value;
    return transaction.docChanged ? Decoration.none : old;
  },
  provide: field => EditorView.decorations.from(field),
});

/** Plain text paints first; a disposable worker colours only the region the editor draws. */
function highlight(language: string | undefined) {
  if (!language) return [];
  const languageName = language;
  return ViewPlugin.fromClass(
    class {
      worker = new Worker(new URL("./file-highlight.worker.ts", import.meta.url));
      frame = 0;
      busy = false;
      pending = false;
      version = 0;
      constructor(readonly view: EditorView) {
        this.schedule();
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.version++;
          this.schedule();
        }
      }
      schedule() {
        this.pending = true;
        if (this.busy || this.frame) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.send();
          });
        });
      }
      send() {
        if (!this.pending || this.busy) return;
        this.pending = false;
        this.busy = true;
        const { from, to } = this.view.viewport,
          id = this.version;
        const end = Math.min(to, from + 16_384),
          text = this.view.state.sliceDoc(from, end);
        this.worker.onmessage = ({ data }: MessageEvent<HighlightReply>) => {
          this.busy = false;
          if (data.id === this.version) {
            const ranges = data.ranges
              .filter(range => range.to <= text.length)
              .map(range => Decoration.mark({ class: range.className }).range(from + range.from, from + range.to));
            this.view.dispatch({ effects: syntax.of(Decoration.set(ranges, true)) });
          }
          if (this.pending) this.schedule();
        };
        this.worker.postMessage({ id, language: languageName, text } satisfies HighlightRequest);
      }
      destroy() {
        cancelAnimationFrame(this.frame);
        this.worker.terminate();
      }
    },
  );
}

type Props = {
  label: string;
  value: string;
  softWrap?: boolean;
  marks?: Marks | undefined;
  startLine?: number;
  readOnly?: boolean;
  onChange?: (text: string) => void;
  onSave?: () => void;
  onSelection?: (text: string) => void;
};
export function WindowedFileEditor({
  label,
  value,
  softWrap = false,
  marks,
  startLine = 1,
  readOnly = false,
  onChange,
  onSave,
  onSelection,
}: Props) {
  const host = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView | null>(null),
    field = useRef<HTMLInputElement>(null);
  const [find, setFind] = useState<{ query: string; at: number; focus: number } | null>(null);
  const wrap = useRef(new Compartment());
  const found = useMemo(() => {
    const matches: number[] = [],
      needle = find?.query.toLowerCase();
    if (!needle || needle.includes("\n")) return matches;
    const text = value.toLowerCase();
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) matches.push(at);
    return matches;
  }, [value, find?.query]);
  const current = find && found.length ? ((find.at % found.length) + found.length) % found.length : -1;
  const latest = useRef({
    onChange,
    onSave,
    onSelection,
    marks,
    query: find?.query ?? "",
    match: found[current],
    startLine,
  });
  latest.current = { onChange, onSave, onSelection, marks, query: find?.query ?? "", match: found[current], startLine };
  useLayoutEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        colours,
        EditorState.readOnly.of(readOnly),
        EditorState.tabSize.of(4),
        EditorView.contentAttributes.of({
          role: readOnly ? "document" : "textbox",
          "aria-label": label,
          "aria-readonly": String(readOnly),
          "data-pane-content": "",
          spellcheck: "false",
          autocapitalize: "off",
        }),
        lineNumbers({ formatNumber: number => String(number + startLine - 1) }),
        wrap.current.of(softWrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of(update => {
          if (update.docChanged) latest.current.onChange?.(update.state.doc.toString());
          if (update.selectionSet) {
            const selection = update.state.selection.main;
            latest.current.onSelection?.(update.state.sliceDoc(selection.from, selection.to));
          }
        }),
        ViewPlugin.fromClass(
          class {
            decorations: DecorationSet;
            constructor(readonly view: EditorView) {
              this.decorations = this.build();
            }
            update(update: ViewUpdate) {
              if (
                update.docChanged ||
                update.viewportChanged ||
                update.transactions.some(tr => tr.effects.some(effect => effect.is(refreshMarks)))
              )
                this.decorations = this.build();
            }
            build() {
              const ranges: Range<Decoration>[] = [],
                { marks: selected, query, match, startLine: firstLine } = latest.current;
              for (const { from, to } of this.view.visibleRanges) {
                const first = this.view.state.doc.lineAt(from).number,
                  last = this.view.state.doc.lineAt(to).number;
                if (selected?.line)
                  for (let line = first; line <= last; line++) {
                    const number = line + firstLine - 1;
                    if (number >= selected.line && number <= (selected.endLine ?? selected.line))
                      ranges.push(
                        Decoration.line({ attributes: { class: `hit${selected.added ? " added" : ""}` } }).range(
                          this.view.state.doc.line(line).from,
                        ),
                      );
                  }
                if (query) {
                  const text = this.view.state.sliceDoc(from, to).toLowerCase(),
                    needle = query.toLowerCase();
                  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length))
                    ranges.push(
                      Decoration.mark({ class: `fe-find-hit${from + at === match ? " current" : ""}` }).range(
                        from + at,
                        from + at + needle.length,
                      ),
                    );
                }
              }
              return Decoration.set(ranges, true);
            }
          },
          { decorations: plugin => plugin.decorations },
        ),
        highlight(languageOf(label)),
      ],
    });
    const target = state.doc.line(
      Math.min(state.doc.lines, Math.max(1, (marks?.line ?? startLine) - startLine + 1)),
    ).from;
    const view = new EditorView({
      state,
      parent: host.current,
      scrollTo: EditorView.scrollIntoView(target, { y: "center" }),
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
    // Identity and editability are fixed by the containing file tab; other inputs update below.
  }, [label, readOnly, startLine]);
  useLayoutEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
  }, [value]);
  useEffect(() => {
    editor.current?.dispatch({ effects: wrap.current.reconfigure(softWrap ? EditorView.lineWrapping : []) });
  }, [softWrap]);
  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    view.dispatch({ effects: refreshMarks.of(null) });
    if (marks?.line)
      view.dispatch({
        effects: EditorView.scrollIntoView(
          view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, marks.line - startLine + 1))).from,
          { y: "center" },
        ),
      });
  }, [marks?.focus, marks?.line, marks?.endLine, marks?.added, startLine]);
  useEffect(() => {
    const view = editor.current,
      at = found[current];
    if (!view) return;
    view.dispatch({ effects: refreshMarks.of(null) });
    if (at !== undefined) view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
  }, [find?.query, current, found]);
  useEffect(() => {
    if (find?.focus) {
      field.current?.focus();
      field.current?.select();
    }
  }, [find?.focus]);
  const closeFind = () => {
    setFind(null);
    editor.current?.focus();
  };
  const step = (by: number) => setFind(old => old && { ...old, at: old.at + by });
  const keys = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        latest.current.onSave?.();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        const view = editor.current,
          selection = view?.state.selection.main;
        const picked = selection ? (view?.state.sliceDoc(selection.from, selection.to) ?? "") : "";
        setFind(old => ({
          query: old?.query ?? (picked.includes("\n") ? "" : picked),
          at: 0,
          focus: (old?.focus ?? 0) + 1,
        }));
      }
    } else if (event.key === "Escape" && find) {
      event.preventDefault();
      closeFind();
    }
  };
  return (
    <div className="fe fe-windowed" onKeyDown={keys}>
      {find && (
        <div className="fe-find" role="search" aria-label="Find in file">
          <SearchField
            className="fe-find-field"
            ref={field}
            aria-label="Find in file"
            placeholder="Find in file…"
            value={find.query}
            {...findFieldEvents(find, setFind, step)}
          />
          <span role="status" className="fe-find-count">
            {!find.query ? "" : found.length ? `Finding ${current + 1} of ${found.length}` : "No matches"}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous finding"
            disabled={!found.length}
            onClick={() => step(-1)}
          >
            <ChevronUp size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next finding"
            disabled={!found.length}
            onClick={() => step(1)}
          >
            <ChevronDown size={14} />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={closeFind}>
            <X size={14} />
          </Button>
        </div>
      )}
      <div ref={host} className="fe-window" />
    </div>
  );
}
