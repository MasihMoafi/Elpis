"use client";

export const REPLIES_KEY = "elpis-matilda-replies";

export const screenshotDrag = "application/x-elpis-screenshot";

export type LoveSpotProps = { dark: boolean; toolbarHost?: HTMLElement | null };

export type MatildaVoice = { enabled: boolean; available: boolean; reason: string; error: string };

export const SUBSCRIPTION_CHOICE = /^(claude|agy)\//;

export const standaloneApp =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("app") === "love-spot";
