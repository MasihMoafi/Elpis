import { SkillTrash } from "./skill-trash.mts";
import type { ClientSocket, ClientStateOptions } from "./client-state.mts";

export type DesktopClientOptions = {
  home?: string | undefined;
  timeoutMs?: number | undefined;
  openSocket?: (() => Promise<ClientSocket>) | undefined;
  reconnectDelayMs?: number | undefined;
  settingsConfirmMs?: number | undefined;
  browserConfig?: ClientStateOptions["browserConfig"] | undefined;
  archiveDirectory?: string | undefined;
  rewindHome?: string | undefined;
  spawnLinksFile?: string | undefined;
  appHome?: string | undefined;
  githubConnector?: unknown;
  skillTrashOptions?: ConstructorParameters<typeof SkillTrash>[0] | undefined;
  workflowOptions?: (Record<string, unknown> & { env?: NodeJS.ProcessEnv | undefined }) | undefined;
  cloudroom?: unknown;
  reportAttempts?: number | undefined;
  reportRetryMs?: number | undefined;
  socketPath?: string | undefined;
  beforeConnect?: (() => void | Promise<void>) | undefined;
  background?: boolean | undefined;
};
