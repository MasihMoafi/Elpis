"use client";


export type Track = {
  title: string;
  artist: string;
  uri: string;
  status: string;
  canPlay: boolean;
  canPause: boolean;
  canNext: boolean;
  muted: boolean;
  canMute: boolean;
};

export type Companion = {
  pinned: boolean;
  face?: string;
  favorite: { title: string; uri: string; artist?: string } | null;
  threadId?: string | null;
  music: Track | null;
  reason: string;
};

export { FLOAT_KEY, SIZE, sized, savedPlace, watchSavedPlace, type Place } from "./matilda-place.ts";

/** The window's own chrome: she and her chat stay below the title bar, where Electron moves the window instead. */
export const chromeBottom = () =>
  typeof document === "undefined"
    ? 0
    : Math.ceil(document.querySelector(".title-bar")?.getBoundingClientRect().bottom ?? 0);
