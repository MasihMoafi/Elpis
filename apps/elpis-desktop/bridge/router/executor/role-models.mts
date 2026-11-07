// Ported from dsh-superagent (MIT), src/app/role-models.ts
/** Resolves per-role models only for a brand-new session; resumes retain durable or manual selections. */
import type { RuntimeAdapter, OpenOptions, WorkerSession } from './adapters.mts'
import type { RoleModel } from './settings.mts'

/** Resolve through thread/start itself; a cached catalog is not a restriction on a configured model. */
export async function initializeRoleModel(adapter: RuntimeAdapter, options: OpenOptions, model: RoleModel | null): Promise<WorkerSession> {
  return adapter.open({ ...options, model })
}
