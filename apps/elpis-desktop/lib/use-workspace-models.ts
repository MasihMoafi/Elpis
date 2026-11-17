import { refreshModelCatalog, useModelCatalog } from "@/lib/model-catalog";
import { useElpisSettings } from "@/lib/settings-store";
import type { ProviderSettings } from "@/lib/api";
import { api } from "@/lib/api";
import { useEffect } from "react";
import { reloadSettings } from "@/lib/settings-store";

export function useWorkspaceModels() {
  // The engine's live model list is shared by every model menu.
  const catalog = useModelCatalog(),
    { models } = catalog;
  // One settings snapshot for the whole app, including the default for a new chat.
  const settingsSnapshot = useElpisSettings().data as unknown as ProviderSettings | null;
  const providerSettings =
    settingsSnapshot?.main && Array.isArray(settingsSnapshot.providers) ? settingsSnapshot : null;
  useEffect(() => {
    if (!models.length || catalog.loading || catalog.error) return;
    void api<ProviderSettings>("/settings/default-model", {}).then(next => {
      if (settingsSnapshot?.main.model && next.main?.model && next.main.model !== settingsSnapshot.main.model)
        window.dispatchEvent(new CustomEvent("elpis-default-model-change", { detail: `Default model changed to ${next.main.model}: the previous connection is unavailable.` }));
      return reloadSettings();
    }).catch(() => {});
  }, [models, catalog.loading, catalog.error]);
  return { catalog, models, settingsSnapshot, providerSettings, refreshModels: refreshModelCatalog };
}
