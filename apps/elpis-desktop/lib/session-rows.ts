import { permissionLabel, type PermissionMode } from "@/components/composer-controls";
import { modelLabel, providerLabel, type ProviderSettings } from "@/lib/api";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useModelCatalog } from "@/lib/model-catalog";
import type { modelSelection } from "@/lib/model-selection";

export function sessionRows(session: ReturnType<typeof useConversationSession>, selectedModel: ReturnType<typeof modelSelection>, models: ReturnType<typeof useModelCatalog>["models"], providerSettings: ProviderSettings | null, permissionMode: PermissionMode, chatFolder: string | undefined): [string, string][] {
  const { selected } = session, { turnModel, turnEffort, newChoice } = selectedModel;
  return [
    ["Model", modelLabel(turnModel || providerSettings?.main.model, models)],
    ["Provider", providerLabel(turnModel || providerSettings?.main.model, selected ? selected.modelProvider : newChoice?.provider ?? providerSettings?.main.provider, providerSettings?.providers)],
    ["Reasoning effort", turnEffort || "Default"],
    ["Permissions", permissionLabel(permissionMode)],
    ["Folder", chatFolder || "Default folder"],
    ["Chat", selected?.id ?? "Not started yet"],
  ];
}
