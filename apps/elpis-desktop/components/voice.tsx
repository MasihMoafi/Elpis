"use client";

import { useEffect, useRef, useState } from "react";
import { AudioLines, MicOff, PhoneOff } from "lucide-react";
import { MicIcon } from "@/components/elpis-icons";
import { useLiveVoice } from "@/components/live-voice";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

/** The chat's voice controls. The call itself is the app's (components/live-voice.tsx): a `persistent` call (Love Spot's
 * chat) keeps going when this chat or page closes; any other chat's call ends with its chat, as before. */
export function Voice({
  threadId,
  disabled,
  onBusy,
  persistent = false,
  unavailableReason,
}: {
  threadId: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  persistent?: boolean;
  unavailableReason?: string;
}) {
  const live = useLiveVoice();
  const [available, setAvailable] = useState(false);
  const mine = live?.call?.threadId === threadId ? live.call : null;
  const liveRef = useRef(live);
  liveRef.current = live;
  const persistentRef = useRef(persistent);
  persistentRef.current = persistent;
  const busyCallback = useRef(onBusy);
  busyCallback.current = onBusy;
  useEffect(() => {
    busyCallback.current(!!mine);
  }, [mine]);
  useEffect(() => () => busyCallback.current(false), []);
  useEffect(() => {
    const controller = new AbortController();
    if (!unavailableReason)
      api<{ available: boolean }>("/voice", undefined, controller.signal)
        .then(result => {
          if (!controller.signal.aborted) setAvailable(result.available === true);
        })
        .catch(() => {});
    return () => {
      controller.abort();
      const current = liveRef.current;
      if (current?.call?.threadId === threadId && !current.call.persistent) current.end();
    };
  }, [threadId, unavailableReason]);
  // Only a change to disabled ends this chat's call (a connection drop, dictation starting); a chat that opens disabled
  // leaves a call that is already running alone.
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    if (disabled && !wasDisabled.current && liveRef.current?.call?.threadId === threadId) liveRef.current.end();
    wasDisabled.current = disabled;
  }, [disabled, threadId]);
  if (!live || unavailableReason || !available) return null;
  const error = live.error?.threadId === threadId ? live.error.message : "";
  // The same row, buttons and status as dictation, because it is the same kind of control.
  const status = !mine
    ? ""
    : mine.phase === "connecting"
      ? "Connecting…"
      : mine.paused
        ? "Paused"
        : mine.micMuted
          ? "Muted"
          : mine.activity === "speaking"
            ? "Speaking"
            : mine.activity === "working"
              ? "Working on it"
              : mine.activity === "hearing"
                ? "Hearing you"
                : "Listening";
  return (
    <div className="dictation-control">
      <div className="dictation-buttons">
        {!mine ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            aria-label="Start voice chat"
            title={
              persistent
                ? "Voice: talk with Matilda. The call goes on when you open the board."
                : "Voice: talk with Elpis"
            }
            onClick={() => live.start(threadId, persistentRef.current)}
          >
            <AudioLines size={16} />
          </Button>
        ) : (
          <>
            {mine.phase === "listening" && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={mine.micMuted ? "Unmute microphone" : "Mute microphone"}
                title={mine.micMuted ? "Unmute microphone" : "Mute microphone"}
                onClick={() => live.setMicMuted(!mine.micMuted)}
              >
                {mine.micMuted ? <MicOff size={16} /> : <MicIcon size={16} />}
              </Button>
            )}
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="End voice chat"
              title="End voice chat"
              onClick={() => live.end()}
            >
              <PhoneOff size={16} />
            </Button>
          </>
        )}
      </div>
      {mine && (
        <span role="status" className="dictation-status">
          {status}
        </span>
      )}
      {error && (
        <span role="alert" className="dictation-status dictation-error">
          {error}
        </span>
      )}
    </div>
  );
}
