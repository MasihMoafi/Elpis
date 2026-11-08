import { api, subscriptionOf } from "@/lib/api";
import type { MotherSettings } from "../bridge/router/settings.mts";

/** Choose the model Elpis routes with, from its own chat. Its workers and effort stay as they are. */
export async function chooseRouterModel(model: string, connection: string | undefined) {
  const current = await api<MotherSettings>("/mother-agent");
  const effort = current.roles.dispatch?.reasoningEffort;
  await api("/mother-agent", { version: current.version, roles: { ...current.roles, dispatch: { provider: subscriptionOf(model)?.id ?? connection ?? "openai", model, ...(effort ? { reasoningEffort: effort } : {}) } } });
}
