"use client";
import { useEffect, useSyncExternalStore } from "react";
import { api, unreadable } from "@/lib/api";
import { readPreferences, savePreferences } from "@/lib/preferences";
import { errorText } from "./error-text.mts";
import type { CharacterDraft, CustomCharacter } from "./custom-character-types.mts";

type Snapshot = { characters: readonly CustomCharacter[]; loaded: boolean; error: string };
const initial: Snapshot = { characters: [], loaded: false, error: "" };
let snapshot = initial, pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const readCustomCharacters = () => snapshot.characters;
export function refreshCustomCharacters() {
  return pending ??= api<{ characters: CustomCharacter[] }>("/characters").then(result => {
    if (!Array.isArray(result.characters)) throw unreadable("characters");
    snapshot = { characters: result.characters, loaded: true, error: "" };
  }).catch(error => { snapshot = { ...snapshot, loaded: true, error: errorText(error, "Characters could not be loaded.") }; })
    .finally(() => { pending = null; notify(); });
}
export function useCustomCharacters() {
  const value = useSyncExternalStore(subscribe, () => snapshot, () => initial);
  useEffect(() => { if (!snapshot.loaded) void refreshCustomCharacters(); }, []);
  useEffect(() => {
    const refresh = () => { void refreshCustomCharacters(); };
    window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh);
  }, []);
  return value;
}
export async function saveCustomCharacter(draft: CharacterDraft) {
  const { character } = await api<{ character: CustomCharacter }>("/characters", draft);
  snapshot = { characters: [...snapshot.characters, character], loaded: true, error: "" }; notify();
  return character;
}
export async function updateCharacterPersonality(id: string, personality: string) {
  const { character } = await api<{ character: CustomCharacter }>("/characters/personality", { id, personality });
  snapshot = { ...snapshot, characters: snapshot.characters.map(item => item.id === id ? character : item) }; notify();
}
export async function deleteCustomCharacter(id: string) {
  await api("/characters/delete", { id });
  const preferences = readPreferences();
  let saved: Record<string, string> = {};
  try { saved = JSON.parse(preferences.loveChatCharacters) as Record<string, string>; } catch { /* No saved assignments. */ }
  savePreferences({ ...(preferences.selectedCharacter === id ? { selectedCharacter: "elpis" } : {}), loveChatCharacters: JSON.stringify(Object.fromEntries(Object.entries(saved).map(([chat, character]) => [chat, character === id ? "elpis" : character]))) });
  snapshot = { ...snapshot, characters: snapshot.characters.filter(item => item.id !== id) }; notify();
}
