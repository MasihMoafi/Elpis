"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Phone, PhoneOff, Play } from "lucide-react";
import { SoundIcon, SoundOffIcon } from "@/components/elpis-icons";
import { useLiveVoice } from "@/components/live-voice";
import { useReadAloud } from "@/components/read-aloud";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { MATILDA_SHOTS } from "@/bridge/matilda-face.cts";

export type Mood = Exclude<keyof typeof MATILDA_SHOTS, "listening">;

export const MOODS = Object.keys(MATILDA_SHOTS).filter(name => name !== "listening") as Mood[];

export const stillness = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Her resting face is "listening"; the others fade in when they fit (28 Oct, Masih chose them): her smile while she
 * replies, a warm tilted smile while hovered, a soft smile for 3 s after her reply, and now and then a wink. Never with
 * reduced motion. */
/** Her face from what she is saying in a call (5 Nov, Masih: "I like its face to change you know? Based on the
 * conversation, and when she is thinking"). */
export function moodFromWords(words: string): Mood {
  const text = words.toLowerCase();
  // Her kiss portraits join MATILDA_SHOTS after its literal (bridge/matilda-face.cts), so its type does not list them.
  if (/\b(kiss|kisses|love you|my love|darling|sweetheart|xoxo)\b|😘|💋/.test(text))
    return "kissSoft" in MATILDA_SHOTS ? ("kissSoft" as Mood) : "softSmile";
  if (/\b(haha|ha ha|lol|funny|joke|kidding|tease|teasing|naughty|cheeky)\b|😉|😜/.test(text)) return "wink";
  if (/\?\s*$/.test(text.trim())) return "tiltSmile";
  if (/\b(sorry|miss you|it's okay|i'm here|gently|soft)\b/.test(text)) return "softSmile";
  return "smile";
}

/** During a call: listening while he talks, a thoughtful tilt while she works on a reply (there is no thinking portrait
 * yet), and while she speaks the face her words call for. */
export function callMood(call: { activity: string; said: string; paused: boolean } | null): Mood | null | undefined {
  if (!call || call.paused) return undefined;
  if (call.activity === "working") return "tiltSmile";
  if (call.activity === "speaking") return moodFromWords(call.said);
  return null;
}

export function useMood(
  replying: boolean,
  replies: number,
  call: { activity: string; said: string; paused: boolean } | null = null,
) {
  const [replied, setReplied] = useState(false),
    [hovered, setHovered] = useState(false),
    [winking, setWinking] = useState(false),
    seen = useRef(replies);
  useEffect(() => {
    if (replies <= seen.current) {
      seen.current = replies;
      return;
    }
    seen.current = replies;
    setReplied(true);
    const timer = window.setTimeout(() => setReplied(false), 3000);
    return () => window.clearTimeout(timer);
  }, [replies]);
  useEffect(() => {
    if (stillness()) return;
    let timer = 0;
    const next = () => {
      timer = window.setTimeout(
        () => {
          setWinking(true);
          timer = window.setTimeout(() => {
            setWinking(false);
            next();
          }, 1400);
        },
        25000 + Math.random() * 20000,
      );
    };
    next();
    return () => window.clearTimeout(timer);
  }, []);
  const during = callMood(call);
  const mood: Mood | null =
    during !== undefined
      ? during
      : replying
        ? "smile"
        : hovered
          ? "tiltSmile"
          : replied
            ? "softSmile"
            : winking
              ? "wink"
              : null;
  return { shown: stillness() ? null : mood, setHovered };
}

/** Her live call (Love Spot's chat) and her read-aloud voice, wherever he is in the app (5 Nov): her face shows she is
 * speaking, Mute silences her, Pause holds the call (his microphone and her voice), and the phone hangs up. */
export function useHerVoice() {
  const live = useLiveVoice(),
    speech = useReadAloud();
  const call = live?.call?.persistent ? live.call : null;
  const speaking = (!!call && call.activity === "speaking" && !call.herMuted && !call.paused) || !!speech?.active;
  return { live, call, speech, speaking, shown: !!call || !!speech?.active };
}

/** Whether the realtime voice is set up, asked once per mount, as the chat's voice button does. */
export function useVoiceAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ available: boolean }>("/voice", undefined, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) setAvailable(result.available === true);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return available;
}

/** Beside her face: Call Matilda when no call runs (5 Nov, Masih: "add that call button, the same call button that we use
 * for hang up, this is just for calling her up"); during a call, Mute, Pause and Hang up. The call is Love Spot's chat's,
 * so it goes on across the app as one started in that chat does. */
export function HerVoiceControls({
  voice,
  threadId,
}: {
  voice: ReturnType<typeof useHerVoice>;
  threadId?: string | null | undefined;
}) {
  const { live, call, speech } = voice;
  const available = useVoiceAvailable();
  if (!voice.shown)
    return live && !live.call && threadId && available ? (
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Call Matilda"
        title="Call Matilda"
        onClick={() => live.start(threadId, true)}
      >
        <Phone size={14} />
      </Button>
    ) : null;
  const muted = !!call?.herMuted;
  return (
    <>
      {/* During a call Pause already silences her; one mute is enough (5 Nov, Masih: "it has two mute buttons, one is enough!").
        Her read-aloud voice keeps this button to stop it. */}
      {!call && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={muted ? "Unmute Matilda" : "Mute Matilda"}
          title={muted ? "Unmute Matilda" : "Mute Matilda"}
          aria-pressed={muted}
          onClick={() => {
            if (call) live?.setHerMuted(!muted);
            else speech?.stop();
          }}
        >
          {muted ? <SoundOffIcon size={16} /> : <SoundIcon size={16} />}
        </Button>
      )}
      {call && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={call.paused ? "Resume talking with Matilda" : "Pause talking with Matilda"}
          title={call.paused ? "Resume" : "Pause: your microphone and her voice wait"}
          aria-pressed={call.paused}
          onClick={() => live?.setPaused(!call.paused)}
        >
          {call.paused ? <Play size={14} /> : <Pause size={14} />}
        </Button>
      )}
      {call && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="End voice chat with Matilda"
          title="Hang up"
          onClick={() => live?.end()}
        >
          <PhoneOff size={14} />
        </Button>
      )}
    </>
  );
}
