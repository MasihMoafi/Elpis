import type { ThreadListRequest } from "./bridge-thread-list.mts";
import type { RequestId, StartPick, McpConfig, ForkLink, SavedHelper, HistoryRequest, HistoryOptions, Ceiling } from "./bridge-types.mts";
import type { BridgeEnvironment } from "./bridge-server.mts";
/** Per-connection request correlation and provider retry state. */
export function createConnectionRequests(BusyMap: BridgeEnvironment['BusyMap']) {
    const openingReplies = new Set<RequestId>();
    const pendingModelList = new Set<RequestId>();
    const pendingResume = new BusyMap<RequestId, string | undefined>();
    const resumeOptions = new Map<RequestId, {
        excludeTurns?: boolean;
        initialTurnsPage?: HistoryOptions;
    }>();
    const pendingNativeRoutes = new Map<RequestId, {
        threadId: string;
        model: string;
        effort?: string | null;
    }>();
    const pendingConfigRead = new Set<RequestId>();
    const pendingStart = new BusyMap<RequestId, StartPick>();
    const openingMcp = new Map<RequestId, McpConfig>();
    const openingEnvironment = new Map<RequestId, Record<string, string>>();
    const pendingTurnsList = new Map<RequestId, HistoryRequest>();
    const pendingItemsList = new Map<RequestId, HistoryRequest>();
    const pendingThreadList = new Map<RequestId, ThreadListRequest>();
    const pendingChildList = new Map<RequestId, string | null>();
    const pendingArchive = new Map<RequestId, string | undefined>();
    const pendingHelperMark = new Set<RequestId>();
    const pendingLimitsRead = new Set<RequestId>();
    const permissionWrites = new Map<RequestId, {
        threadId?: string;
        settings: {
            permissions?: string;
            inherit?: boolean;
            automatic?: boolean;
        };
        ephemeral?: boolean;
    }>();
    const permissionRefreshes = new Set<RequestId>();
    const forkParent = new Map<string, ForkLink>();
    const reconnects = new Map<string, NodeJS.Timeout>();
    const pendingMirrors = new Map<string, Promise<void>>();
    const pendingAdopt = new Map<RequestId, SavedHelper & {
        ceiling: Ceiling;
        stored: Ceiling | undefined;
    }>();
    return { openingReplies, pendingModelList, pendingResume, resumeOptions, pendingNativeRoutes, pendingConfigRead, pendingStart, openingMcp, openingEnvironment, pendingTurnsList, pendingItemsList, pendingThreadList, pendingChildList, pendingArchive, pendingHelperMark, pendingLimitsRead, permissionWrites, permissionRefreshes, forkParent, reconnects, pendingMirrors, pendingAdopt };
}
