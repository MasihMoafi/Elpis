"use client";

import { isAgent, title, type Approval, type Thread } from "@/lib/api";
import { readPreferences } from "@/lib/preferences";

/** Settings → Notifications, through the web Notification API (native notifications in the desktop app). */
export type NotificationPermissionState = NotificationPermission | "unsupported";
export const notificationPermission = (): NotificationPermissionState => typeof Notification === "undefined" ? "unsupported" : Notification.permission;
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  return typeof Notification === "undefined" ? "unsupported" : await Notification.requestPermission();
}

let audio: AudioContext | null = null;
/** A short two-note chime made in the page; no sound file is shipped. */
export function playChime() {
  try {
    audio ??= new AudioContext();
    const start = audio.currentTime;
    [660, 990].forEach((frequency, index) => {
      const tone = audio!.createOscillator(), gain = audio!.createGain(), at = start + index * 0.12;
      tone.type = "sine"; tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
      tone.connect(gain).connect(audio!.destination); tone.start(at); tone.stop(at + 0.35);
    });
  } catch { /* Sound is optional; the notification still shows. */ }
}

const away = () => document.visibilityState !== "visible" || !document.hasFocus();
function show(heading: string, body: string, tag: string, open?: () => void) {
  if (notificationPermission() !== "granted") return false;
  const notification = new Notification(heading, { body, tag, silent: true });
  notification.onclick = () => { window.focus(); open?.(); notification.close(); };
  if (readPreferences().notificationSound) playChime();
  return true;
}
export function sendTestNotification() {
  return show("Elpis notifications are on", "This is how Elpis tells you a chat finished or needs you.", "elpis-test");
}

const shown = new Set<string>();
const once = (key: string) => !shown.has(key) && !!shown.add(key);
const nameOf = (id: string | undefined, threads: Thread[], fallback?: Thread) => { const thread = threads.find(item => item.id === id) ?? fallback; return thread ? title(thread) : "A conversation"; };

// Turns this window saw start, and those of them a person started (a message or a review). A Claude chat answers on its
// own when a background job it started ends, one turn per job; those turns stay silent (3 Nov: "10 sounds when one
// chat is done"). A turn already running when the window opened is not known, so it still notifies.
const started = new Set<string>(), personal = new Set<string>();

/** Call with each runtime event: a root conversation's finished turn notifies under the Turn completion choice.
 * Turns the person stopped, turns nobody started (Claude's own follow-ups) and agents' own turns stay silent. */
export function notifyRuntimeEvent(method: string, params: { threadId?: string; turnId?: string; item?: { type?: string }; turn?: { id?: string; status?: string } }, threads: Thread[], open?: (threadId: string) => void) {
  if (method === "turn/started" && params?.turn?.id) { started.add(params.turn.id); return; }
  if (method === "item/started" && params?.turnId && (params.item?.type === "userMessage" || params.item?.type === "enteredReviewMode")) { personal.add(params.turnId); return; }
  if (method !== "turn/completed" || typeof params?.threadId !== "string") return;
  const choice = readPreferences().turnNotifications, status = params.turn?.status, id = params.threadId, turnId = params.turn?.id;
  const thread = threads.find(item => item.id === id);
  if (turnId && started.has(turnId) && !personal.has(turnId)) return;
  if (choice === "never" || status === "interrupted" || !thread || isAgent(thread) || (choice === "unfocused" && !away())) return;
  if (!once(`turn:${turnId ?? id}`)) return;
  show(status === "failed" ? "Elpis stopped with an error" : "Elpis finished", title(thread), `elpis-turn-${id}`, () => open?.(id));
}

/** Call with each approval or question: notifies once while the window is in the background. */
export function notifyApproval(approval: Approval, threads: Thread[], open?: (threadId: string) => void) {
  if (!readPreferences().inputNotifications || !away() || !once(`approval:${approval.id}`)) return;
  const id = approval.params.threadId ?? approval.ownerThreadId;
  const reason = approval.params.reason ? ` · ${approval.params.reason}` : "";
  show(approval.params.questions ? "Elpis has a question" : "Elpis needs your approval", `${nameOf(id, threads, approval.thread)}${reason}`, `elpis-approval-${approval.id}`, () => open?.(id));
}
