import { readPins, savePins } from "./pins";

const KEY = "elpis-bookmarked-chats-v1";

/** Chats marked for reference, kept on this computer without moving them. */
export function readBookmarks(): string[] {
  return readPins(KEY);
}

export function saveBookmarks(ids: string[]) {
  savePins(ids, KEY);
}
