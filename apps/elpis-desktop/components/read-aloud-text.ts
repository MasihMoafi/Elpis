"use client";

import { useEffect, useState } from "react";
import { api, sessionReady } from "@/lib/api";

export type Playback = {
  controller: AbortController;
  peer: RTCPeerConnection | null;
  audio: HTMLAudioElement | null;
  silence: AudioContext | null;
  timer: ReturnType<typeof setTimeout> | null;
  monitor: ReturnType<typeof setInterval> | null;
  soundTimeout: ReturnType<typeof setTimeout> | null;
  audible: boolean;
  draining: boolean;
  energy: number;
  session?: string | undefined;
  ready: boolean;
  complete: boolean;
  idle?: boolean;
  reply: string;
};

export type LiveSpeech = { feed: (text: string) => void; end: () => void; done: Promise<void> };

export type Speech = {
  active: string | null;
  error: { id: string; message: string } | null;
  play: (id: string, text: string, literal?: boolean) => Promise<void>;
  stream: (id: string) => void;
  live: (id: string) => LiveSpeech | null;
  stop: () => void;
  warm: () => void;
};

/** After a read the call stays open this long, so the next Read aloud only sends its text. */
export const KEEP_OPEN_MS = 60_000;

/** How many pieces may be voiced at once, counting the one playing. */
export const VOICED_AHEAD = 3;

export const MIN_CLAUSE = 32;

/** How much of a reply still being written can be spoken now: through its last finished sentence, or its last clause once
 * there is enough to sound natural. Unclosed code, comments and links wait. */
export function speakableLength(pending: string, writing: boolean) {
  if (!writing) return pending.length;
  const sentence = [...pending.matchAll(/[.!?؟。！](?:["')\]”’]*)\s+/gu)].at(-1);
  const clause = pending.length >= MIN_CLAUSE ? [...pending.matchAll(/[,;:،؛]\s+/gu)].at(-1) : undefined;
  const last = sentence ?? clause;
  let length = last?.index === undefined ? 0 : last.index + last[0].length;
  const fence = [...pending.matchAll(/```/g)];
  if (fence.length % 2) length = Math.min(length, fence.at(-1)!.index);
  const comment = pending.lastIndexOf("<!--");
  if (comment > pending.lastIndexOf("-->")) length = Math.min(length, comment);
  const link = pending.lastIndexOf("[");
  if (link > pending.lastIndexOf("]")) length = Math.min(length, link);
  return length;
}

/** Text as it should sound: no Markdown marks, code or addresses (Matilda's portrait markers included), in sentence groups
 * short enough that the first one plays almost at once. */
export function spokenPieces(text: string): string[] {
  const plain = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, "")
    .replace(/[*_~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const pieces: string[] = [];
  for (const sentence of plain.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? []) {
    const last = pieces.at(-1);
    if (last && last.length + sentence.length <= 280) pieces[pieces.length - 1] = last + sentence;
    else pieces.push(sentence);
  }
  return pieces
    .map(piece => piece.trim())
    .filter(Boolean)
    .flatMap(piece => (piece.length <= 3800 ? [piece] : (piece.match(/.{1,3800}(\s|$)/g) ?? [])));
}

export function selectedPieces(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const token of text.match(/\S+\s*|\s+/gu) ?? []) {
    if (current && current.length + token.length > 280) {
      pieces.push(current);
      current = "";
    }
    let rest = token;
    while (rest.length > 3800) {
      let end = 3800;
      if (
        rest.charCodeAt(end - 1) >= 0xd800 &&
        rest.charCodeAt(end - 1) <= 0xdbff &&
        rest.charCodeAt(end) >= 0xdc00 &&
        rest.charCodeAt(end) <= 0xdfff
      )
        end--;
      pieces.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    current += rest;
  }
  if (current) pieces.push(current);
  return pieces;
}

/** The chosen read-aloud source; refresh after Settings changes it. */
export function useReadAloudSource() {
  const [source, setSource] = useState<{ available: boolean; revision?: string }>({ available: false });
  useEffect(() => {
    let active = true,
      request = 0;
    const load = () => {
      const current = ++request;
      void sessionReady()
        .then(() => api<{ available: boolean; revision?: string }>("/read-aloud"))
        .then(
          result => {
            if (active && current === request) setSource(result);
          },
          () => {
            if (active && current === request) setSource({ available: false });
          },
        );
    };
    load();
    window.addEventListener("elpis-read-aloud-settings", load);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      window.removeEventListener("elpis-read-aloud-settings", load);
      window.removeEventListener("focus", load);
    };
  }, []);
  return source;
}
