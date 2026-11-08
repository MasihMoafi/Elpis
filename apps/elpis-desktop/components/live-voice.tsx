"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, sessionReady } from "@/lib/api";
import { errorText } from "@/lib/error-text.mts";

type Heard = {
  events: Record<string, number>;
  bytes: number;
  packets: number;
  energy: number;
  mic: number;
  listened: boolean;
  began: number;
};
type Call = {
  threadId: string;
  controller: AbortController;
  peer: RTCPeerConnection | null;
  stream: MediaStream | null;
  audio: HTMLAudioElement | null;
  timer: ReturnType<typeof setTimeout> | null;
  sampler: ReturnType<typeof setInterval> | null;
  heard: Heard;
};
type VoiceEvent = { type: string; sdp?: string; message?: string; role?: string; text?: string; delta?: string };
export type LiveActivity = "" | "hearing" | "working" | "speaking";
/** What the app shows of the call. `persistent` calls (Love Spot's chat, Matilda's) outlive the page they started on. */
export type LiveCallState = {
  threadId: string;
  persistent: boolean;
  phase: "connecting" | "listening";
  activity: LiveActivity;
  said: string;
  micMuted: boolean;
  herMuted: boolean;
  paused: boolean;
};
type LiveVoice = {
  call: LiveCallState | null;
  error: { threadId: string; message: string } | null;
  start: (threadId: string, persistent: boolean) => void;
  end: (message?: string) => void;
  setMicMuted: (muted: boolean) => void;
  setHerMuted: (muted: boolean) => void;
  setPaused: (paused: boolean) => void;
};
const LiveVoiceContext = createContext<LiveVoice | null>(null);
export const useLiveVoice = () => useContext(LiveVoiceContext);

/** The one live voice call, owned above every page (5 Nov: a call started in Love Spot's chat stopped when he opened the
 * board, because the call lived in the chat's composer). The streaming request owns the native call: aborting it ends voice. */
export function LiveVoiceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LiveCallState | null>(null);
  const [error, setError] = useState<LiveVoice["error"]>(null);
  const call = useRef<Call | null>(null),
    stateRef = useRef<LiveCallState | null>(null);
  const quiet = useRef<ReturnType<typeof setTimeout>>(undefined);
  const update = (change: Partial<LiveCallState>) => {
    if (!stateRef.current) return;
    stateRef.current = { ...stateRef.current, ...change };
    setState(stateRef.current);
  };
  const note = (next: Exclude<LiveActivity, "">) => {
    update({ activity: next });
    clearTimeout(quiet.current);
    quiet.current = setTimeout(() => update({ activity: "" }), 2500);
  };
  /** Her voice is heard only when he has neither muted her nor paused the call; the microphone likewise. */
  const apply = () => {
    const current = call.current,
      shown = stateRef.current;
    if (!current || !shown) return;
    current.stream?.getAudioTracks().forEach(track => {
      track.enabled = !shown.micMuted && !shown.paused;
    });
    if (current.audio) current.audio.muted = shown.herMuted || shown.paused;
  };
  function end(message = "") {
    const current = call.current;
    call.current = null;
    const threadId = current?.threadId ?? stateRef.current?.threadId ?? "";
    if (current) {
      current.controller.abort();
      if (current.timer) clearTimeout(current.timer);
      current.stream?.getTracks().forEach(track => track.stop());
      if (current.sampler) clearInterval(current.sampler);
      const heard = current.heard;
      void api("/voice/report", {
        seconds: (Date.now() - heard.began) / 1000,
        listened: heard.listened,
        events: heard.events,
        inboundBytes: heard.bytes,
        inboundPackets: heard.packets,
        inboundEnergy: heard.energy,
        micEnergy: heard.mic,
        error: message,
      }).catch(() => {});
      if (current.peer) {
        current.peer.onconnectionstatechange = null;
        current.peer.ontrack = null;
        current.peer.close();
      }
      if (current.audio) {
        current.audio.muted = true;
        current.audio.pause();
        current.audio.srcObject = null;
      }
    }
    clearTimeout(quiet.current);
    stateRef.current = null;
    setState(null);
    setError(message && threadId ? { threadId, message } : null);
  }
  useEffect(() => {
    const close = () => end();
    window.addEventListener("pagehide", close);
    return () => {
      window.removeEventListener("pagehide", close);
      end();
    };
  }, []);

  async function start(threadId: string, persistent: boolean) {
    if (call.current) end();
    const current: Call = {
      threadId,
      controller: new AbortController(),
      peer: null,
      stream: null,
      audio: null,
      timer: null,
      sampler: null,
      heard: { events: {}, bytes: 0, packets: 0, energy: 0, mic: 0, listened: false, began: Date.now() },
    };
    call.current = current;
    setError(null);
    stateRef.current = {
      threadId,
      persistent,
      phase: "connecting",
      activity: "",
      said: "",
      micMuted: false,
      herMuted: false,
      paused: false,
    };
    setState(stateRef.current);
    current.timer = setTimeout(() => {
      if (call.current === current) end("Voice connection timed out. Try again.");
    }, 35000);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined")
        throw new Error("Voice is unavailable in this window.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (call.current !== current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      current.stream = stream;
      stream.getAudioTracks().forEach(track => {
        track.onended = () => {
          if (call.current === current) end("The microphone disconnected.");
        };
      });
      const peer = new RTCPeerConnection();
      current.peer = peer;
      stream.getTracks().forEach(track => peer.addTrack(track, stream));
      // Codex's realtime peer expects an events data channel alongside the audio tracks.
      const events = peer.createDataChannel("oai-events");
      if (events)
        events.onmessage = message => {
          try {
            const body = JSON.parse(String(message.data)) as {
              type?: string;
              message?: string;
              error?: { message?: string };
              item?: { text?: unknown };
            };
            const type = body.type;
            if (call.current !== current || !type) return;
            current.heard.events[type] = (current.heard.events[type] ?? 0) + 1;
            if (/error/i.test(type))
              setError({
                threadId,
                message: String(body.error?.message ?? body.message ?? "The voice session reported an error.").slice(
                  0,
                  200,
                ),
              });
            else if (type === "input_transcript.added") {
              update({ said: "" });
              note("hearing");
            } else if (type === "delegation.created") note("working");
            // Her words arrive in pieces (`item.text`, codex-api protocol_frameless_bidi.rs); her face reads them (matilda-companion).
            else if (type === "output_transcript.added") {
              update({
                said: `${stateRef.current?.said ?? ""}${typeof body.item?.text === "string" ? body.item.text : ""}`.slice(
                  -400,
                ),
              });
              note("speaking");
            }
          } catch {
            /* An event that is not JSON changes nothing. */
          }
        };
      const audio = new Audio();
      current.audio = audio;
      audio.autoplay = true;
      peer.ontrack = event => {
        if (call.current !== current) {
          event.track.stop();
          return;
        }
        audio.srcObject = new MediaStream([event.track]);
        apply();
        void audio.play().catch(() => {
          if (call.current === current) end("Audio playback was blocked. Start voice again to allow it.");
        });
      };
      peer.onconnectionstatechange = () => {
        if (call.current !== current) return;
        if (peer.connectionState === "connected") {
          if (current.timer) clearTimeout(current.timer);
          current.timer = null;
          current.heard.listened = true;
          update({ phase: "listening" });
          // What came in and went out so far, for the call report: sampled while the peer is still open.
          current.sampler = setInterval(
            () =>
              void Promise.resolve(peer.getStats?.())
                .then(rows => {
                  if (!rows) return;
                  for (const row of rows.values()) {
                    if (row.type === "inbound-rtp" && row.kind === "audio") {
                      current.heard.bytes = row.bytesReceived ?? 0;
                      current.heard.packets = row.packetsReceived ?? 0;
                      current.heard.energy = row.totalAudioEnergy ?? 0;
                    }
                    if (row.type === "media-source" && row.kind === "audio")
                      current.heard.mic = row.totalAudioEnergy ?? 0;
                  }
                })
                .catch(() => {}),
            2000,
          );
        }
        if (["failed", "closed", "disconnected"].includes(peer.connectionState))
          end("Voice disconnected. Start again to reconnect.");
      };
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise<void>((resolve, reject) => {
        if (peer.iceGatheringState === "complete") return resolve();
        const changed = () => {
          if (peer.iceGatheringState === "complete") {
            cleanup();
            resolve();
          }
        };
        const aborted = () => {
          cleanup();
          reject(new DOMException("Ended", "AbortError"));
        };
        const cleanup = () => {
          peer.removeEventListener("icegatheringstatechange", changed);
          current.controller.signal.removeEventListener("abort", aborted);
        };
        peer.addEventListener("icegatheringstatechange", changed);
        current.controller.signal.addEventListener("abort", aborted, { once: true });
        if (current.controller.signal.aborted) aborted();
      });
      if (call.current !== current) return;
      await sessionReady();
      const response = await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, sdp: peer.localDescription?.sdp }),
        signal: current.controller.signal,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result?.error?.message || result?.error || "Voice could not start. Try again.");
      }
      if (!response.body) throw new Error("The voice connection closed.");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let pending = "";
      try {
        while (call.current === current) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 128000) throw new Error("The voice reply could not be read.");
          let newline;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line) as VoiceEvent;
            if (event.type === "sdp" && typeof event.sdp === "string")
              await peer.setRemoteDescription({ type: "answer", sdp: event.sdp });
            if (event.type === "error") throw new Error(event.message || "Voice disconnected.");
            if (event.type === "transcript") {
              if (event.role === "user") {
                update({ said: "" });
                note("hearing");
                if (current.timer) clearTimeout(current.timer);
                current.timer = null;
                // V3 interleaves late user transcripts with the reply. The realtime peer owns barge-in cancellation.
                // A reply he silenced himself (Mute or Pause) is not a missing reply.
                if (event.text) {
                  const energy = current.heard.energy;
                  current.timer = setTimeout(() => {
                    const shown = stateRef.current;
                    if (
                      call.current === current &&
                      !shown?.herMuted &&
                      !shown?.paused &&
                      (audio.paused || current.heard.energy <= energy)
                    )
                      end("Matilda returned no audible reply. End voice and try again.");
                  }, 15000);
                }
              } else if (event.role === "assistant") {
                const said = event.text ?? `${stateRef.current?.said ?? ""}${event.delta ?? ""}`;
                update({ said: said.slice(-400) });
                note("speaking");
              }
            }
            if (event.type === "ended") {
              if (call.current === current) end();
              return;
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (call.current === current) end("The voice call ended.");
    } catch (cause) {
      if (call.current !== current) return;
      end(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Microphone access was denied. Allow it and try again."
          : errorText(cause, "Voice could not start."),
      );
    }
  }
  const value: LiveVoice = {
    call: state,
    error,
    start: (threadId, persistent) => void start(threadId, persistent),
    end,
    setMicMuted: muted => {
      update({ micMuted: muted });
      apply();
    },
    setHerMuted: muted => {
      update({ herMuted: muted });
      apply();
    },
    setPaused: paused => {
      update({ paused });
      apply();
    },
  };
  return <LiveVoiceContext.Provider value={value}>{children}</LiveVoiceContext.Provider>;
}
