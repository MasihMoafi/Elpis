// Back and forward between the places the person has been: a chat, a new chat, or a page such as Agents.
// A stack with a position, as a browser keeps it; the page says where each visit lands.
import { useEffect, useRef, useState } from "react";

/** Where the person is: the page, and for a chat the chat (null is an empty new chat). */
export type Place = { view: string; threadId: string | null };
export type History = { places: Place[]; index: number };

const LIMIT = 100;
const same = (a: Place, b: Place) => a.view === b.view && a.threadId === b.threadId;

export const startHistory = (place: Place): History => ({ places: [place], index: 0 });
export const canBack = (history: History) => history.index > 0;
export const canForward = (history: History) => history.index < history.places.length - 1;

/** A new place: what was ahead of the current one is dropped. The place already shown changes nothing. */
export function visit(history: History, place: Place): History {
  const current = history.places[history.index];
  if (current && same(current, place)) return history;
  const places = [...history.places.slice(0, history.index + 1), place].slice(-LIMIT);
  return { places, index: places.length - 1 };
}

/** One step back (-1) or forward (1), skipping places that can no longer be shown; null when there is none. */
export function step(history: History, delta: -1 | 1, usable: (place: Place) => boolean): { history: History; place: Place } | null {
  for (let index = history.index + delta; index >= 0 && index < history.places.length; index += delta) {
    const place = history.places[index];
    if (place && usable(place)) return { history: { ...history, index }, place };
  }
  return null;
}

/** The page's Back and Forward: each place reached once `ready` joins the stack (the first only starts it), and `go`
 * moves along it, returning the place to show. */
export function useNavHistory(ready: boolean, place: Place) {
  const [history, setHistory] = useState<History>(() => startHistory({ view: "chat", threadId: null }));
  const historyRef = useRef(history), seeded = useRef(false);
  const commit = (next: History) => { if (next !== historyRef.current) { historyRef.current = next; setHistory(next); } };
  useEffect(() => {
    if (!ready) return;
    commit(seeded.current ? visit(historyRef.current, place) : startHistory(place));
    seeded.current = true;
  }, [ready, place.view, place.threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (delta: -1 | 1, usable: (place: Place) => boolean) => {
    const found = step(historyRef.current, delta, usable);
    if (found) commit(found.history);
    return found?.place ?? null;
  };
  return { canBack: canBack(history), canForward: canForward(history), go };
}
