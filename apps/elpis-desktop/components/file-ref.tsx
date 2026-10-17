"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { RightClickMenu } from "@/components/action-menu";
import { useFileActions } from "@/components/file-actions";
import { resolveRef, type FileRef } from "@/lib/file-refs";
import { openRef, useHost } from "@/lib/files-pane";
import "@/components/files-pane.css";

/** A path in a reply (inline code, a link, or an absolute path in the text), as Claude's desktop app draws a file ref: a
 * button. A click opens the file in the Files tab at its lines when it lies inside the chat's folder, else in the system's
 * default app; a right click offers Open in, Show in folder and the copies (components/file-actions.tsx). */
export function FileRefLink({ target, children }: { target: FileRef; children: ReactNode }) {
  const { cwd } = useHost(), [error, setError] = useState("");
  const found = resolveRef(target, cwd);
  const outside = () => {
    const open = window.elpisDesktop?.openFile;
    if (!open) { setError("Files open in the Elpis desktop app."); return; }
    open(found.line ? `${found.abs}:${found.line}` : found.abs).then(() => setError(""), cause => setError(cause instanceof Error ? cause.message : "Could not open this file."));
  };
  const open = () => { setError(""); if (!openRef(target)) outside(); };
  const actions = useFileActions({ abs: found.abs, rel: found.rel, inside: found.inside, line: found.line }, setError, found.inside ? open : undefined);
  const key = (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } };
  return <>
    <RightClickMenu actions={actions} area={<span role="button" tabIndex={0} className="file-ref" title={found.abs} onClick={open} onKeyDown={key} />}>{children}</RightClickMenu>
    {error && <span role="alert" className="file-ref-error">{error}</span>}
  </>;
}
