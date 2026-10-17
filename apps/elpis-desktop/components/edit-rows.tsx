"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Counts, DiffLines } from "@/components/diff-view";
import { FileRefLink, FilePathText } from "@/components/file-ref";
import { Step } from "@/components/step";
import type { Item } from "@/lib/api";
import { fileEdits, shortPath, turnEdits, type FileEdit, type FileKind } from "@/lib/diff";
import { stepLabel } from "@/lib/steps";

const VERBS: Record<FileKind, [now: string, done: string]> = { add: ["Creating", "Created"], update: ["Editing", "Edited"], delete: ["Deleting", "Deleted"] };
const PROBLEMS: Record<string, string> = { failed: "Failed", declined: "Declined", cancelled: "Cancelled" };

/** One edited file as a row: the verb, the file's name and the folders above it as a hint, "+N −M"; it opens to the lines
 * it changed, drawn as the Changes tab draws them. Without a verb (the turn's footer) it is the file alone. */
export function EditRow({ edit, verb }: { edit: FileEdit; verb?: string }) {
  const { name, hint } = shortPath(edit.path), problem = PROBLEMS[edit.status];
  const title = <>
    {verb && <><span className="step-verb">{verb}</span>{" "}</>}
    <span className="step-file" title={edit.path}><FileRefLink target={{ path: edit.path, line: edit.lines.find(line => line.newNo)?.newNo ?? undefined }}>{name}</FileRefLink></span>
    {hint && <>{" "}<span className="step-hint">{hint}</span></>}
  </>;
  const body = edit.lines.length
    ? <div className="diff-body" tabIndex={0} role="region" aria-label={`Diff of ${name}`}><DiffLines lines={edit.lines} path={edit.path} /></div>
    : <p className="step-note">No lines to show.</p>;
  const meta = problem ? <span className={`step-status ${edit.status}`}>{problem}</span> : edit.status === "completed" ? <Counts added={edit.added} removed={edit.removed} /> : null;
  return <Step title={title} meta={meta} body={body} failed={edit.status === "failed"} />;
}

/** What a fileChange item shows in an opened group: a row for each file it touched, then what the patch tool said. */
export function ItemEdits({ item }: { item: Item }) {
  const edits = useMemo(() => fileEdits(item), [item]), running = item.status === "inProgress";
  const output = typeof item.output === "string" ? item.output.trim() : "";
  if (!edits.length) return <Step title={stepLabel(item)} body={output ? <pre className="step-output"><code><FilePathText text={output} /></code></pre> : undefined} failed={item.status === "failed"} />;
  return <>
    {edits.map((edit, index) => <EditRow key={`${edit.path}:${index}`} edit={edit} verb={VERBS[edit.kind][running ? 0 : 1]} />)}
    {output && <Step title="Output" body={<pre className="step-output"><code><FilePathText text={output} /></code></pre>} />}
  </>;
}

/** A finished turn's footer, as Claude ends a turn that edited files: "Changes · 3 files · +12 −4", a View changes button
 * for the Changes tab (when the window has one) and the files as the same rows, each opening to its diff. */
export function TurnChanges({ items, onViewChanges }: { items: Item[]; onViewChanges?: () => void }) {
  const [open, setOpen] = useState(false), turn = turnEdits(items);
  if (!turn.files.length) return null;
  return <section className="turn-changes" aria-label="Changes in this turn">
    <div className="turn-changes-head">
      <button type="button" className="turn-changes-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="turn-changes-name">Changes</span><span>{turn.files.length === 1 ? "1 file" : `${turn.files.length} files`}</span><Counts added={turn.added} removed={turn.removed} />
      </button>
      {onViewChanges && <Button type="button" variant="outline" size="xs" title="Show the changes in the Changes tab" onClick={onViewChanges}>View changes</Button>}
    </div>
    {open && <div className="turn-changes-body">{turn.files.map(file => <EditRow key={file.path} edit={file} />)}</div>}
  </section>;
}
