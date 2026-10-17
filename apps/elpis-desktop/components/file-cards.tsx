"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileCode, FileImage, FileSpreadsheet, FileText, Folder, Presentation, Workflow, File } from "lucide-react";
import { MoreMenu } from "@/components/action-menu";
import { useFileActions } from "@/components/file-actions";
import { openRef, useHost } from "@/lib/files-pane";
import { resolveRef } from "@/lib/file-refs";
import { Button } from "@/components/ui/button";

/** What the agent looked at and made, as Claude's desktop app shows it (its "wiggle" file card and screenshot
 * thumbnail): a card per created file, its kind and extension under its name, with Open and Show in folder; an image
 * it viewed as a small thumbnail that opens full size. */

const KINDS: [RegExp, string, typeof File][] = [
  [/^(html?|css|s[ac]ss|[cm]?[jt]sx?|py|rs|go|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|sh|bash|zsh|json|ya?ml|toml|sql|lua|r|ipynb)$/, "Code", FileCode],
  [/^(md|mdx|txt|rtf|pdf|docx?|odt|tex)$/, "Document", FileText],
  [/^(csv|tsv)$/, "Table", FileSpreadsheet],
  [/^(xlsx?|ods)$/, "Spreadsheet", FileSpreadsheet],
  [/^(png|jpe?g|gif|webp|svg|bmp|avif)$/, "Image", FileImage],
  [/^(mmd|mermaid|dot|drawio)$/, "Diagram", Workflow],
  [/^(pptx?|key|odp)$/, "Presentation", Presentation],
];
/** A file's name without its folder, its extension, and the kind Claude's card names it by. */
export function fileKind(path: string) {
  const name = path.split("/").pop() || path, dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const [, kind, Icon] = KINDS.find(([test]) => test.test(ext)) ?? [null, "File", File];
  return { name, title: dot > 0 ? name.slice(0, dot) : name, ext, kind, Icon };
}

async function run(action: ((target: string) => Promise<void>) | undefined, target: string, fail: (message: string) => void) {
  if (!action) { fail("Files open in the Elpis desktop app."); return; }
  try { await action(target); } catch (cause) { fail(cause instanceof Error ? cause.message : "Could not open it."); }
}

/** The files a finished turn created, one card each, after its reply. */
export function CreatedFiles({ paths }: { paths: string[] }) {
  const [error, setError] = useState("");
  if (!paths.length) return null;
  return <>
    <ul className="file-cards" aria-label="Files created">
      {paths.map(path => <CreatedFile key={path} path={path} onError={setError} />)}
    </ul>
    {error && <p role="alert" className="file-cards-error">{error}</p>}
  </>;
}

function CreatedFile({ path, onError }: { path: string; onError: (message: string) => void }) {
  const { cwd } = useHost(), found = resolveRef({ path }, cwd);
  const { name, title, ext, kind, Icon } = fileKind(path), folder = found.abs.slice(0, found.abs.lastIndexOf("/")) || "/";
  const open = () => onError(openRef({ path }) ? "" : "Open a project folder to view this file.");
  const actions = useFileActions(found, onError, open);
  return <li className="file-card" title={found.abs}>
    <Icon size={20} strokeWidth={1.5} className="file-card-icon" aria-hidden="true" />
    <span className="file-card-text"><span className="file-card-name">{title}</span><span className="file-card-type">{ext ? `${kind} · ${ext.toUpperCase()}` : kind}</span></span>
    <span className="file-card-actions">
      <Button variant="outline" size="sm" aria-label={`Open ${name}`} onClick={open}>Open</Button>
      <Button variant="ghost" size="icon-sm" aria-label={`Show ${name} in folder`} title="Show in folder" onClick={() => { onError(""); void run(window.elpisDesktop?.openFolder, folder, onError); }}><Folder size={16} /></Button>
      <MoreMenu actions={actions} label={`More actions for ${name}`} title="More file actions" />
    </span>
  </li>;
}

/** An image the agent viewed: a thumbnail (small on a folded row, larger in its step) that opens full size; Esc or a
 * click closes it. Nothing shows when the image can't be read. The full view lives on the page's body, since the
 * thumbnail may sit inside a row's summary. */
export function ImageThumb({ src, name, large = false }: { src: string; name: string; large?: boolean }) {
  const [failed, setFailed] = useState(false), view = useRef<HTMLDialogElement>(null);
  if (failed) return null;
  return <>
    <img className={large ? "activity-image" : "activity-thumb"} src={src} alt={name} title="Click to view full size" loading="lazy" decoding="async"
      onError={() => setFailed(true)} onClick={event => { event.preventDefault(); event.stopPropagation(); view.current?.showModal(); }} />
    {typeof document !== "undefined" && createPortal(<dialog ref={view} className="image-view" aria-label={name} onClick={event => { event.stopPropagation(); event.currentTarget.close(); }}>
      <img src={src} alt={name} />
    </dialog>, document.body)}
  </>;
}
