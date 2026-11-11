/**
 * When the sidebar counts as full, so his pinned agent offers a tidy (11 Nov, Masih: "it should ping me whenever it
 * feels the side-bar is full, say 10 conversation without a project"). She says so once, and again only when it has
 * grown: a ping that repeats is noise.
 */
export const FULL_AT = 10;
export const AGAIN_AFTER = 5;
/** Where the count she last spoke at is kept. */
export const SIDEBAR_TOLD_KEY = "elpis-sidebar-told-v1";
/** What Tidy sends to Elpis. */
export const TIDY_REQUEST = "Tidy my chats: archive the leftovers and tell me what you archived.";

/** Whether she speaks now: `loose` idle chats sit outside any project, and `told` is the count she last spoke at. */
export function sidebarFull(loose: number, told: number | null): boolean {
  return loose >= FULL_AT && (told === null || loose >= told + AGAIN_AFTER);
}
/** What she remembers after a look: nothing once the sidebar is no longer full, so she speaks the next time it fills. */
export function toldAfter(loose: number, told: number | null): number | null {
  return loose < FULL_AT ? null : told;
}
/** The stored count, when it is one. */
export function storedTold(value: string | null | undefined): number | null {
  const count = Number(value);
  return value && Number.isSafeInteger(count) && count > 0 ? count : null;
}
