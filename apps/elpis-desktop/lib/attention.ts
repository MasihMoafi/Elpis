import { appStorage } from "./projects";
import { apply, view, type Op } from "./attention-state.cts";

const KEY = "elpis-chat-attention-v1";
const CHANGE = "elpis:attention-changed";
export type Attention = { unread: string[]; plans: Record<string, string>; pending: Record<string, string[]> };

export function readAttention(): Attention {
  try { return view(appStorage().getItem(KEY)); }
  catch { return { unread: [], plans: {}, pending: {} }; }
}

/** Native writes are serialized in the main process; browser-only windows use their local store. */
export async function applyAttention(op: Op): Promise<void> {
  const native = window.elpisDesktop?.storage?.attention;
  if (native) await native(op);
  else {
    const storage = appStorage();
    const before = storage.getItem(KEY), after = apply(before, op);
    if (before !== after) {
      storage.setItem(KEY, after);
      window.dispatchEvent(new Event(CHANGE));
    }
  }
}

export function subscribeAttention(listener: () => void) {
  const changed = (event: StorageEvent) => { if (event.key === KEY) listener(); };
  window.addEventListener("storage", changed);
  window.addEventListener(CHANGE, listener);
  const off = window.elpisDesktop?.storage?.onChange?.(key => { if (key === KEY) listener(); });
  return () => { window.removeEventListener("storage", changed); window.removeEventListener(CHANGE, listener); off?.(); };
}
