/** Owns the model catalogue and the provider settings used to choose a model. */
import { useCallback, useRef, useState } from "react";
import { api, type Model, type ProviderSettings } from "@/lib/api";
import { useElpisSettings } from "@/lib/settings-store";

export function useModelCatalog() {
  const [models, setModels] = useState<Model[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const catalogRequest = useRef(0);
  const refreshModels = useCallback(async () => {
    const id = ++catalogRequest.current; setCatalogLoading(true);
    try {
      const result = await api<{ data: Model[] }>("/models");
      if (!Array.isArray(result?.data)) throw new Error("The model catalogue did not return a model list.");
      if (catalogRequest.current === id) { setModels(result.data); setCatalogError(""); }
    } catch (cause) {
      if (catalogRequest.current === id) setCatalogError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (catalogRequest.current === id) setCatalogLoading(false); }
  }, []);
  // One settings snapshot for the whole app, so a main model saved in Settings is what the next new chat starts with.
  const settingsSnapshot = useElpisSettings().data as unknown as ProviderSettings | null;
  const providerSettings = settingsSnapshot?.main && Array.isArray(settingsSnapshot.providers) ? settingsSnapshot : null;
  return { models, catalogError, catalogLoading, catalogRequest, refreshModels, providerSettings };
}
