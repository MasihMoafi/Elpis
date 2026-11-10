"use client";

import { routerMessageText } from "@/lib/router-message-text";
import { CollabAgentStep, SubAgentStep } from "@/components/chat-message-agent-steps";
import {
  copyAction,
  copyTextAction,
  replyAction,
  rewindAction,
  menuActions,
  MessageButtons,
  UserMessage,
} from "./user-message";
import type { MessageAction, DeleteControl } from "./user-message";
export type { DeleteControl } from "./user-message";
import {
  object,
  text,
  list,
  readable,
  attachmentLabel,
  fileAttachment,
  RecordedAttachment,
  TextOutput,
  Activity,
  WorkflowNoticeStep,
  promptEvidence,
  CommandStep,
} from "./chat-message-parts";
export { CommandStep } from "./chat-message-parts";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { SmartPruneLine } from "@/components/smart-prune";
import { useRef } from "react";
import { BranchIcon, BrowserIcon, PlanIcon, StopIcon } from "@/components/elpis-icons";
import { BrowserComments } from "@/components/browser-comments";
import { BROWSER_COMMENTS, DRAWING_NOTE } from "@/lib/browser-notes";
import { CircleCheck, CircleX, Signpost, RefreshCw, Volume2 } from "lucide-react";
import { RightClickMenu } from "@/components/action-menu";

import { MarkdownText } from "@/components/markdown-text";
import { ImageThumb, fileKind } from "@/components/file-cards";

import { FilePathText } from "@/components/file-ref";
import { ItemEdits } from "@/components/edit-rows";

import { unreadable, type Item, type Thread } from "@/lib/api";

import { plainText } from "@/lib/message-copy";
import { useReadAloud } from "@/components/read-aloud";
import "@/components/message-actions.css";
import { InkRow } from "@/components/ink-row";
import "@/components/message-body.css";
import { ReplyPreview } from "@/components/message-reply";
import { messageDomId, readReply } from "@/lib/message-reply";
import { questionReplies, questionReplyText } from "@/lib/question-reply";
import type { VersionControl } from "@/lib/turn-replacement";
import { noticeOf } from "@/lib/workflow-notice";
import { reasoningOf, stepLabel, summarize } from "@/lib/steps";
// Built into the page, as the board has it: no request that can fail or arrive late (Masih, 23 Oct).
import { isPortraitInstruction, replyPortrait } from "@/bridge/matilda-face.cts";
import { MatildaFace } from "@/components/matilda-face";
import { runCard } from "@/lib/run-card";
export function ChatMessage({
  item,
  model,
  speaker = "Elpis",
  threads = [],
  onOpenThread,
  onEdit,
  onRegenerate,
  onFork,
  onRewind,
  onDelete,
  time,
  editBlockedReason,
  editDraft,
  onEditDraftChange,
  editPending,
  mediaBase,
  activityLabel,
  onReply,
  reference,
  readAloud = false,
  version,
}: {
  version?: VersionControl;
  onDelete?: DeleteControl;
  readAloud?: boolean;
  onReply?: () => void;
  reference?: string;
  item: Item;
  model?: string;
  speaker?: string;
  threads?: Thread[];
  onOpenThread?: (id: string) => void;
  onEdit?: (text: string) => Promise<void>;
  onRegenerate?: () => void;
  onFork?: () => void;
  onRewind?: () => void;
  time?: number;
  editBlockedReason?: string;
  editDraft?: string;
  onEditDraftChange?: (value: string | null) => void;
  editPending?: boolean;
  mediaBase?: string;
  activityLabel?: string;
}) {
  const speech = useReadAloud();
  const selectedSpeech = useRef("");
  const notice = noticeOf(item);
  if (notice) return <WorkflowNoticeStep notice={notice} />;
  if (item.type === "userMessage") {
    const content = list(item.content)
        .map(object)
        .filter(part => !isPortraitInstruction(part)),
      attached = content
        .map((part, index) => ({ part, index, file: fileAttachment(part) }))
        .filter(({ part, file }) => part.type !== "text" || file),
      attachments = attached.map(({ part, file }) => file || attachmentLabel(part));
    const replies = attached.flatMap(({ part, file }) => {
      const reply = file
        ? readReply({ name: file, type: "text", text: text(part.text).slice(`File: ${file}\n`.length) })
        : null;
      return reply ? [reply] : [];
    });
    const reason = editBlockedReason;
    const shown = attached.filter(
        ({ part, file }) =>
          file !== DRAWING_NOTE &&
          (!file || !readReply({ name: file, type: "text", text: text(part.text).slice(`File: ${file}\n`.length) })),
      ),
      attachmentContent = shown.length ? (
        <ul className="mt-2 space-y-3 text-sm" aria-label="Message attachments">
          {shown.map(({ part, index, file }) => (
            <li key={index}>
              {file === BROWSER_COMMENTS ? (
                <BrowserComments text={text(part.text).slice(`File: ${file}\n`.length)} />
              ) : file ? (
                <details className="max-w-full rounded-md border border-border p-2">
                  <DisclosureSummary className="cursor-pointer break-all">{file}</DisclosureSummary>
                  <pre className="mt-2 max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words text-left">
                    {text(part.text).slice(`File: ${file}\n`.length)}
                  </pre>
                </details>
              ) : (
                <RecordedAttachment part={part} index={index} mediaBase={mediaBase} />
              )}
            </li>
          ))}
        </ul>
      ) : undefined;
    const originalBody = routerMessageText(
        content
          .filter(part => part.type === "text" && !fileAttachment(part))
          .map(part => text(part.text))
          .join("\n"),
      ),
      answers = questionReplies(originalBody);
    const body = answers ? questionReplyText(answers) : originalBody;
    const evidence = answers ? null : promptEvidence(originalBody);
    const bodyContent = evidence ? (
      <div className="space-y-2">
        <p className="whitespace-pre-wrap" dir="auto">
          {evidence.text}
        </p>
        <details>
          <DisclosureSummary>{evidence.label}</DisclosureSummary>
          <pre className="step-output">
            <code>{evidence.json}</code>
          </pre>
        </details>
      </div>
    ) : answers ? (
      <div className="space-y-3">
        {answers.map((reply, index) => (
          <div key={index} className="space-y-1">
            <p className="text-sm text-muted-foreground" dir="auto">
              {reply.question}
            </p>
            <p dir="auto">{reply.answer}</p>
          </div>
        ))}
      </div>
    ) : undefined;
    const copyText = answers
      ? [
          body,
          ...content
            .filter(part => part.type !== "text" || fileAttachment(part))
            .map(part => (part.type === "text" ? text(part.text) : attachmentLabel(part))),
        ].join("\n")
      : content.map(part => (part.type === "text" ? text(part.text) : attachmentLabel(part))).join("\n");
    const edit =
      reason || !onEdit
        ? undefined
        : answers
          ? (value: string) => onEdit(value === body ? originalBody : value)
          : onEdit;
    return (
      <UserMessage
        onReply={onReply}
        reference={reference}
        replyContent={replies.map(reply => (
          <ReplyPreview key={reply.reference} reply={reply} />
        ))}
        body={body}
        bodyContent={bodyContent}
        copyText={copyText}
        attachments={attachments}
        attachmentContent={attachmentContent}
        onEdit={edit}
        onRewind={onRewind}
        onDelete={onDelete}
        editBlockedReason={reason}
        editDraft={editDraft}
        onEditDraftChange={onEditDraftChange}
        editPending={editPending}
        time={time}
        version={version}
      />
    );
  }
  if (item.type === "agentMessage") {
    if (item.text !== undefined && typeof item.text !== "string") throw unreadable("message");
    const portrait = speaker === "Matilda" ? replyPortrait(item.text) : null;
    if (portrait) item = { ...item, text: portrait.text };
    const speechId = reference ?? item.id,
      speaking = speech?.active === speechId,
      verdict = runCard(item.text || "");
    const spokenText = readAloud ? plainText(item.text || "") : "";
    const captureSelection = (area: HTMLElement) => {
      const selection = window.getSelection(),
        body = area.querySelector(".message-body");
      selectedSpeech.current =
        selection &&
        body &&
        !selection.isCollapsed &&
        body.contains(selection.anchorNode) &&
        body.contains(selection.focusNode) &&
        selection.toString().trim()
          ? selection.toString()
          : "";
    };
    const speechAction: MessageAction[] =
      speech && (speaking || (readAloud && spokenText.trim()))
        ? [
            {
              id: "read-aloud",
              label: speaking ? "Stop" : "Read aloud",
              title: speaking ? "Stop reading aloud" : "Read aloud · Kokoro, on this computer",
              icon: speaking ? <StopIcon size={14} /> : <Volume2 size={14} />,
              run: () => {
                const selected = selectedSpeech.current;
                selectedSpeech.current = "";
                if (speaking) speech.stop();
                else void speech.play(speechId, selected || spokenText, !!selected);
              },
            },
          ]
        : [];
    const modelAction: MessageAction[] = model ? [{ id: "model", label: model, icon: null, run: () => {} }] : [];
    const actions: MessageAction[] = item.text
      ? [
          ...modelAction,
          ...replyAction(onReply),
          copyTextAction(() => item.text || ""),
          copyAction("Copy reply", () => item.text || ""),
          ...speechAction,
          ...(onRegenerate
            ? [
                {
                  id: "regenerate",
                  label: "Regenerate reply",
                  title: "Regenerate",
                  icon: <RefreshCw size={14} />,
                  run: onRegenerate,
                },
              ]
            : []),
          ...rewindAction(onRewind),
          ...(onFork
            ? [{ id: "fork", label: "Fork chat from here", icon: <BranchIcon size={14} />, run: onFork }]
            : []),
        ]
      : modelAction;
    return (
      <RightClickMenu
        actions={menuActions(actions)}
        area={
          <article
            className={speaker === "Matilda" ? "message agent matilda-message flow-root" : "message agent"}
            id={reference ? messageDomId(reference) : undefined}
            data-message-reference={onReply ? reference : undefined}
            tabIndex={reference ? -1 : undefined}
            {...(speechAction.length
              ? {
                  onPointerEnter: speech?.warm,
                  onFocus: speech?.warm,
                  onPointerDownCapture: (event: React.PointerEvent<HTMLElement>) => {
                    if (event.currentTarget.contains(event.target as Node)) captureSelection(event.currentTarget);
                  },
                  onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>) => {
                    if (
                      (event.key === "Enter" || event.key === " ") &&
                      event.currentTarget.contains(event.target as Node)
                    )
                      captureSelection(event.currentTarget);
                  },
                }
              : {})}
          />
        }
      >
        {speaker === "Matilda" && (
          <MatildaFace
            {...(portrait?.expression === undefined ? {} : { expression: portrait.expression })}
            size={64}
            className="float-left mb-2 mr-4"
          />
        )}
        {speaker !== "Elpis" && <div className="speaker">{speaker}</div>}
        <div className="message-body">
          {verdict ? (
            <section
              className={verdict.failed ? "plan-card check-failed accent-scope" : "plan-card"}
              aria-label={verdict.label}
            >
              <p className="plan-card-heading">
                {verdict.mother ? (
                  <Signpost size={14} aria-hidden="true" />
                ) : verdict.failed ? (
                  <CircleX size={14} aria-hidden="true" />
                ) : (
                  <CircleCheck size={14} aria-hidden="true" />
                )}
                {verdict.heading}
              </p>
              <MarkdownText text={verdict.text} />
            </section>
          ) : (
            <MarkdownText text={item.text || ""} />
          )}
        </div>
        {speech?.error?.id === speechId && (
          <p role="alert" className="text-sm text-destructive">
            {speech.error.message}
          </p>
        )}
        {actions.length > 0 && (
          <InkRow className="message-actions">
            <MessageButtons actions={actions} />
          </InkRow>
        )}
      </RightClickMenu>
    );
  }
  if (item.type === "smartPrune")
    return <SmartPruneLine value={item.prune} {...(mediaBase === undefined ? {} : { mediaBase })} />;
  if (item.type === "commandExecution") return <CommandStep item={item} />;
  if (item.type === "fileChange") return <ItemEdits item={item} />;
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const result = object(item.result);
    const contents = list(item.type === "mcpToolCall" ? result.content : item.contentItems);
    const output = contents
      .map(part => text(object(part).text))
      .filter(Boolean)
      .join("\n");
    const error = object(item.error);
    const label = item.type === "mcpToolCall" ? stepLabel(item) : `Used ${text(item.tool) || "a tool"}`;
    return (
      <Activity
        label={label}
        status={item.status}
        time={typeof item.durationMs === "number" ? item.durationMs : undefined}
      >
        {item.arguments !== undefined && (
          <details className="step-input">
            <DisclosureSummary>Input</DisclosureSummary>
            <TextOutput value={item.arguments} />
          </details>
        )}
        {output ? (
          <TextOutput value={output} />
        ) : result.structuredContent ? (
          <TextOutput value={result.structuredContent} />
        ) : contents.length ? (
          <p className="step-note">Non-text output is recorded for this tool.</p>
        ) : null}
        {text(error.message) && (
          <p role="alert" className="step-note step-error">
            <FilePathText text={text(error.message)} />
          </p>
        )}
      </Activity>
    );
  }
  if (item.type === "subAgentActivity")
    return <SubAgentStep item={item} threads={threads} onOpenThread={onOpenThread} />;
  if (item.type === "collabAgentToolCall")
    return <CollabAgentStep item={item} threads={threads} onOpenThread={onOpenThread} activityLabel={activityLabel} />;
  if (item.type === "reasoning") {
    const reasoning = reasoningOf(item);
    return reasoning ? (
      <Activity label="Reasoning" open>
        <MarkdownText text={reasoning} />
      </Activity>
    ) : null;
  }
  if (item.type === "webSearch") {
    const results = list(item.results);
    // Nothing to open when the search recorded no results: the row alone says what was searched.
    return (
      <Activity label={stepLabel(item)} status={item.status}>
        {results.length > 0 && (
          <div className="step-results">
            {results.map((value, index) => {
              const result = object(value);
              const href = text(result.url);
              return /^https?:\/\//i.test(href) ? (
                <p key={index}>
                  <a href={href} target="_blank" rel="noreferrer">
                    {text(result.title) || href}
                  </a>
                  {text(result.snippet) && <span>{text(result.snippet)}</span>}
                </p>
              ) : (
                <TextOutput key={index} value={value} />
              );
            })}
          </div>
        )}
      </Activity>
    );
  }
  if (item.type === "functionCallOutput")
    return (
      <Activity label={text(item.name) || "Tool output"}>
        <TextOutput
          value={
            typeof item.output === "string"
              ? item.output
              : list(item.output)
                  .map(value => text(object(value).text))
                  .filter(Boolean)
                  .join("\n")
          }
        />
      </Activity>
    );
  if (item.type === "plan")
    return (
      <section className="plan-card" aria-label="Proposed plan">
        <p className="plan-card-heading">
          <PlanIcon size={14} aria-hidden="true" />
          Plan
        </p>
        <MarkdownText text={item.text || ""} />
      </section>
    );
  if (item.type === "imageView") {
    const name = fileKind(text(item.path)).name,
      safeBase = mediaBase?.startsWith("/api/threads/") && !/[?#\\]/.test(mediaBase) ? mediaBase : null;
    // Nothing to fold: the step is its picture.
    return (
      <div className="activity-card">
        <div className="activity-heading">
          <span className="activity-icon">
            <BrowserIcon size={15} />
          </span>
          <span className="activity-title">Viewed an image</span>
          <span className="activity-preview" title={text(item.path)}>
            {name}
          </span>
        </div>
        {safeBase && (
          <div className="px-3 pb-2">
            <ImageThumb src={`${safeBase}/0`} name={name} large />
          </div>
        )}
      </div>
    );
  }
  if (item.type === "contextCompaction") return <div className="context-event">{summarize([item])}</div>;
  if (item.type === "routerNote") return <div className="context-event">{item.text}</div>;
  if (item.type === "enteredReviewMode")
    return (
      <div className="context-event">{`Review started${typeof item.review === "string" && item.review ? `: ${item.review}` : ""}`}</div>
    );
  if (item.type === "exitedReviewMode")
    return (
      <article className={speaker === "Matilda" ? "message agent matilda-message flow-root" : "message agent"}>
        <MarkdownText text={typeof item.review === "string" ? item.review : ""} />
      </article>
    );
  return (
    <Activity label={readable(item.type)}>
      <details className="step-input">
        <DisclosureSummary>Recorded details</DisclosureSummary>
        <TextOutput value={item} />
      </details>
    </Activity>
  );
}
