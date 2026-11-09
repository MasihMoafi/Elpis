"use client";

import { appStorage } from "@/lib/projects";

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

/** Pinned, she floats over the app (28 Oct: "I don't like this to be here", in the title bar): drag her face to move her,
 * her corner to resize her, like Dot. Where and how big are saved as distances from the window's bottom right. */
export const FLOAT_KEY = "elpis-matilda-float-v1";

export type Place = { right: number; bottom: number; size: number };

export const SIZE = { min: 40, max: 256, step: 8 };

export const sized = (size: number) => Math.min(SIZE.max, Math.max(SIZE.min, Math.round(size)));

export function savedPlace(): Place {
  try {
    const p = JSON.parse(appStorage().getItem(FLOAT_KEY) || "null");
    if (p && [p.right, p.bottom, p.size].every(Number.isFinite))
      return { right: p.right, bottom: p.bottom, size: sized(p.size) };
  } catch {}
  // In the corner, clear of the side panel's Done button and the composer's send button.
  return { right: 16, bottom: 16, size: 64 };
}

/** The window's own chrome: she and her chat stay below the title bar, where Electron moves the window instead. */
export const chromeBottom = () =>
  typeof document === "undefined"
    ? 0
    : Math.ceil(document.querySelector(".title-bar")?.getBoundingClientRect().bottom ?? 0);

/** Panels that go over pinned Matilda rather than move her (right-hand side panels). */
export const BEHIND = ".canvas-side";
