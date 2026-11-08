type Options = {
  /** Open a new connection for each subscriber, retiring the old one, so the server sends a fresh bootstrap. */
  reconnectOnJoin?: boolean;
};

/** One EventSource shared by every subscriber on the page; it closes with the last of them. */
export function createSharedEventStream(url: string, { reconnectOnJoin = false }: Options = {}) {
  const updates = new EventTarget();
  let source: EventSource | undefined;
  let subscribers = 0;

  function connect() {
    const current = new EventSource(url);
    source = current;
    current.onmessage = event => {
      if (source !== current) return;
      const { data, lastEventId, origin } = event;
      updates.dispatchEvent(new MessageEvent("message", { data, lastEventId, origin }));
    };
    current.onerror = () => {
      if (source === current) updates.dispatchEvent(new Event("error"));
    };
  }

  function close() {
    const last = source;
    source = undefined;
    last?.close();
  }

  return (onmessage: (event: MessageEvent<string>) => void, onerror?: () => void) => {
    const message = (event: Event) => onmessage(event as MessageEvent<string>);
    const error = () => onerror?.();
    updates.addEventListener("message", message);
    updates.addEventListener("error", error);
    subscribers++;

    // The new consumer is registered first, and an old connection retires before another opens.
    if (reconnectOnJoin) close();
    if (!source) connect();

    let listening = true;
    return () => {
      if (!listening) return;
      listening = false;
      updates.removeEventListener("message", message);
      updates.removeEventListener("error", error);
      if (--subscribers === 0) close();
    };
  };
}
