// Ported from dsh-superagent (MIT), src/app/role-models.ts
/** Resolves per-role models only for a brand-new session; resumes retain durable or manual selections. */
import type { RuntimeAdapter, OpenOptions, WorkerSession } from "./adapters.mts";
import type { RoleModel } from "./settings.mts";
import type { AppContext } from "../app/host.mts";

/** Resolve a configured role without starting a model turn. */
export async function resolveRoleModel(context: AppContext, model: RoleModel): Promise<RoleModel> {
  const catalog = await context.sessionController.modelCatalog();
  const provider = catalog.groups.find(group => group.id === model.provider);
  if (!provider) throw new Error(`Provider ${model.provider} is unavailable`);
  return model;
}

/** Resolve through thread/start itself; a cached catalog is not a restriction on a configured model. */
export async function initializeRoleModel(
  adapter: RuntimeAdapter,
  options: OpenOptions,
  model: RoleModel | null,
): Promise<WorkerSession> {
  return adapter.open({ ...options, model });
}
