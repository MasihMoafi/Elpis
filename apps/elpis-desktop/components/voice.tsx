"use client";

import { useEffect, useRef, useState } from "react";
import { AudioLines, MicOff, Mic, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { api, sessionReady } from "@/lib/api";

type Heard = { events: Record<string, number>; bytes: number; packets: number; energy: number; mic: number; listened: boolean; began: number };
type Call = { controller: AbortController; peer: RTCPeerConnection | null; stream: MediaStream | null; audio: HTMLAudioElement | null; timer: ReturnType<typeof setTimeout> | null; sampler: ReturnType<typeof setInterval> | null; heard: Heard };
type VoiceEvent = { type: string; sdp?: string; message?: string; role?: string; text?: string; delta?: string };

/** The streaming request owns the native call: aborting it ends voice even if this window disappears. */
export function Voice({ threadId, disabled, onBusy, persona, unavailableReason }: { threadId: string; disabled: boolean; onBusy: (busy: boolean) => void; persona?: string; unavailableReason?: string }) {
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<"idle" | "connecting" | "listening">("idle");
  const [muted, setMuted] = useState(false);
  // What the call is doing right now, from the events the call sends: "Listening" alone cannot tell whether it hears the person or is about to answer.
  const [activity, setActivity] = useState<"" | "hearing" | "working" | "speaking">("");
  const quiet = useRef<ReturnType<typeof setTimeout>>(undefined);
  const note = (next: "hearing" | "working" | "speaking") => { setActivity(next); clearTimeout(quiet.current); quiet.current = setTimeout(() => setActivity(""), 2500); };
  const [error, setError] = useState("");
  const call = useRef<Call | null>(null);
  const busyCallback = useRef(onBusy); busyCallback.current = onBusy;
  function end(message = "") {
    const current = call.current; call.current = null;
    if (current) {
      current.controller.abort(); if (current.timer) clearTimeout(current.timer);
      current.stream?.getTracks().forEach(track => track.stop());
      if (current.sampler) clearInterval(current.sampler);
      const heard = current.heard; void api("/voice/report", { seconds: (Date.now() - heard.began) / 1000, listened: heard.listened, events: heard.events, inboundBytes: heard.bytes, inboundPackets: heard.packets, inboundEnergy: heard.energy, micEnergy: heard.mic, error: message }).catch(() => {});
      if (current.peer) { current.peer.onconnectionstatechange = null; current.peer.ontrack = null; current.peer.close(); }
      if (current.audio) { current.audio.muted = true; current.audio.pause(); current.audio.srcObject = null; }
    }
    clearTimeout(quiet.current); setActivity("");
    setPhase("idle"); setMuted(false); setError(message); busyCallback.current(false);
  }
  useEffect(() => {
    const controller = new AbortController();
    if (!unavailableReason) api<{ available: boolean }>("/voice", undefined, controller.signal).then(result => { if (!controller.signal.aborted) setAvailable(result.available === true); }).catch(() => {});
    return () => { controller.abort(); end(); };
  }, [threadId, unavailableReason]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (disabled) end(); }, [disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    if (disabled || unavailableReason || !available || call.current) return;
    const current: Call = { controller: new AbortController(), peer: null, stream: null, audio: null, timer: null, sampler: null, heard: { events: {}, bytes: 0, packets: 0, energy: 0, mic: 0, listened: false, began: Date.now() } };
    call.current = current; setError(""); setPhase("connecting"); busyCallback.current(true);
    current.timer = setTimeout(() => { if (call.current === current) end("Voice connection timed out. Try again."); }, 35000);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error("Voice is unavailable in this window.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (call.current !== current) { stream.getTracks().forEach(track => track.stop()); return; }
      current.stream = stream;
      stream.getAudioTracks().forEach(track => { track.onended = () => { if (call.current === current) end("The microphone disconnected."); }; });
      const peer = new RTCPeerConnection(); current.peer = peer;
      stream.getTracks().forEach(track => peer.addTrack(track, stream));
      // Codex's realtime peer expects an events data channel alongside the audio tracks.
      const events = peer.createDataChannel("oai-events");
      if (events) events.onmessage = message => {
        try {
          const body = JSON.parse(String(message.data)) as { type?: string; message?: string; error?: { message?: string } };
          const type = body.type;
          if (call.current !== current || !type) return;
          current.heard.events[type] = (current.heard.events[type] ?? 0) + 1;
          if (/error/i.test(type)) setError(String(body.error?.message ?? body.message ?? "The voice session reported an error.").slice(0, 200));
          else if (type === "input_transcript.added") note("hearing"); else if (type === "delegation.created") note("working"); else if (type === "output_transcript.added") note("speaking");
        } catch { /* An event that is not JSON changes nothing. */ }
      };
      const audio = new Audio(); current.audio = audio; audio.autoplay = true;
      peer.ontrack = event => {
        if (call.current !== current) { event.track.stop(); return; }
        audio.srcObject = new MediaStream([event.track]);
        void audio.play().catch(() => { if (call.current === current) end("Audio playback was blocked. Start voice again to allow it."); });
      };
      peer.onconnectionstatechange = () => {
        if (call.current !== current) return;
        if (peer.connectionState === "connected") {
          if (current.timer) clearTimeout(current.timer); current.timer = null; current.heard.listened = true; setPhase("listening");
          // What came in and went out so far, for the call report: sampled while the peer is still open.
          current.sampler = setInterval(() => void Promise.resolve(peer.getStats?.()).then(rows => { if (!rows) return; for (const row of rows.values()) {
            if (row.type === "inbound-rtp" && row.kind === "audio") { current.heard.bytes = row.bytesReceived ?? 0; current.heard.packets = row.packetsReceived ?? 0; current.heard.energy = row.totalAudioEnergy ?? 0; }
            if (row.type === "media-source" && row.kind === "audio") current.heard.mic = row.totalAudioEnergy ?? 0;
          } }).catch(() => {}), 2000);
        }
        if (["failed", "closed", "disconnected"].includes(peer.connectionState)) end("Voice disconnected. Start again to reconnect.");
      };
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise<void>((resolve, reject) => {
        if (peer.iceGatheringState === "complete") return resolve();
        const changed = () => { if (peer.iceGatheringState === "complete") { cleanup(); resolve(); } };
        const aborted = () => { cleanup(); reject(new DOMException("Ended", "AbortError")); };
        const cleanup = () => { peer.removeEventListener("icegatheringstatechange", changed); current.controller.signal.removeEventListener("abort", aborted); };
        peer.addEventListener("icegatheringstatechange", changed); current.controller.signal.addEventListener("abort", aborted, { once: true });
        if (current.controller.signal.aborted) aborted();
      });
      if (call.current !== current) return;
      await sessionReady();
      const response = await fetch(persona === undefined ? "/api/voice" : "/api/love-spot/voice/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(persona === undefined ? { threadId } : { persona }), sdp: peer.localDescription?.sdp }), signal: current.controller.signal });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result?.error?.message || result?.error || "Voice could not start. Try again."); }
      if (!response.body) throw new Error("The voice connection closed.");
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "";
      try {
        while (call.current === current) {
          const { value, done } = await reader.read(); if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 128000) throw new Error("The voice reply could not be read.");
          let newline;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line) as VoiceEvent;
            if (event.type === "sdp" && typeof event.sdp === "string") await peer.setRemoteDescription({ type: "answer", sdp: event.sdp });
            if (event.type === "error") throw new Error(event.message || "Voice disconnected.");
            if (event.type === "transcript") {
              if (event.role === "user") {
                note("hearing");
                if (current.timer) clearTimeout(current.timer); current.timer = null;
                // V3 interleaves late user transcripts with the reply. The realtime peer owns barge-in cancellation.
                if (event.text) {
                  const energy = current.heard.energy;
                  current.timer = setTimeout(() => { if (call.current === current && (audio.muted || audio.paused || current.heard.energy <= energy)) end("Matilda returned no audible reply. End voice and try again."); }, 15000);
                }
              } else if (event.role === "assistant") note("speaking");
            }
            if (event.type === "ended") { if (call.current === current) end(); return; }
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (call.current === current) end("The voice call ended.");
    } catch (cause) {
      if (call.current !== current) return;
      end(cause instanceof DOMException && cause.name === "NotAllowedError" ? "Microphone access was denied. Allow it and try again." : cause instanceof Error ? cause.message : "Voice could not start.");
    }
  }
  if (unavailableReason) return <Tooltip content={unavailableReason}><Button type="button" size="icon" variant="ghost" className="opacity-50" aria-label="Voice unavailable" disabled focusableWhenDisabled title={unavailableReason}><AudioLines size={17} /></Button></Tooltip>;
  if (!available) return null;
  const active = phase !== "idle";
  // The same row, buttons and status as dictation, because it is the same kind of control.
  const status = phase === "connecting" ? "Connecting…" : muted ? "Muted" : activity === "speaking" ? "Speaking" : activity === "working" ? "Working on it" : activity === "hearing" ? "Hearing you" : "Listening";
  return <div className="dictation-control">
    <div className="dictation-buttons">
      {!active ? <Button type="button" size="icon" variant="ghost" disabled={disabled} aria-label="Start voice chat" title="Voice: talk with Elpis" onClick={() => void start()}><AudioLines size={17} /></Button> : <>
        {phase === "listening" && <Button type="button" size="icon" variant="ghost" aria-label={muted ? "Unmute microphone" : "Mute microphone"} title={muted ? "Unmute microphone" : "Mute microphone"} onClick={() => { const next = !muted; call.current?.stream?.getAudioTracks().forEach(track => { track.enabled = !next; }); setMuted(next); }}>{muted ? <MicOff size={17} /> : <Mic size={17} />}</Button>}
        <Button type="button" size="icon" variant="ghost" aria-label="End voice chat" title="End voice chat" onClick={() => end()}><PhoneOff size={17} /></Button>
      </>}
    </div>
    {active && <span role="status" className="dictation-status">{status}</span>}
    {error && <span role="alert" className="dictation-status dictation-error">{error}</span>}
  </div>;
}
