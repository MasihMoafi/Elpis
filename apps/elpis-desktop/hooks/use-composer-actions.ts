/** Owns composer focus, replies, prompt editing, and search controls. */
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { SideRequest } from "@/components/side-chat";
import { ATTACHMENT_LIMITS, fitAttachments, type Attachment } from "@/lib/attachments";
import { openControl } from "@/lib/slash-focus";
import { readReply, replyAttachment } from "@/lib/message-reply";
import type { FollowUp } from "@/lib/follow-ups";
import type { Mention } from "@/lib/mentions";
import { agentName, type Entry, type Thread } from "@/lib/api";
import type { replacementEligibility } from "@/lib/turn-replacement";
import type { View } from "@/hooks/use-chat-navigation";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
type Props = { composerRef: RefObject<HTMLTextAreaElement | null>; selectedRef: Ref<Thread | null>;
  readOnlyRun: boolean; attachmentsRef: Ref<Attachment[]>; setFileNotice: Setter<string>;
  setShellMode: Setter<boolean>; setAttachments: (files: Attachment[]) => void;
  saveAttachments: (id: string, files: Attachment[]) => void;
  selected: Thread | null; setError: Setter<string>;
  setSideChat: Setter<{ parentId: string; open: boolean; question?: SideRequest } | null>;
  sideRequests: Ref<number>; editDraft: (value: string) => void; textRef: Ref<string>;
  pickedMentions: Ref<Map<string, Mention>>; newDraftKey: Ref<string>;
  replaceable: boolean; entries: Entry[];
  replacementOptions: Map<string, ReturnType<typeof replacementEligibility>>;
  setSlashNotice: Setter<string>; setMessageEdits: Setter<Record<string, string>>;
  filePickerRef: RefObject<HTMLInputElement | null>; setCaret: Setter<number>;
  view: View; show: (view: View) => void; setSidebar: Setter<boolean>;
  setSidebarCollapsed: Setter<boolean>; searchInput: RefObject<HTMLInputElement | null>;
  setPanel: Setter<"status" | "review" | "diff" | null> };

export function useComposerActions({ composerRef, selectedRef, readOnlyRun, attachmentsRef,
  setFileNotice, setShellMode, setAttachments, saveAttachments, selected, setError, setSideChat,
  sideRequests, editDraft, textRef, pickedMentions, newDraftKey, replaceable, entries,
  replacementOptions, setSlashNotice, setMessageEdits, filePickerRef, setCaret,
  view, show, setSidebar, setSidebarCollapsed, searchInput, setPanel }: Props) {
  const focusComposer = () => composerRef.current?.focus();
  function beginReply(entry: Entry, quote?: string) {
    if (!selectedRef.current || readOnlyRun) return;
    const attachment = replyAttachment(entry, entry.item.type === "userMessage" ? "You" : agentName(selectedRef.current) || "Elpis", quote);
    const fit = fitAttachments(attachmentsRef.current.filter(part => !readReply(part)), [attachment]);
    if (fit.problems.length) { setFileNotice(fit.problems.join("\n")); return; }
    setShellMode(false); setAttachments(fit.kept); saveAttachments(selectedRef.current.id, fit.kept); setFileNotice(""); focusComposer();
  }

  function askSideQuestion(question?: string) {
    if (readOnlyRun) return;
    if (!selected) { setError("Start a conversation before asking a side question."); return; }
    setSideChat({ parentId: selected.id, open: true, question: { id: ++sideRequests.current, text: question ?? "" } });
  }
  // Returning from a disappearing action must not override a field the person chose while it was pending.
  const restoreComposerFocus = (origin: Element | null) => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === origin) focusComposer();
  });
  /** A queued message's Edit in composer, as in Claude: it returns to the box above whatever is typed, with its files and @-mentions. */
  function editQueued(item: FollowUp) {
    editDraft([item.text, textRef.current].filter(part => part.trim()).join("\n\n"));
    for (const mention of item.mentions ?? []) pickedMentions.current.set(mention.path, mention);
    if (item.attachments.length) {
      const all = [...attachmentsRef.current, ...item.attachments], kept = all.slice(0, ATTACHMENT_LIMITS.count);
      setAttachments(kept); saveAttachments(selectedRef.current?.id || newDraftKey.current, kept);
      if (kept.length < all.length) setFileNotice(`A message holds up to ${ATTACHMENT_LIMITS.count} files; the extra files of the queued message were left out.`);
    }
    focusComposer();
  }
  /** Puts an earlier message (or the draft) in the box with the caret at its start or end, as the history keys do. */
  function writePrompt(value: string, caret: "start" | "end") {
    editDraft(value);
    requestAnimationFrame(() => { const at = caret === "end" ? value.length : 0; composerRef.current?.setSelectionRange(at, at); });
  }
  /** Esc Esc in an empty box opens the newest message you sent for editing, as in Claude; one that cannot be replaced says why. */
  function editLastMessage() {
    if (!replaceable || !selected) return;
    const last = entries.filter(entry => entry.item.type === "userMessage").at(-1); if (!last) return;
    const option = replacementOptions.get(last.turnId);
    if (!option?.allowed) { if (option) setSlashNotice(option.reason); return; }
    setMessageEdits(previous => ({ ...previous, [JSON.stringify([selected.id, last.turnId, last.item.id])]: option.prompt }));
  }
  /** The "+" menu's Add files or photos: the one chooser, for pictures and documents alike. */
  const pickFiles = () => filePickerRef.current?.click();
  /** The "+" menu's Mention: an "@" at the caret (after a space when words come before it), which opens the picker. */
  function startMention() {
    const box = composerRef.current, at = box?.selectionStart ?? textRef.current.length, before = textRef.current.slice(0, at);
    const glue = before && !/\s$/.test(before) ? " " : "", next = before + glue + "@" + textRef.current.slice(at), position = before.length + glue.length + 1;
    editDraft(next); setCaret(position); box?.focus(); requestAnimationFrame(() => box?.setSelectionRange(position, position));
  }
  /** The "+" menu's Slash commands: a "/" in an empty box, which opens the command list. */
  function startSlash() { editDraft("/"); setCaret(1); focusComposer(); }
  const focusSearch = () => { if (view === "settings") show("chat"); setSidebar(true); setSidebarCollapsed(false); requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); }); };
  /** A composer control opened for a command takes the focus; the composer gets it back when the control closes. */
  const openComposerControl = (label: string) => { const trigger = composerRef.current?.form?.querySelector<HTMLElement>(`[aria-label="${label}"]`); if (trigger) openControl(trigger, () => composerRef.current); };
  const closePanel = () => { setPanel(null); focusComposer(); };
  return { focusComposer, beginReply, askSideQuestion, restoreComposerFocus, editQueued,
    writePrompt, editLastMessage, pickFiles, startMention, startSlash, focusSearch,
    openComposerControl, closePanel };
}
