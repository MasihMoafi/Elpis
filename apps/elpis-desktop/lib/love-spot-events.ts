const updates = new EventTarget();
let source: EventSource | undefined;
let subscribers = 0;

/** Share one board stream per page. Joining requests a fresh server bootstrap:
 * cached revision hashes cannot tell whether a scene predates the editor GET. */
export function subscribeLoveSpotEvents(onmessage: (event: MessageEvent<string>) => void, onerror?: () => void) {
  const message = (event: Event) => onmessage(event as MessageEvent<string>);
  const error = () => onerror?.();
  updates.addEventListener("message", message);
  updates.addEventListener("error", error);
  subscribers++;

  // Register the new consumer first, and retire the old connection before opening another.
  const previous = source;
  source = undefined;
  previous?.close();
  const current = new EventSource("/api/love-spot/events");
  source = current;
  current.onmessage = event => {
    if (source === current) updates.dispatchEvent(new MessageEvent("message", {
      data: event.data, lastEventId: event.lastEventId, origin: event.origin,
    }));
  };
  current.onerror = () => { if (source === current) updates.dispatchEvent(new Event("error")); };

  let listening = true;
  return () => {
    if (!listening) return;
    listening = false;
    updates.removeEventListener("message", message);
    updates.removeEventListener("error", error);
    if (--subscribers === 0) {
      const last = source;
      source = undefined;
      last?.close();
    }
  };
}
