import type React from "react";
import type { useMentionMenu } from "@/components/mention-menu";
import type { useSlashMenu } from "@/components/slash-menu";
import { transferFiles } from "@/lib/attachments";
import type { createChatSend } from "@/lib/chat-send";
import { followUpKey, isSendKey, type useAppPreferences } from "@/lib/preferences";
import type { usePromptKeys } from "@/lib/prompt-history";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";

type Inputs = {
  composer: ReturnType<typeof useComposerState>;
  attachmentsState: ReturnType<typeof useComposerAttachments>;
  runtime: ReturnType<typeof useRuntimeState>;
  preferences: ReturnType<typeof useAppPreferences>;
  promptKeys: ReturnType<typeof usePromptKeys>;
  mention: ReturnType<typeof useMentionMenu>;
  slash: ReturnType<typeof useSlashMenu>;
  turnEfforts: string[];
  activeTurn: string | undefined;
  continues: boolean;
  editDraft: (value: string) => void;
  stepEffort: (by: -1 | 1) => void;
  cycleMode: () => void;
  sendShell: () => Promise<void>;
  send: ReturnType<typeof createChatSend>;
};

export function createComposerHandlers({
  composer,
  attachmentsState,
  runtime,
  preferences,
  promptKeys,
  mention,
  slash,
  turnEfforts,
  activeTurn,
  continues,
  editDraft,
  stepEffort,
  cycleMode,
  sendShell,
  send,
}: Inputs) {
  const { shellMode, textRef, setShellMode, setCaret } = composer;
  const { attachmentsRef, addFiles } = attachmentsState;
  const { ready, connected } = runtime;
  const onComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    // "!" at the start of an empty box switches to Bash mode, as in the TUI.
    if (!shellMode && !textRef.current && value.startsWith("!") && !attachmentsRef.current.length) {
      setShellMode(true);
      promptKeys.cancel();
      editDraft(value.slice(1));
      setCaret(value.length - 1);
    } else {
      editDraft(value);
      setCaret(e.target.selectionStart);
    }
  };
  const onComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = transferFiles(e.clipboardData);
    if (files.length) {
      if (!e.clipboardData.getData("text/plain")) e.preventDefault();
      void addFiles(files);
    }
  };
  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    // Esc, or Backspace in an empty box, leaves Bash mode.
    if (shellMode && (e.key === "Escape" || (e.key === "Backspace" && !textRef.current))) {
      e.preventDefault();
      e.stopPropagation();
      setShellMode(false);
      promptKeys.cancel();
      return;
    }
    if (!ready || !connected) {
      if (isSendKey(e, preferences)) e.preventDefault();
      return;
    }
    if (shellMode) {
      if (isSendKey(e, preferences)) {
        e.preventDefault();
        void sendShell();
      }
      return;
    }
    // Shift+↑/↓ steps the reasoning effort.
    if (e.shiftKey && plain && turnEfforts.length && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      e.stopPropagation();
      stepEffort(e.key === "ArrowUp" ? 1 : -1);
      return;
    }
    if (mention.onKeyDown(e) || slash.onKeyDown(e) || promptKeys.onKeyDown(e)) return;
    // Shift+Tab cycles the permission mode.
    if (e.key === "Tab" && e.shiftKey && plain) {
      e.preventDefault();
      cycleMode();
      return;
    }
    if (activeTurn && !continues) {
      const followUp = followUpKey(e, preferences);
      if (followUp) {
        e.preventDefault();
        void send(undefined, followUp);
      }
    } else if (isSendKey(e, preferences)) {
      e.preventDefault();
      void send();
    }
  };
  return { onComposerChange, onComposerPaste, onComposerKeyDown };
}
