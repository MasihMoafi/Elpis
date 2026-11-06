import { useEffect, useRef, useState } from "react";
import type { Thread } from "@/lib/api";
import type { createChatNavigation } from "@/lib/chat-navigation";
import type { createChatSend } from "@/lib/chat-send";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useProjectState } from "@/lib/use-project-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";

type Inputs = {
  pages: ReturnType<typeof useWorkspacePagesState>; composer: ReturnType<typeof useComposerState>;
  attachments: ReturnType<typeof useComposerAttachments>; projectState: ReturnType<typeof useProjectState>; runtime: ReturnType<typeof useRuntimeState>;
  selected: Thread | null; busy: boolean; openById: (id: string) => Promise<void>;
  newChat: ReturnType<typeof createChatNavigation>["newChat"]; send: ReturnType<typeof createChatSend>;
};

export function useDesktopEntryPoints({ pages, composer, attachments, projectState, runtime, selected, busy, openById, newChat, send }: Inputs) {
  const { view } = pages;
  const { dictating } = composer;
  const { attaching } = attachments;
  const { projectChanging } = projectState;
  const { connected } = runtime;
  // The TUI's /app (`elpis-app --open-thread <id>`): the running window opens that chat.
  const openFromTui = useRef(openById); openFromTui.current = openById;
  useEffect(() => window.elpisDesktop?.onOpenThread?.(id => void openFromTui.current(id)), []);
  // Quick Entry's text opens a new chat and is sent, as in Claude; the tray's New chat opens one empty (desktop/main.cts).
  // The text waits until the new chat is on screen and Elpis can send.
  const [desktopPrompt, setDesktopPrompt] = useState<string | null>(null);
  const openFromDesktop = useRef(newChat); openFromDesktop.current = newChat;
  useEffect(() => window.elpisDesktop?.onNewChat?.(prompt => { openFromDesktop.current(); setDesktopPrompt(prompt.trim() ? prompt : null); }), []);
  useEffect(() => {
    if (desktopPrompt === null || selected || view !== "chat" || !connected || busy || dictating || attaching || projectChanging) return;
    setDesktopPrompt(null); void send(desktopPrompt);
  }, [desktopPrompt, selected, view, connected, busy, dictating, attaching, projectChanging]);
  return setDesktopPrompt;
}
