import { refreshModelCatalog, useModelCatalog } from "@/lib/model-catalog";
import { useElpisSettings } from "@/lib/settings-store";
import type { ProviderSettings } from "@/lib/api";

export function useWorkspaceModels() {
  // The engine's live model list is shared by every model menu.
  const catalog = useModelCatalog(), { models } = catalog;
  // One settings snapshot for the whole app, including the default for a new chat.
  const settingsSnapshot = useElpisSettings().data as unknown as ProviderSettings | null;
  const providerSettings = settingsSnapshot?.main && Array.isArray(settingsSnapshot.providers) ? settingsSnapshot : null;
  return { catalog, models, settingsSnapshot, providerSettings, refreshModels: refreshModelCatalog };
}
