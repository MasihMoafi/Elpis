"use client";

import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import type { Attachment } from "@/lib/attachments";
import type { Mention } from "@/lib/mentions";
import { readPreferences } from "@/lib/preferences";

/** Settings → General → Follow-up behavior: Queue holds messages sent during a running turn
 * and sends them, one turn each, after it completes. Steer (the default) adds them to the running turn. */
export type FollowUpOptions = { model?: string; effort?: string; mode?: "plan" | "default"; mentions?: Mention[] };
export type FollowUp = { id: string; text: string; attachments: Attachment[] } & FollowUpOptions;
const EMPTY: FollowUp[] = [];
let queues: Record<string, FollowUp[]> = {};
const listeners = new Set<() => void>();
const set = (threadId: string, items: FollowUp[]) => { queues = { ...queues, [threadId]: items }; for (const listener of listeners) listener(); };
const sendTurn = async (threadId: string, item: FollowUp) => {
  const body = { text: item.text, ...(item.attachments.length ? { attachments: item.attachments } : {}), ...(item.mentions?.length ? { mentions: item.mentions } : {}), ...(item.model ? { model: item.model } : {}), ...(item.effort ? { effort: item.effort } : {}), ...(item.mode ? { mode: item.mode } : {}) };
  // The runtime can report the thread busy for a moment after the completion event.
  for (let attempt = 0; ; attempt++) {
    try { return await api(`/threads/${encodeURIComponent(threadId)}/turns`, body); }
    catch (error) { if (attempt >= 3 || !/is running/i.test(error instanceof Error ? error.message : "")) throw error; await new Promise(resolve => setTimeout(resolve, 400)); }
  }
};

/** Returns true when the message was queued (the person chose Queue, in Settings or by `choice` for this one message);
 * otherwise the caller steers. */
export function queueFollowUp(threadId: string, text: string, attachments: Attachment[] = [], options: FollowUpOptions = {}, choice = readPreferences().followUp) {
  if (choice !== "queue") return false;
  set(threadId, [...(queues[threadId] ?? []), { id: crypto.randomUUID(), text, attachments, ...options }]);
  return true;
}
export function removeFollowUp(threadId: string, id: string) { set(threadId, (queues[threadId] ?? []).filter(item => item.id !== id)); }
/** Takes one message out of the queue and returns it, for Edit in composer. */
export function takeFollowUp(threadId: string, id: string) {
  const item = (queues[threadId] ?? []).find(entry => entry.id === id);
  if (item) removeFollowUp(threadId, id);
  return item;
}
export function clearFollowUps(threadId: string) { set(threadId, []); }

/** Call with each runtime event: a normally completed turn sends the next queued message.
 * Stopped or failed turns keep the queue so nothing is sent unexpectedly. */
export async function sendQueuedFollowUp(method: string, params: { threadId?: string; turn?: { status?: string } }) {
  if (method !== "turn/completed" || params?.turn?.status !== "completed" || typeof params.threadId !== "string") return;
  const threadId = params.threadId, [next, ...rest] = queues[threadId] ?? [];
  if (!next) return;
  set(threadId, rest);
  try { await sendTurn(threadId, next); }
  catch (error) { set(threadId, [next, ...(queues[threadId] ?? [])]); throw error; }
}
/** Sends one queued message now: into the running turn, or as a new turn when none runs. */
export async function sendFollowUpNow(threadId: string, id: string, activeTurnId?: string) {
  const item = (queues[threadId] ?? []).find(entry => entry.id === id);
  if (!item) return;
  removeFollowUp(threadId, id);
  try {
    if (activeTurnId) await api(`/threads/${encodeURIComponent(threadId)}/steer`, { text: item.text, expectedTurnId: activeTurnId, ...(item.attachments.length ? { attachments: item.attachments } : {}), ...(item.mentions?.length ? { mentions: item.mentions } : {}) });
    else await sendTurn(threadId, item);
  } catch (error) { set(threadId, [item, ...(queues[threadId] ?? [])]); throw error; }
}
export function useFollowUps(threadId?: string) {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => threadId ? queues[threadId] ?? EMPTY : EMPTY, () => EMPTY);
}
