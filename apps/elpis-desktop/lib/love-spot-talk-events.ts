const updates = new EventTarget();
let source: EventSource | undefined;
let subscribers = 0;

/** Share one live Matilda conversation stream across every open view. */
export function subscribeLoveSpotTalk(onmessage: (event: MessageEvent<string>) => void, onerror?: () => void) {
  const message = (event: Event) => onmessage(event as MessageEvent<string>);
  const error = () => onerror?.();
  updates.addEventListener("message", message);
  updates.addEventListener("error", error);
  subscribers++;

  if (!source) {
    const current = new EventSource("/api/love-spot/talk/events");
    source = current;
    current.onmessage = event => {
      if (source === current) updates.dispatchEvent(new MessageEvent("message", { data: event.data, origin: event.origin }));
    };
    current.onerror = () => { if (source === current) updates.dispatchEvent(new Event("error")); };
  }

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
