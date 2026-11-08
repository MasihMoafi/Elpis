import { createSharedEventStream } from "./shared-event-stream.ts";

/** Share one live Matilda conversation stream across every open view. */
export const subscribeLoveSpotTalk = createSharedEventStream("/api/love-spot/talk/events");
