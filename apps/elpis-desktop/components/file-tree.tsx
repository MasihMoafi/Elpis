"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { RightClickMenu } from "@/components/action-menu";
import { useFileActions } from "@/components/file-actions";
import { fileKind } from "@/components/file-cards";
import { SearchField } from "@/components/ui/search-field";
import { api } from "@/lib/api";
import { loadDir, loadNames, openFile, paneIn, refresh, select as selectPath, toggleDir, treeRows, useFiles, type Row } from "@/lib/files-pane";
import { rankFiles } from "@/lib/mentions";

const SHOWN = 200;
type Match = { path: string; line: number; text: string };
const pad = (depth: number) => 10 + depth * 14;
const folderOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const message = (cause: unknown) => cause instanceof Error ? cause.message : "Could not search.";

/** One line of the tree or of a list of finds: a folder (with its chevron), a file, or a file found by name (its folder beside
 * it). A click opens a folder or previews a file; a double click or Enter keeps it; the right-click menu is `fileActions`. */
const TreeRow = memo(function TreeRow({ cwd, path, name, depth, dir, expanded, selected, current, flash, tab, where, onError, onOpen }: {
  cwd: string; path: string; name: string; depth: number; dir: boolean; expanded?: boolean; selected: boolean; current: boolean; flash: boolean; tab: boolean; where?: string;
  onError: (message: string) => void; onOpen: (path: string, dir: boolean, keep: boolean) => void;
}) {
  const actions = useFileActions({ abs: `${cwd.replace(/\/+$/, "")}/${path}`, rel: path, inside: true, dir }, onError);
  const Icon = dir ? expanded ? FolderOpen : Folder : fileKind(name).Icon;
  const click = (event: MouseEvent) => onOpen(path, dir, event.detail !== 1);
  const area = <div role="treeitem" aria-level={depth + 1} aria-expanded={dir ? !!expanded : undefined} aria-selected={selected} aria-current={current || undefined}
    tabIndex={tab ? 0 : -1} data-path={path} data-dir={dir || undefined} data-flash={flash || undefined} className="tree-row" style={{ paddingInlineStart: pad(depth) }} title={path} onClick={click} />;
  return <RightClickMenu actions={actions} area={area}>
    {dir ? <ChevronRight size={14} className={`tree-chevron${expanded ? " open" : ""}`} /> : <span className="tree-chevron" />}
    <Icon size={15} className="tree-icon" strokeWidth={1.6} />
    <span className="tree-name">{name}</span>
    {where && <span className="tree-where">{where}</span>}
  </RightClickMenu>;
});

/** `text` with the places `query` occurs (ignoring case) marked. */
function marked(text: string, query: string) {
  const lower = text.toLowerCase(), needle = query.toLowerCase(), parts: React.ReactNode[] = [];
  let at = 0;
  for (let hit = needle ? lower.indexOf(needle) : -1; hit >= 0; hit = lower.indexOf(needle, at)) {
    parts.push(text.slice(at, hit), <mark key={hit}>{text.slice(hit, hit + needle.length)}</mark>);
    at = hit + needle.length;
  }
  return [...parts, text.slice(at)];
}

/** The Files tab's left side: a filter that finds by name (and by contents after "?") and the project's tree, one folder read at
 * a time. The tree is Claude's: folders open and close, arrows move, Right and Left open and close, a path asked for from a
 * reply is opened on the way to it, selected and brought into view. */
export function FileTree({ cwd }: { cwd: string }) {
  const files = useFiles(), pane = paneIn(files, cwd), { hidden } = pane;
  const [filter, setFilter] = useState(""), [problem, setProblem] = useState(""), [focus, setFocus] = useState<string | null>(null), [flash, setFlash] = useState<string | null>(null);
  const [found, setFound] = useState<{ q: string; rows?: Match[]; truncated?: boolean; error?: string } | null>(null);
  const box = useRef<HTMLDivElement>(null), done = useRef(0);
  const mode = filter.startsWith("?") ? "contents" : filter.trim() ? "names" : "tree";
  const query = mode === "contents" ? filter.slice(1) : "";

  useEffect(() => { refresh(cwd); }, [cwd]);
  useEffect(() => { for (const dir of ["", ...pane.expanded]) void loadDir(cwd, dir, hidden); }, [cwd, hidden, pane.expanded]);
  useEffect(() => { if (mode === "names") void loadNames(cwd); }, [mode, cwd]);
  useEffect(() => {
    if (mode !== "contents" || !query.trim()) { setFound(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      api<{ data: Match[]; truncated: boolean }>(`/files/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`)
        .then(result => live && setFound({ q: query, rows: result.data, truncated: result.truncated }), cause => live && setFound({ q: query, error: message(cause) }));
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [mode, query, cwd]);

  const rows = useMemo(() => treeRows(cwd, pane, files.dirs), [cwd, pane, files.dirs]);
  const names = files.names[cwd], ranked = useMemo(() => mode === "names" && Array.isArray(names) ? rankFiles(names, filter) : [], [mode, names, filter]);

  // A file asked for from a reply: bring its row into view once the folders on the way have been read, and mark it for a moment.
  useEffect(() => {
    if (!pane.reveal || done.current === pane.reveal || !pane.selected || mode !== "tree") return;
    const row = [...(box.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [])].find(item => item.dataset.path === pane.selected);
    if (!row) return;
    done.current = pane.reveal;
    row.scrollIntoView({ block: "nearest" });
    setFlash(pane.selected);
    const timer = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(timer);
  }, [pane.reveal, pane.selected, rows, mode]);

  const open = useCallback((path: string, dir: boolean, keep: boolean, line?: number) => {
    selectPath(cwd, path); setFocus(path);
    if (dir) toggleDir(cwd, path); else openFile(cwd, path, { preview: !keep, line, endLine: line });
  }, [cwd]);
  const onError = useCallback((text: string) => setProblem(text), []);

  const entries = rows.filter((row): row is Extract<Row, { kind: "entry" }> => row.kind === "entry");
  const stop = mode === "tree" ? (pane.selected && entries.some(row => row.path === pane.selected) ? pane.selected : entries[0]?.path) : focus;
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])], at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0 || event.ctrlKey || event.metaKey || event.altKey) return;
    const here = items[at], path = here.dataset.path ?? "", dir = !!here.dataset.dir, expanded = here.getAttribute("aria-expanded") === "true";
    const go = (item?: HTMLElement) => { if (item) { event.preventDefault(); item.focus(); } };
    if (event.key === "ArrowDown") go(items[at + 1]);
    else if (event.key === "ArrowUp") go(items[at - 1]);
    else if (event.key === "Home") go(items[0]);
    else if (event.key === "End") go(items.at(-1));
    else if (event.key === "ArrowRight" && mode === "tree" && dir) { event.preventDefault(); if (!expanded) toggleDir(cwd, path); else go(items[at + 1]); }
    else if (event.key === "ArrowLeft" && mode === "tree") {
      event.preventDefault();
      if (dir && expanded) toggleDir(cwd, path); else go(items.find(item => item.dataset.path === folderOf(path)));
    } else if ((event.key === "Enter" || event.key === " ") && here.dataset.line === undefined) { event.preventDefault(); open(path, dir, true); }
    else if ((event.key === "Enter" || event.key === " ") && here.dataset.line !== undefined) { event.preventDefault(); here.click(); }
  };

  const note = (text: string) => <p className="files-note" role="status">{text}</p>;
  const rowFor = (path: string, where?: string) => <TreeRow key={`f:${path}`} cwd={cwd} path={path} name={path.slice(path.lastIndexOf("/") + 1)} depth={0} dir={false} selected={pane.selected === path} current={pane.active === path}
    flash={false} tab={false} where={where} onError={onError} onOpen={open} />;

  let body: React.ReactNode;
  if (mode === "contents") {
    if (!query.trim()) body = note("Type after ? to search file contents");
    else if (!found || found.q !== query) body = note("Searching files…");
    else if (found.error) body = <p className="files-note files-error" role="alert">{found.error}</p>;
    else if (!found.rows?.length) body = note("No matches in file contents");
    else {
      const groups: { path: string; rows: Match[] }[] = [];
      for (const row of found.rows) { const last = groups.at(-1); if (last?.path === row.path) last.rows.push(row); else groups.push({ path: row.path, rows: [row] }); }
      body = <>{groups.map(group => <div key={group.path} role="presentation">
        {rowFor(group.path, folderOf(group.path))}
        {group.rows.map(row => <div key={`${row.path}:${row.line}`} role="treeitem" aria-level={2} aria-selected={false} tabIndex={focus === `${row.path}:${row.line}` ? 0 : -1} data-path={row.path} data-line={row.line} className="tree-row tree-match" style={{ paddingInlineStart: pad(1) }}
          onFocus={() => setFocus(`${row.path}:${row.line}`)} onClick={event => open(row.path, false, event.detail !== 1, row.line)}>
          <span className="tree-line">{row.line}</span><span className="tree-snippet">{marked(row.text, query)}</span>
        </div>)}
      </div>)}
        {found.truncated && note(`Only the first ${found.rows.length} matches are shown. Keep typing to narrow.`)}</>;
    }
  } else if (mode === "names") {
    if (names === "error") body = <p className="files-note files-error" role="alert">Couldn’t read this folder.</p>;
    else if (!Array.isArray(names)) body = note("No files to show yet. Type to search.");
    else if (!ranked.length) body = note("No matching files");
    else body = <>{ranked.slice(0, SHOWN).map(path => rowFor(path, folderOf(path)))}{ranked.length > SHOWN && note(`${ranked.length - SHOWN} more files. Keep typing to narrow.`)}</>;
  } else if (!rows.length) body = note(files.dirs[`${cwd}\0\0${hidden ? 1 : 0}`]?.status === "error" ? "Couldn’t read this folder." : "Loading…");
  else body = rows.map(row => row.kind === "note"
    ? <p key={row.key} className="files-note tree-note" style={{ paddingInlineStart: pad(row.depth) }}>{row.text}</p>
    : <TreeRow key={row.path} cwd={cwd} path={row.path} name={row.name} depth={row.depth} dir={row.dir} expanded={row.expanded} selected={pane.selected === row.path}
      current={pane.active === row.path} flash={flash === row.path} tab={stop === row.path} onError={onError} onOpen={open} />);

  return <>
    <div className="tree-head">
      <SearchField className="tree-filter">
        <input type="text" aria-label="Filter files" placeholder="Filter files… (? for contents)" value={filter} spellCheck={false} autoComplete="off"
          onChange={event => setFilter(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Escape" && filter) { event.preventDefault(); event.stopPropagation(); setFilter(""); }
            else if (event.key === "ArrowDown") { event.preventDefault(); box.current?.querySelector<HTMLElement>('[role="treeitem"]')?.focus(); }
          }} />
      </SearchField>
    </div>
    <div ref={box} role="tree" aria-label="Project files" className="tree-list" onKeyDown={keys}>{body}</div>
    {problem && <p role="alert" className="files-note files-error">{problem}</p>}
  </>;
}
