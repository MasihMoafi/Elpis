import type { PermissionMode } from "@/components/composer-controls";
import type { Thread } from "@/lib/api";
import type { CanvasGraph } from "@/lib/canvas";

export type WorkflowReplay = { token: string; taskId: string; title: string; request: string; cwd: string | null; workflow: { id: string; name: string }; board: CanvasGraph };
export type View = "chat" | "agentsGuide" | "canvas" | "experimentLab" | "loveSpot" | "customize" | "observability" | "settings";
export type NextTurn = { model?: string; plan?: boolean };
export type Live = { thread: Thread; activeTurnId?: string | null; permissions?: PermissionMode | null; planMode?: boolean; followingLive?: boolean };
export const refusedOffline = (message: string) => message.includes("(ELPIS_RUNTIME_UNAVAILABLE");
