/** Owns the message box text, mentions, attachments, and input refs. */
import { useCallback, useRef, useState } from "react";
import type { SideRequest } from "@/components/side-chat";
import type { Attachment } from "@/lib/attachments";
import type { Mention } from "@/lib/mentions";

export function useComposerInput() {
  const [text, setTextState] = useState("");
  const [shellMode, setShellMode] = useState(false);
  const shellCreated = useRef<string | null>(null);
  const [sideChat, setSideChat] = useState<{ parentId: string; open: boolean; question?: SideRequest } | null>(null);
  const sideRequests = useRef(0);
  const textRef = useRef("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  /** The mentions picked in the message box; a message carries those whose @name is still in its text. */
  const pickedMentions = useRef(new Map<string, Mention>());
  const filePickerRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachmentsState] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const setAttachments = useCallback((value: Attachment[]) => { attachmentsRef.current = value; setAttachmentsState(value); }, []);
  const [dictating, setDictating] = useState(false);
  const setText = useCallback((value: string) => { textRef.current = value; setTextState(value); }, []);
  return { text, shellMode, setShellMode, shellCreated, sideChat, setSideChat, sideRequests,
    textRef, composerRef, caret, setCaret, pickedMentions, filePickerRef, attachments,
    attachmentsRef, setAttachments, dictating, setDictating, setText };
}
