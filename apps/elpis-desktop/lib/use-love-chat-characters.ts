import { useEffect, useMemo, useRef } from "react";
import type { Thread } from "@/lib/api";
import { savePreferences, type Preferences } from "@/lib/preferences";
import { THEME_CHARACTERS } from "@/lib/theme-characters";

/** The name the app gives a Love Spot conversation; the character it was started with is what a person reads. */
export const LOVE_SPOT_CHAT = "Love Spot";
const MATILDA = "elpis";

function savedCharacters(text: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { /* Unreadable saved names fall back to Matilda. */ }
  return {};
}

/** Each Love Spot chat keeps the character it started with: the newest unrecorded chat takes the current one, older ones were Matilda's. */
export function assignCharacters(chats: readonly Pick<Thread, "id" | "createdAt">[], saved: Readonly<Record<string, string>>, current: string): Record<string, string> | null {
  const unknown = chats.filter(chat => !saved[chat.id]);
  if (!unknown.length) return null;
  const newest = chats.reduce((best, chat) => (chat.createdAt ?? 0) > (best.createdAt ?? 0) ? chat : best);
  return { ...saved, ...Object.fromEntries(unknown.map(chat => [chat.id, chat.id === newest.id ? current : MATILDA])) };
}

export function useLoveChatCharacters(threads: Thread[], selected: Thread | null, preferences: Pick<Preferences, "loveChatCharacters" | "selectedPalette" | "themeFollowsLoveChat">) {
  const saved = useMemo(() => savedCharacters(preferences.loveChatCharacters), [preferences.loveChatCharacters]);
  const chats = useMemo(() => threads.filter(thread => thread.name === LOVE_SPOT_CHAT), [threads]);
  const latest = useRef({ saved, preferences }); latest.current = { saved, preferences };
  useEffect(() => {
    const assigned = assignCharacters(chats, latest.current.saved, latest.current.preferences.selectedPalette);
    if (assigned) savePreferences({ loveChatCharacters: JSON.stringify(assigned) });
  }, [chats]);
  // Only on opening a chat, so choosing another theme while in it is not undone.
  const character = selected ? saved[selected.id] : undefined;
  useEffect(() => {
    const { preferences: now } = latest.current;
    if (character && now.themeFollowsLoveChat && character !== now.selectedPalette && (character === MATILDA || THEME_CHARACTERS[character])) savePreferences({ selectedPalette: character });
  }, [selected?.id, character]);
  return (thread: Pick<Thread, "id">) => THEME_CHARACTERS[saved[thread.id] ?? MATILDA]?.name ?? "Matilda";
}
