import type { PermissionMode } from "@/components/composer-controls";
import { api, type Thread } from "@/lib/api";

/** Creates a chat with only the choices the person actually made. */
export function startThread(
  permissions: PermissionMode | null | undefined,
  model: string,
  provider: string | null | undefined,
  cwd: string | null | undefined,
  worktree?: boolean,
) {
  return api<{ thread: Thread; permissions?: PermissionMode | null }>("/threads", {
    ...(permissions ? { permissions } : {}),
    ...(model.trim() ? { model: model.trim() } : {}),
    ...(provider ? { provider } : {}),
    ...(cwd ? { cwd } : {}),
    ...(worktree ? { worktree: true } : {}),
  });
}
