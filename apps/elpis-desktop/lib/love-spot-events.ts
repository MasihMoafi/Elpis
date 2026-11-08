import { createSharedEventStream } from "@/lib/shared-event-stream";

/** Share one board stream per page. Joining requests a fresh server bootstrap:
 * cached revision hashes cannot tell whether a scene predates the editor GET. */
export const subscribeLoveSpotEvents = createSharedEventStream("/api/love-spot/events", { reconnectOnJoin: true });
