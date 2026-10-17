"use client";

import { useMemo } from "react";
import type { MenuAction } from "@/components/action-menu";
import { chooseEditor, useEditors, type EditorInfo } from "@/lib/editors";

/** A file or folder the menus act on: where it is, how it is called inside the chat's folder, and the line a reply named. */
export type FileTarget = { abs: string; rel: string; inside: boolean; dir?: boolean; line?: number };
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/** The one list of things to do with a file: open it in the Files tab (when `onFiles` is given), in an installed editor, in
 * the system's default app, show its folder, copy its path. A path's right-click menu, the Files tab's header and the tree's
 * rows all draw it. Choosing an editor remembers it (the Files tab's "Open in" button uses it); choosing the default app
 * forgets it. A failure is passed to `onError`. */
export function fileActions(target: FileTarget, editors: EditorInfo[], onError: (message: string) => void, onFiles?: () => void): MenuAction[] {
  const desktop = typeof window === "undefined" ? undefined : window.elpisDesktop;
  const attempt = (run: Promise<unknown> | undefined) => { run?.then(() => onError(""), cause => onError(cause instanceof Error ? cause.message : "Could not do that.")); };
  const copy = (text: string) => () => { navigator.clipboard.writeText(text).then(() => onError(""), () => onError("Could not copy. Select the text to copy it.")); };
  const line = target.dir ? undefined : target.line;
  return [
    ...(onFiles && target.inside && !target.dir ? [{ id: "files", label: "Open in Files pane", run: onFiles }] : []),
    ...(target.dir || !desktop?.openInEditor ? [] : editors.map(editor => ({ id: `editor-${editor.id}`, label: `Open in ${editor.name}`, run: () => { chooseEditor(editor.id); attempt(desktop.openInEditor?.(target.abs, editor.id, line)); } }))),
    ...(target.dir || !desktop?.openFile ? [] : [{ id: "default", label: "Open in default app", run: () => { chooseEditor(null); attempt(desktop.openFile?.(line ? `${target.abs}:${line}` : target.abs)); } }]),
    ...(desktop?.openFolder ? [{ id: "folder", label: "Show in folder", run: () => attempt(desktop.openFolder?.(target.dir ? target.abs : folderOf(target.abs))) }] : []),
    { id: "copy-abs", label: "Copy absolute path", run: copy(target.abs) },
    ...(target.inside ? [{ id: "copy-rel", label: "Copy relative path", run: copy(target.rel) }] : []),
    ...(target.dir ? [] : [{ id: "copy-name", label: "Copy filename", run: copy(nameOf(target.abs)) }]),
  ];
}

/** `fileActions` for a target, with the installed editors the app has. */
export function useFileActions(target: FileTarget, onError: (message: string) => void, onFiles?: () => void) {
  const editors = useEditors();
  return useMemo(() => fileActions(target, editors, onError, onFiles), [target.abs, target.rel, target.inside, target.dir, target.line, editors, onError, onFiles]);
}
