import { createSharedEventStream } from "@/lib/shared-event-stream";

/** Share one live Matilda conversation stream across every open view. */
export const subscribeLoveSpotTalk = createSharedEventStream("/api/love-spot/talk/events");
