import type React from "react";
import { X } from "lucide-react";
import { AttachmentChips } from "@/components/attachment-chips";
import { MentionMenu, type useMentionMenu } from "@/components/mention-menu";
import { PromptStatusLine } from "@/components/prompt-status";
import { SlashMenu, type useSlashMenu } from "@/components/slash-menu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Thread } from "@/lib/api";
import { ATTACHMENT_ACCEPT, transferFiles } from "@/lib/attachments";
import { DRAWING_NOTE } from "@/lib/browser-notes";
import type { createChatSend } from "@/lib/chat-send";
import type { useDraftStore } from "@/lib/use-drafts";
import type { usePromptKeys } from "@/lib/prompt-history";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useComposerState } from "@/lib/use-composer-state";

type Props = {
  composer: ReturnType<typeof useComposerState>; attachmentsState: ReturnType<typeof useComposerAttachments>; drafts: ReturnType<typeof useDraftStore>;
  selectedRef: React.RefObject<Thread | null>; newDraftKey: React.RefObject<string>; slash: ReturnType<typeof useSlashMenu>;
  mention: ReturnType<typeof useMentionMenu>; promptKeys: ReturnType<typeof usePromptKeys>; send: ReturnType<typeof createChatSend>;
  onComposerChange: React.ChangeEventHandler<HTMLTextAreaElement>; onComposerPaste: React.ClipboardEventHandler<HTMLTextAreaElement>; onComposerKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  composerPlaceholder: string; composerNotice: string; busy: boolean; projectChanging: boolean; focusComposer: () => void; children: React.ReactNode;
};

export function ComposerForm({ composer, attachmentsState, drafts, selectedRef, newDraftKey, slash, mention, promptKeys, send, onComposerChange, onComposerPaste, onComposerKeyDown, composerPlaceholder, composerNotice, busy, projectChanging, focusComposer, children }: Props) {
  const { text, shellMode, composerRef, filePickerRef, setCaret } = composer;
  const { attachments, attachmentsRef, attaching, setAttachments, fileNotice, setFileNotice, addFiles } = attachmentsState;
  const { saveAttachments } = drafts;
  return <form className="composer" onSubmit={e => { e.preventDefault(); void send(); }} onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={e => { const files = transferFiles(e.dataTransfer); if (files.length || e.dataTransfer.types.includes("Files")) { e.preventDefault(); void addFiles(files); } }}>
            {!shellMode && <><SlashMenu menu={slash} /><MentionMenu menu={mention} /></>}
            <input ref={filePickerRef} type="file" multiple accept={ATTACHMENT_ACCEPT} className="hidden" aria-label="Choose files" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void addFiles(files); }} />
            <AttachmentChips attachments={attachments} disabled={busy || attaching} onRemove={id => { const removed = attachmentsRef.current.find(item => item.id === id), next = attachmentsRef.current.filter(item => item.id !== id && item.id !== `reply-image-${id}` && !(item.name === DRAWING_NOTE && removed?.name === "Page drawing.jpg")); setAttachments(next); saveAttachments(selectedRef.current?.id || newDraftKey.current, next); focusComposer(); }} />
            {attaching && <p role="status" className="px-3 py-2 text-sm text-muted-foreground">Reading files…</p>}
            {shellMode && <p role="status" className="bash-mode-notice"><span className="composer-pill">bash</span><span>Bash mode. Press Escape to return to chat.</span></p>}
            {!shellMode && promptKeys.status && <PromptStatusLine status={promptKeys.status} />}
            <Textarea ref={composerRef} aria-label="Message Elpis" {...(mention.open ? mention.inputProps : slash.inputProps)} onBlur={() => { slash.close(); mention.close(); promptKeys.cancel(); }} onSelect={e => setCaret(e.currentTarget.selectionStart)} placeholder={composerPlaceholder} value={text} onChange={onComposerChange} onPaste={onComposerPaste} disabled={projectChanging} onKeyDown={onComposerKeyDown} />
            {composerNotice && <div className="flex items-center gap-2 px-3 text-sm text-destructive" role="alert"><span className="whitespace-pre-line">{composerNotice}</span>{fileNotice && <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss file notice" onClick={() => setFileNotice("")}><X size={14} /></Button>}</div>}
            {children}
          </form>;
}
