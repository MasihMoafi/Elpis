import type { SettingsDestination } from "@/components/settings-view";
import type { Thread } from "@/lib/api";
import { openControl } from "@/lib/slash-focus";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useComposerPanels } from "@/lib/use-composer-panels";
import type { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";
import type { useWorkspacePanels } from "@/lib/use-workspace-panels";
import type { useOpenConversation } from "@/lib/use-open-conversation";

type Inputs = {
  session: ReturnType<typeof useConversationSession>;
  composer: ReturnType<typeof useComposerState>;
  panels: ReturnType<typeof useComposerPanels>;
  pages: ReturnType<typeof useWorkspacePagesState>;
  workspacePanels: ReturnType<typeof useWorkspacePanels>;
  cwd: string;
  loadThread: ReturnType<typeof useOpenConversation>["loadThread"];
};

export function createWorkspaceControls({
  session,
  composer,
  panels,
  pages,
  workspacePanels,
  cwd,
  loadThread,
}: Inputs) {
  const { selectedRef } = session,
    { composerRef } = composer,
    { setPanel } = panels;
  const { view, setSettingsSection } = pages,
    { side, setTuiLaunch, show } = workspacePanels;
  /** "Open in Elpis TUI": the chat opens here and its terminal resumes it in the TUI (`elpis resume <id>`). */
  const openInTui = (thread: Thread) => {
    if (selectedRef.current?.id !== thread.id || view !== "chat") void loadThread(thread);
    setTuiLaunch({ key: side.openTerminal(thread.cwd || cwd, thread.id), threadId: thread.id, token: Date.now() });
  };
  const openSettings = (tab: SettingsDestination) => {
    setSettingsSection(tab);
    show("settings");
  };
  const focusComposer = () => composerRef.current?.focus();
  // Returning from a disappearing action must not override a field the person chose while it was pending.
  const restoreComposerFocus = (origin: Element | null) =>
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || active === origin) focusComposer();
    });
  /** A composer control opened for a command takes the focus; the composer gets it back when the control closes. */
  const openComposerControl = (label: string) => {
    const trigger = composerRef.current?.form?.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    if (trigger) openControl(trigger, () => composerRef.current);
  };
  const closePanel = () => {
    setPanel(null);
    focusComposer();
  };
  return { openInTui, openSettings, focusComposer, restoreComposerFocus, openComposerControl, closePanel };
}
