"use client";

import { useState } from "react";
import { ReplyableImage } from "@/components/image-reply";
import { FilePathText } from "@/components/file-ref";
import { Step } from "@/components/step";
import { type Item } from "@/lib/api";
import { inlineMediaUrl } from "@/lib/attachments";
import { type WorkflowNotice } from "@/lib/workflow-notice";
import { shellTokens, stepDuration, stepFailed, stepLabel, unwrapShell } from "@/lib/steps";

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const text = (value: unknown) => (typeof value === "string" ? value : "");

export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const readable = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");

/** A status worth a word on a row: a step that went well says nothing. */
export const statusLabel = (value: unknown) => {
  const status = text(value);
  return !status || status === "completed"
    ? ""
    : (
        { inProgress: "Running", failed: "Failed", declined: "Declined", cancelled: "Cancelled" } as Record<
          string,
          string
        >
      )[status] || readable(status);
};

export function attachmentLabel(part: Record<string, unknown>) {
  const type = text(part.type);
  const label =
    (
      {
        image: "Image",
        localImage: "Image",
        audio: "Audio",
        localAudio: "Audio",
        skill: "Skill",
        mention: "Mention",
      } as Record<string, string>
    )[type] ||
    readable(type) ||
    "Attachment";
  return [label, text(part.name) || text(part.path).split(/[\\/]/).at(-1)].filter(Boolean).join(" · ");
}

export function fileAttachment(part: Record<string, unknown>): string | null {
  if (part.type !== "text") return null;
  const elements = list(part.text_elements ?? part.textElements);
  if (elements.length !== 1) return null;
  const element = object(elements[0]),
    range = object(element.byteRange),
    placeholder = text(element.placeholder),
    contents = text(part.text);
  const name = placeholder.startsWith("Attachment: ") ? placeholder.slice(12) : "";
  return name &&
    contents.startsWith(`File: ${name}\n`) &&
    range.start === 0 &&
    range.end === new TextEncoder().encode(contents).length
    ? name
    : null;
}

export function RecordedAttachment({
  part,
  index,
  mediaBase,
}: {
  part: Record<string, unknown>;
  index: number;
  mediaBase?: string | undefined;
}) {
  const [failed, setFailed] = useState(false),
    label = attachmentLabel(part),
    type = text(part.type);
  const kind =
    type === "image" || type === "localImage" ? "image" : type === "audio" || type === "localAudio" ? "audio" : null;
  const url = text(part.url),
    local = type === "localImage" || type === "localAudio";
  const safeBase = mediaBase?.startsWith("/api/threads/") && !/[?#\\]/.test(mediaBase) ? mediaBase : null;
  const source = kind ? (local && safeBase ? `${safeBase}/${index}` : inlineMediaUrl(url, kind)) : null;
  if (source && !failed)
    return (
      <div className="space-y-1" title={text(part.path) || undefined}>
        <span className="break-all text-xs text-muted-foreground">{label}</span>
        {kind === "image" ? (
          <ReplyableImage src={source} name={text(part.name) || label}>
            <img
              src={source}
              alt={label}
              loading="lazy"
              className="max-h-80 max-w-full rounded-md object-contain"
              onError={() => setFailed(true)}
            />
          </ReplyableImage>
        ) : (
          <audio
            src={source}
            aria-label={label}
            controls
            preload="none"
            className="max-w-full"
            onError={() => setFailed(true)}
          />
        )}
      </div>
    );
  return (
    <div className="break-all" title={text(part.path) || undefined}>
      {label}
      {kind && (
        <span className="text-xs text-muted-foreground">
          {failed ? (
            " — Preview unavailable; the recorded file may have moved or its format could not be read."
          ) : /^https?:\/\//i.test(url) ? (
            <>
              {" "}
              —{" "}
              <a href={url} target="_blank" rel="noreferrer noopener" className="underline">
                Open {kind}
              </a>
            </>
          ) : (
            " — Preview unavailable."
          )}
        </span>
      )}
    </div>
  );
}

export function TextOutput({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <pre className="step-output">
      <code>
        <FilePathText text={typeof value === "string" ? value : JSON.stringify(value, null, 2)} />
      </code>
    </pre>
  );
}

/** A tool's step: a sentence, its time (or what went wrong) at the right, and its details in the card that opens under it. */
export function Activity({
  label,
  status,
  time,
  failed,
  children,
  open = false,
}: {
  label: string;
  status?: unknown;
  time?: number | undefined;
  failed?: boolean;
  children?: React.ReactNode;
  open?: boolean;
}) {
  const word = statusLabel(status),
    duration = stepDuration(time);
  return (
    <Step
      open={open}
      title={<FilePathText text={label} />}
      failed={failed ?? text(status) === "failed"}
      body={children}
      meta={
        word || duration ? (
          <>
            {word && <span className={`step-status ${text(status)}`}>{word}</span>}
            {duration && <span>{duration}</span>}
          </>
        ) : undefined
      }
    />
  );
}

export const NOTICE_OUTCOME: Record<string, string> = {
  completed: "finished",
  stopped: "was stopped",
  failed: "failed",
};

/** A workflow's end notice, as Claude Code shows a finished task: one step naming the run and its outcome, the result inside. */
export function WorkflowNoticeStep({ notice }: { notice: WorkflowNotice }) {
  return (
    <Activity
      label={`Workflow ${notice.name} ${NOTICE_OUTCOME[notice.status] ?? "ended"}`}
      failed={notice.status === "failed"}
    >
      {notice.summary && <p className="step-note">{notice.summary}</p>}
      <TextOutput value={notice.result} />
    </Activity>
  );
}

/** A command as Claude's desktop app shows it in an opened group: a short title, the script in a bordered block
 * coloured as shell, then its output; a failed command's exit code and output in red. */

/** The evidence a workflow prompt carries as JSON (Mother's checkpoint and recovery prompts, an agent's connected answers):
 * the chat folds it under its label, pretty-printed, after the prompt's own words. */
export const EVIDENCE =
  /\n(Current evidence|Current nodes|Answers from connected agents \(source material\)):\n([\[{][\s\S]*)$/;

export function promptEvidence(value: string) {
  const found = value.match(EVIDENCE);
  if (!found || found[2] === undefined) return null;
  try {
    return {
      text: value.slice(0, found.index).trim(),
      label: found[1],
      json: JSON.stringify(JSON.parse(found[2]), null, 2),
    };
  } catch {
    return null;
  }
}

export function CommandStep({ item, open = true }: { item: Item; open?: boolean }) {
  const failed = stepFailed(item),
    output = text(item.aggregatedOutput).replace(/\n+$/, ""),
    duration = stepDuration(item.durationMs);
  const outcome = failed
    ? typeof item.exitCode === "number"
      ? `failed · exit ${item.exitCode}`
      : "Failed"
    : typeof item.exitCode === "number"
      ? "passed"
      : statusLabel(item.status) || "Result not recorded";
  return (
    <Step
      open={open}
      failed={failed}
      title={<FilePathText text={stepLabel(item)} />}
      meta={
        open ? (
          duration || undefined
        ) : (
          <>
            <span>{outcome}</span>
            {duration && <span>{duration}</span>}
          </>
        )
      }
      body={
        <>
          <pre className="step-script" title={text(item.cwd) || undefined}>
            <code>
              {shellTokens(unwrapShell(text(item.command))).map((token, index) =>
                token.kind === "text" ? (
                  <FilePathText key={index} text={token.text} />
                ) : (
                  <span key={index} className={`sh-${token.kind}`}>
                    <FilePathText text={token.text} />
                  </span>
                ),
              )}
            </code>
          </pre>
          {failed && typeof item.exitCode === "number" && <p className="step-exit">Exit code {item.exitCode}</p>}
          {output && (
            <pre className="step-output">
              <code>
                <FilePathText text={output} />
              </code>
            </pre>
          )}
        </>
      }
    />
  );
}
