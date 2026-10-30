"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { selectPaneContent } from "@/lib/pane-select";
import { PanelLeft, PanelLeftClose, RefreshCw, Undo2 } from "lucide-react";
import { MoreMenu, type MenuAction } from "@/components/action-menu";
import { useFileActions } from "@/components/file-actions";
import { fileKind } from "@/components/file-cards";
import { FileEditor } from "@/components/file-editor";
import { MarkdownText } from "@/components/markdown-text";
import { HtmlFilePreview, LargeTextPreview } from "@/components/file-preview";
import { FileTree } from "@/components/file-tree";
import { Tab, TabStrip } from "@/components/tab-strip";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { savePreferences, usePreferences } from "@/lib/preferences";
import { activate, closeFiles, collapseAll, docKey, edit, fileScope, isDirty, paneIn, refresh, reveal, revert, save, setFileView, setHidden, setShowTree, setTreeWidth, useFiles, type Doc, type OpenFile } from "@/lib/files-pane";
import "@/components/files-pane.css";

/** Narrower than this the tree and the file share the pane one at a time. */
const NARROW = 520;
const MIN_TREE = 150, MAX_TREE = 420;
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The open file: its path, Save and Revert while it has unsaved edits, Open in, the file menu, and its text. */
function FileViewer({ cwd, file, doc }: { cwd: string; file: OpenFile; doc: Doc | undefined }) {
  const [note, setNote] = useState("");
  const selectedPassage = useRef("");
  const { softWrap } = usePreferences();
  const abs = file.path.startsWith("/") ? file.path : `${cwd.replace(/\/+$/, "")}/${file.path}`, dirty = isDirty(doc), ready = doc?.status === "ready" ? doc : null;
  const markdown = /\.(md|markdown)$/i.test(file.path), html = /\.html?$/i.test(file.path), source = file.view === "source";
  const actions: MenuAction[] = useFileActions({ abs, rel: file.path, inside: !file.path.startsWith("/"), line: file.line }, setNote, undefined, () => selectedPassage.current);
  const rememberSelection = (event: React.SyntheticEvent<HTMLDivElement>) => {
    const field = event.target instanceof HTMLTextAreaElement ? event.target : null;
    if (field) selectedPassage.current = field.value.slice(field.selectionStart, field.selectionEnd);
    else { const selection = window.getSelection(); if (selection?.anchorNode && event.currentTarget.contains(selection.anchorNode)) selectedPassage.current = selection.toString(); }
  };
  useEffect(() => { setNote(""); selectedPassage.current = ""; }, [file.path]);
  let body: React.ReactNode;
  if (!doc || doc.status === "loading") body = <p className="files-note" role="status">Reading the file…</p>;
  else if (doc.status === "error") body = <p className="files-note files-error" role="alert">{doc.message}</p>;
  else if ((doc.status === "ready" || doc.status === "preview") && html && !source) body = <HtmlFilePreview key={file.path} text={doc.text} file={fileScope(cwd, file.path)} label={`Preview of ${file.path}`} onSelection={text => { selectedPassage.current = text; }} />;
  else if (doc.status === "preview") body = <LargeTextPreview key={file.path} text={doc.text} />;
  else if (doc.status === "ready") body = markdown && !source
    ? <article className="file-markdown" tabIndex={-1} onKeyDown={selectPaneContent} aria-label={`Preview of ${file.path}`}><MarkdownText text={doc.text} file={fileScope(cwd, file.path)} /></article>
    : <FileEditor key={file.path} label={`Contents of ${file.path}`} value={doc.text} softWrap={softWrap} marks={file} onChange={text => edit(cwd, file.path, text)} onSave={() => void save(cwd, file.path)} />;
  else if (doc.status === "image") body = <div className="file-image"><img src={doc.src} alt={nameOf(file.path)} /></div>;
  else if (doc.status === "pdf") body = <iframe className="file-pdf" title={`Preview of ${file.path}`} src={doc.src} />;
  else if (doc.status === "large") body = <p className="files-note">This file is over {doc.limit ? `${doc.limit / 1024 / 1024} MB` : "512 KB"}, too large to show here.</p>;
  else body = <p className="files-note">This is a binary file, so it is not shown here.</p>;
  return <>
    <div className="file-view-head">
      <span className="file-view-path" title={abs} dir="ltr">{file.path}</span>
      {(markdown || html) && (ready || doc?.status === "preview" && html) && <div className="file-view-mode" role="group" aria-label="Document view">
        <Button type="button" variant={source ? "ghost" : "secondary"} size="xs" aria-pressed={!source} onClick={() => setFileView(cwd, file.path, "preview")}>Preview</Button>
        <Button type="button" variant={source ? "secondary" : "ghost"} size="xs" aria-pressed={source} onClick={() => setFileView(cwd, file.path, "source")}>Source</Button>
      </div>}
      {dirty && <Button type="button" variant="ghost" size="icon-xs" aria-label="Revert changes" title="Throw away the edits" onClick={() => revert(cwd, file.path)}><Undo2 size={16} /></Button>}
      {dirty && <Button type="button" variant="default" size="xs" disabled={ready?.saving} title="Save (Ctrl+S)" onClick={() => void save(cwd, file.path)}>{ready?.saving ? "Saving…" : "Save"}</Button>}
      <MoreMenu actions={[{ id: "wrap", label: softWrap ? "Disable soft wrap" : "Enable soft wrap", run: () => savePreferences({ softWrap: !softWrap }) }, ...actions]} label="More file actions" title="More file actions" size={16} align="end" className="side-action" />
    </div>
    {note && <p role="alert" className="files-note files-error">{note}</p>}
    {ready?.saveError && <p role="alert" className="files-note files-error">{ready.saveError}</p>}
    <div className="file-view-body" onPointerUp={rememberSelection} onKeyUp={rememberSelection}>{body}</div>
  </>;
}

/** The side panel's Files tab, as Claude's: a project tree beside the open file, the open files as tabs above it. The tree
 * can be hidden and dragged wider; a file opens by a click in the tree or a path in a reply and can be edited and saved in
 * place. Everything it keeps is in lib/files-pane.ts, so it is all still here when another tab has been shown. */
export function FilesPane({ cwd }: { cwd: string }) {
  const files = useFiles(), pane = paneIn(files, cwd);
  const root = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; width: number } | null>(null);
  const [narrow, setNarrow] = useState(false), [closing, setClosing] = useState<string[] | null>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const watch = new ResizeObserver(() => setNarrow(element.clientWidth < NARROW));
    watch.observe(element);
    return () => watch.disconnect();
  }, [cwd, pane.active]);
  const active = pane.open.find(file => file.path === pane.active) ?? null;
  // Side by side the tree stays; one at a time, a file asked for takes the room.
  useEffect(() => { if (narrow && active && pane.showTree) setShowTree(cwd, false); }, [narrow, active?.path, active?.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cwd && !active) return <div className="files-pane"><p className="files-note">Open a chat to browse its folder.</p></div>;

  const dirtyOf = (paths: string[]) => paths.filter(path => isDirty(files.docs[docKey(cwd, path)]));
  const close = (paths: string[]) => { if (dirtyOf(paths).length) setClosing(paths); else closeFiles(cwd, paths); };
  const names = closing ? dirtyOf(closing).map(nameOf) : [];
  const widen = (width: number) => setTreeWidth(cwd, Math.min(MAX_TREE, Math.max(MIN_TREE, Math.round(width))));
  const split = (event: KeyboardEvent) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); widen(pane.treeWidth + (event.key === "ArrowRight" ? 24 : -24)); } };
  const empty = pane.showTree ? "Pick a file in the tree, or click a file path in the conversation." : "Click a file path in the conversation to open it.";
  const treeShown = !!cwd && pane.showTree;
  const treeMenu: MenuAction[] = [
    { id: "hidden", label: pane.hidden ? "Hide hidden files" : "Show hidden files", run: () => setHidden(cwd, !pane.hidden) },
    { id: "collapse", label: "Collapse all folders", run: () => collapseAll(cwd) },
  ];
  return <div ref={root} className="files-pane" data-narrow={narrow || undefined}>
    <div className="files-bar">
      <Button type="button" variant="ghost" size="icon-sm" className="side-action" disabled={!cwd} aria-pressed={treeShown} aria-label={treeShown ? "Hide file tree" : "Show file tree"} title={treeShown ? "Hide file tree" : "Show file tree"} onClick={() => setShowTree(cwd, !treeShown)}>
        {treeShown ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
      </Button>
      {treeShown && <>
        <Button type="button" variant="ghost" size="icon-sm" className="side-action" aria-label="Refresh files" title="Read the folders again" onClick={() => refresh(cwd)}><RefreshCw size={16} /></Button>
        <MoreMenu actions={treeMenu} label="File tree options" title="File tree options" size={16} align="start" className="side-action" />
      </>}
      <TabStrip label="Open files" add={null} activeKey={pane.active}>
        {pane.open.map(file => {
          const name = nameOf(file.path), Icon = fileKind(name).Icon, dirty = isDirty(files.docs[docKey(cwd, file.path)]);
          const actions: MenuAction[] = [
            ...(cwd ? [{ id: "reveal", label: "Reveal in file tree", run: () => reveal(cwd, file.path) }] : []),
            { id: "close", label: "Close file", run: () => close([file.path]) },
            { id: "others", label: "Close other files", run: () => close(pane.open.filter(item => item.path !== file.path).map(item => item.path)) },
            { id: "all", label: "Close all files", run: () => close(pane.open.map(item => item.path)) },
          ];
          return <Tab key={file.path} icon={dirty ? <span role="img" aria-label="Unsaved changes" className="dirty-dot" /> : <Icon size={16} />} label={name} title={file.path} active={file.path === pane.active} preview={file.preview}
            closeLabel={`Close ${name}`} actions={actions} onSelect={() => activate(cwd, file.path)} onClose={() => close([file.path])} />;
        })}
      </TabStrip>
    </div>
    <div className="files-split">
      {treeShown && <>
        <aside className="files-tree" aria-label="File tree" style={narrow ? undefined : { width: pane.treeWidth }}><FileTree cwd={cwd} /></aside>
        {!narrow && <div className="files-resize" role="separator" aria-orientation="vertical" aria-label="Resize file tree" aria-valuenow={pane.treeWidth} aria-valuemin={MIN_TREE} aria-valuemax={MAX_TREE} tabIndex={0} onKeyDown={split}
          onPointerDown={event => { drag.current = { x: event.clientX, width: pane.treeWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (drag.current) widen(drag.current.width + event.clientX - drag.current.x); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />}
      </>}
      {(!narrow || !treeShown) && <section className="files-view" aria-label="File viewer">
        {active ? <FileViewer cwd={cwd} file={active} doc={files.docs[docKey(cwd, active.path)]} /> : <div className="files-empty"><p>{empty}</p></div>}
      </section>}
    </div>
    <AlertDialog open={!!closing} onOpenChange={next => { if (!next) setClosing(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>{names.length === 1 ? `Your edits to ${names[0]} have not been saved. Leaving this tab discards them.` : `Your edits to ${names.join(", ")} have not been saved. Closing these tabs discards them.`}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="outline" />}>Keep editing</AlertDialogClose>
          <Button type="button" variant="destructive" onClick={() => { if (closing) closeFiles(cwd, closing); setClosing(null); }}>Discard</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
