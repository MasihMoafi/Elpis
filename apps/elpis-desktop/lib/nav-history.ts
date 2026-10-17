// Back and forward between the places the person has been: a chat, a new chat, or a page such as Agents.
// A stack with a position, as a browser keeps it; the page owns the state and says where each visit lands.

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
  if (same(history.places[history.index], place)) return history;
  const places = [...history.places.slice(0, history.index + 1), place].slice(-LIMIT);
  return { places, index: places.length - 1 };
}

/** One step back (-1) or forward (1), skipping places that can no longer be shown; null when there is none. */
export function step(history: History, delta: -1 | 1, usable: (place: Place) => boolean): { history: History; place: Place } | null {
  for (let index = history.index + delta; index >= 0 && index < history.places.length; index += delta) {
    if (usable(history.places[index])) return { history: { ...history, index }, place: history.places[index] };
  }
  return null;
}
