import { appStorage } from "./projects";

const KEY = "elpis-pinned-chats-v1";

/** Chats pinned to the top of the sidebar, kept on this computer. */
export function readPins(): string[] {
  try {
    const value = JSON.parse(appStorage().getItem(KEY) || "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function savePins(ids: string[]) {
  appStorage().setItem(KEY, JSON.stringify(ids));
}
