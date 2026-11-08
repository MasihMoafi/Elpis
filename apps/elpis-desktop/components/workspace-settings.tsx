import type { useBrowser } from "@/components/browser-panel";
import { permissionLabel, type PermissionMode } from "@/components/composer-controls";
import { OPEN_CONTEXT_EVENT } from "@/components/context-usage";
import { SettingsView } from "@/components/settings-view";
import { ViewBoundary } from "@/components/view-boundary";
import type { Thread } from "@/lib/api";
import type { createConversationActions } from "@/lib/conversation-actions";
import { reloadSettings } from "@/lib/settings-store";
import type { useAppearance } from "@/lib/use-appearance";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";
import type { View } from "@/lib/workspace-types";

type Props = {
  pages: ReturnType<typeof useWorkspacePagesState>;
  selected: Thread | null;
  permissionMode: PermissionMode;
  appearance: ReturnType<typeof useAppearance>;
  conversations: ReturnType<typeof useConversationList>;
  runtime: ReturnType<typeof useRuntimeState>;
  unarchived: ReturnType<typeof createConversationActions>["unarchived"];
  deleteThread: ReturnType<typeof createConversationActions>["deleteThread"];
  browser: ReturnType<typeof useBrowser>;
  busy: boolean;
  show: (view: View) => void;
  focusComposer: () => void;
  openComposerControl: (label: string) => void;
  refreshModels: () => Promise<void>;
};

export function WorkspaceSettings({
  pages,
  selected,
  permissionMode,
  appearance,
  conversations,
  runtime,
  unarchived,
  deleteThread,
  browser,
  busy,
  show,
  focusComposer,
  openComposerControl,
  refreshModels,
}: Props) {
  const { settingsVisited: visited, settingsNavigation: navigation, settingsSection: section, view } = pages;
  const { theme, setTheme } = appearance;
  const { refreshThreads } = conversations;
  const { ready, accountRefresh } = runtime;
  const modelChangeReason = !ready
    ? "Wait for Elpis to connect."
    : busy
      ? "Wait for this turn to finish before changing the model."
      : undefined;
  const currentModel = selected?.model;
  return (
    visited && (
      <div className="page-scroll" hidden={view !== "settings"}>
        <ViewBoundary label="Settings" resetKey={navigation}>
          <SettingsView
            initialTab={section}
            navigationKey={navigation}
            active={view === "settings"}
            {...(selected ? { threadId: selected.id } : {})}
            {...(currentModel !== undefined ? { currentModel } : {})}
            currentPermission={selected ? permissionLabel(permissionMode) : null}
            accountRefresh={accountRefresh}
            theme={theme}
            onTheme={setTheme}
            onUnarchived={unarchived}
            onImported={() => void refreshThreads()}
            onDeleteThread={deleteThread}
            onBack={() => {
              show("chat");
              requestAnimationFrame(focusComposer);
            }}
            onChatPermissions={() => {
              show("chat");
              requestAnimationFrame(() => openComposerControl("Change permissions"));
            }}
            onChatModel={() => {
              show("chat");
              requestAnimationFrame(() => openComposerControl("Model"));
            }}
            {...(modelChangeReason !== undefined ? { modelChangeReason } : {})}
            onBrowser={url => {
              show("chat");
              void browser.command("new", url ? { url } : undefined);
            }}
            onOpenMother={() => show("mother")}
            onCustomize={() => show("customize")}
            onChatContext={() => {
              show("chat");
              requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(OPEN_CONTEXT_EVENT)));
            }}
            onProvidersChanged={async () => {
              await reloadSettings();
              void refreshModels();
            }}
          />
        </ViewBoundary>
      </div>
    )
  );
}
