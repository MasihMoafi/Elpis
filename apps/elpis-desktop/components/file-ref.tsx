"use client";

import { memo, useState, type KeyboardEvent, type ReactNode } from "react";
import { RightClickMenu } from "@/components/action-menu";
import { useFileActions } from "@/components/file-actions";
import { parseCodeRef, parseHref, resolveRef, withoutTail, type FileRef } from "@/lib/file-refs";
import { openRef, useHost } from "@/lib/files-pane";
import "@/components/files-pane.css";

/** One default action for every local file reference; external apps are explicit menu choices. */
export function FileRefLink({ target, children, label, className = "", current }: { target: FileRef; children: ReactNode; label?: string; className?: string; current?: boolean }) {
  const { cwd } = useHost(), [error, setError] = useState("");
  const found = resolveRef(target, cwd);
  const open = () => { setError(openRef(target) ? "" : "Open a project folder to view this file."); };
  const actions = useFileActions({ abs: found.abs, rel: found.rel, inside: found.inside, line: found.line }, setError, open);
  const key = (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } };
  return <>
    <RightClickMenu actions={actions} area={<button data-slot="file-ref" type="button" aria-label={label} aria-current={current || undefined} className={`file-ref ${className}`} title={found.abs} onClick={event => { event.preventDefault(); event.stopPropagation(); open(); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); key(event); }} />}>{children}</RightClickMenu>
    {error && <span role="alert" className="file-ref-error">{error}</span>}
  </>;
}

/** Paths in plain tool output, commands, JSON or diagnostic messages stay plain text around actionable references. */
export const FilePathText = memo(function FilePathText({ text }: { text: string }) {
  const parts = text.split(/("(?:path|file_path|filename|file)"\s*:\s*"[^"\n]*"|"[^"\n]*"|'[^'\n]*'|(?<![\p{L}\p{N}_:/])(?:\/|\.{1,2}\/)?[\p{L}\p{N}_.@()-]+(?:\/[\p{L}\p{N}_.@()-]+)+(?:[#:]L?\d+(?:-L?\d+|:\d+)?)?)/gu);
  return <>{parts.map((part, index) => {
    const field = /^("(?:path|file_path|filename|file)"\s*:\s*")([^"\n]+)(")$/.exec(part);
    if (field) {
      const ref = parseHref(field[2]);
      if (ref) return <span key={index}>{field[1]}<FileRefLink target={ref}>{field[2]}</FileRefLink>{field[3]}</span>;
    }
    const quoted = part.startsWith('"') || part.startsWith("'"), value = quoted ? part.slice(1, -1) : withoutTail(part);
    const ref = parseCodeRef(value) ?? (parseCodeRef(value.split("#")[0]) ? parseHref(value) : null) ?? (quoted && /\/[^/]+\.\w+(?:[#:]|$)/u.test(value) ? parseHref(value) : null);
    return ref ? <span key={index}>{quoted ? part[0] : ""}<FileRefLink target={ref}>{value}</FileRefLink>{quoted ? part[0] : part.slice(value.length)}</span> : part;
  })}</>;
});
