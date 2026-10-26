"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, sessionReady } from "@/lib/api";

type Playback = { controller: AbortController; peer: RTCPeerConnection | null; audio: HTMLAudioElement | null; silence: AudioContext | null; timer: ReturnType<typeof setTimeout> | null; monitor: ReturnType<typeof setInterval> | null; soundTimeout: ReturnType<typeof setTimeout> | null; audible: boolean; draining: boolean; energy: number; session?: string; ready: boolean; complete: boolean; idle?: boolean; reply: string };
type Speech = { active: string | null; error: { id: string; message: string } | null; play: (id: string, text: string) => void; stream: (id: string) => void; stop: () => void; warm: () => void };
/** After a read the call stays open this long, so the next Read aloud only sends its text. */
const KEEP_OPEN_MS = 60_000;
const SpeechContext = createContext<Speech | null>(null);
export const useReadAloud = () => useContext(SpeechContext);

/** One player with generated silence as input. Closing its request also retires its native session. */
export function ReadAloud({ threadId, enabled, unavailableReason, children }: { threadId?: string; enabled: boolean; unavailableReason?: string; children: ReactNode }) {
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<Speech["error"]>(null);
  const call = useRef<Playback | null>(null), warmed = useRef("");
  /** Once a chat's reply actions show, its speech thread is made ahead (bridge: warmSpeechThread). */
  function warm() {
    if (!enabled || unavailableReason || !threadId || warmed.current === threadId) return;
    warmed.current = threadId;
    void api("/voice/read-aloud/warm", { threadId }).catch(() => { if (warmed.current === threadId) warmed.current = ""; });
  }
  function stop() {
    const current = call.current; call.current = null;
    if (current) {
      if (current.audio) { current.audio.muted = true; current.audio.pause(); current.audio.srcObject = null; }
      if (current.peer) { current.peer.ontrack = null; current.peer.onconnectionstatechange = null; current.peer.close(); }
      void current.silence?.close().catch(() => {});
      current.controller.abort(); if (current.timer) clearTimeout(current.timer);
      if (current.monitor) clearInterval(current.monitor);
      if (current.soundTimeout) clearTimeout(current.soundTimeout);
    }
    setActive(null);
  }
  useEffect(() => {
    warmed.current = ""; setError(null);
    const close = () => stop(); window.addEventListener("pagehide", close);
    return () => { window.removeEventListener("pagehide", close); stop(); };
  }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!enabled || unavailableReason) stop(); }, [enabled, unavailableReason]); // eslint-disable-line react-hooks/exhaustive-deps

  async function play(id: string, text?: string) {
    if (unavailableReason) return;
    const open = call.current;
    // A call kept open after a read takes this reply's text; it reads it as soon as it arrives.
    if (open?.idle && open.session && text !== undefined && enabled && threadId) {
      if (open.timer) clearTimeout(open.timer);
      Object.assign(open, { idle: false, complete: false, audible: false, draining: false, timer: null, reply: id }); setError(null); setActive(id);
      try {
        const rows = await open.peer?.getStats();
        if (rows) for (const row of rows.values()) if (row.type === "inbound-rtp" && row.kind === "audio") open.energy = row.totalAudioEnergy ?? 0;
        await api("/voice/read-aloud/more", { id: open.session, text }, open.controller.signal); return;
      }
      catch { if (call.current !== open) return; /* The call had ended: start a new one below. */ }
    }
    stop(); setError(null);
    if (!enabled || !threadId) { setError({ id, message: "Reconnect to Elpis before using Read aloud." }); return; }
    const current: Playback = { controller: new AbortController(), peer: null, audio: null, silence: null, timer: null, monitor: null, soundTimeout: null, audible: false, draining: false, energy: 0, ready: false, complete: false, reply: id };
    call.current = current; setActive(id);
    // A call kept open after its reply ends quietly, as when another call takes the speaker.
    const fail = (message: string) => { if (call.current === current) { stop(); if (!current.idle) setError({ id: current.reply, message }); } };
    const finish = () => {
      if (!current.complete || !current.audible || current.draining) return;
      current.draining = true;
      current.timer = setTimeout(() => {
        if (call.current !== current) return;
        current.idle = true; setActive(null);
        current.timer = setTimeout(() => { if (call.current === current) stop(); }, KEEP_OPEN_MS);
      }, 1500);
    };
    // A transcript/append acknowledgement is not playback. Check sound and an advancing player only while awaiting it.
    const watchPlayback = () => {
      if (current.audible || current.monitor) return;
      current.soundTimeout = setTimeout(() => fail("Voice returned no audible audio. Stop and try again."), 15000);
      current.monitor = setInterval(() => {
        void current.peer?.getStats().then(rows => {
          if (call.current !== current || !current.audio || current.audio.paused || current.audio.currentTime <= 0) return;
          const audible = [...rows.values()].some(row => row.type === "inbound-rtp" && row.kind === "audio" && (row.totalAudioEnergy ?? 0) > current.energy + 0.000001);
          if (!audible) return;
          current.audible = true;
          if (current.monitor) clearInterval(current.monitor); current.monitor = null;
          if (current.soundTimeout) clearTimeout(current.soundTimeout); current.soundTimeout = null;
          finish();
        }).catch(() => {});
      }, 200);
    };
    const ready = () => {
      if (call.current !== current || current.ready || !current.session || current.peer?.connectionState !== "connected") return;
      current.ready = true;
      void api("/voice/read-aloud/ready", { id: current.session }, current.controller.signal).catch(cause => fail(cause instanceof Error ? cause.message : "Read aloud could not start."));
    };
    current.timer = setTimeout(() => fail("Read aloud connection timed out. Try again."), 35000);
    try {
      if (typeof RTCPeerConnection === "undefined") throw new Error("Read aloud is unavailable in this window.");
      const peer = new RTCPeerConnection(); current.peer = peer;
      // Generated input, never the microphone. A local cue asks the speech-driven model to read each supplied chunk.
      const silence = new AudioContext(); current.silence = silence;
      const quiet = silence.createGain(); quiet.gain.value = 0;
      const source = silence.createOscillator(), sink = silence.createMediaStreamDestination();
      source.connect(quiet).connect(sink); source.start();
      // The cue loads while the call is set up; it is first needed once the call is connected.
      const cueBuffer = fetch("/read-aloud-cue.ogg", { signal: current.controller.signal }).then(async response => {
        if (!response.ok) throw new Error("The voice playback cue could not load.");
        return silence.decodeAudioData(await response.arrayBuffer());
      });
      cueBuffer.catch(() => {});
      void silence.resume().catch(() => {});
      const cue = () => void cueBuffer.then(buffer => {
        if (call.current !== current) return;
        const trigger = silence.createBufferSource(); trigger.buffer = buffer;
        trigger.connect(sink); trigger.start();
      }).catch(cause => fail(cause instanceof Error ? cause.message : "The voice playback cue could not load."));
      peer.addTransceiver(sink.stream.getAudioTracks()[0], { direction: "sendrecv" });
      const events = peer.createDataChannel("oai-events");
      events.onmessage = message => {
        if (call.current !== current) return;
        try {
          const event = JSON.parse(String(message.data)) as { type?: string };
          if (event.type === "error" || event.type === "delegation.created") fail("Read aloud could not deliver this reply. Stop and try again explicitly.");
        } catch { /* Non-JSON transport events carry no playback state. */ }
      };
      const audio = new Audio(); current.audio = audio; audio.autoplay = true;
      peer.ontrack = event => {
        if (call.current !== current) { event.track.stop(); return; }
        audio.srcObject = new MediaStream([event.track]);
        event.track.onended = () => { if (call.current === current) { if (current.complete) stop(); else fail("Read aloud disconnected before finishing."); } };
        void audio.play().catch(() => fail("Audio playback was blocked. Press Read aloud to try again."));
      };
      peer.onconnectionstatechange = () => {
        if (call.current !== current) return;
        if (peer.connectionState === "connected") { if (current.timer) clearTimeout(current.timer); current.timer = null; ready(); }
        if (["closed", "failed", "disconnected"].includes(peer.connectionState)) fail("Read aloud disconnected. Try again explicitly.");
      };
      await peer.setLocalDescription(await peer.createOffer());
      if (call.current !== current) return;
      await new Promise<void>((resolve, reject) => {
        if (peer.iceGatheringState === "complete") return resolve();
        const cleanup = () => { peer.removeEventListener("icegatheringstatechange", changed); current.controller.signal.removeEventListener("abort", aborted); };
        const changed = () => { if (peer.iceGatheringState === "complete") { cleanup(); resolve(); } };
        const aborted = () => { cleanup(); reject(new DOMException("Stopped", "AbortError")); };
        peer.addEventListener("icegatheringstatechange", changed); current.controller.signal.addEventListener("abort", aborted, { once: true });
        if (current.controller.signal.aborted) aborted();
      });
      await sessionReady(); if (call.current !== current) return;
      const response = await fetch(text === undefined ? "/api/love-spot/voice" : "/api/voice/read-aloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(text === undefined ? {} : { threadId, text }), sdp: peer.localDescription?.sdp }), signal: current.controller.signal });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result?.error?.message || result?.error || "Read aloud could not start."); }
      if (!response.body) throw new Error("Read aloud disconnected.");
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "";
      try {
        while (call.current === current) {
          const { done, value } = await reader.read(); if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 128000) throw new Error("The Read aloud connection could not be read.");
          let newline;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (!line.trim() || call.current !== current) continue;
            const event = JSON.parse(line) as { type: string; id?: string; sdp?: string; message?: string };
            if (event.type === "session") { current.session = event.id; ready(); }
            if (event.type === "sdp" && event.sdp) await peer.setRemoteDescription({ type: "answer", sdp: event.sdp });
            if (event.type === "cue") { watchPlayback(); cue(); }
            if (event.type === "error") throw new Error(event.message || "Read aloud failed.");
            if (event.type === "stopped") stop();
            // The last transcript ends with its audio; a moment later the reply is done, and the call stays open a minute.
            if (event.type === "complete") {
              current.complete = true;
              watchPlayback(); finish();
            }
            if (event.type === "ended") throw new Error("Read aloud ended. Try again explicitly.");
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (call.current === current) fail("Read aloud disconnected.");
    } catch (cause) { fail(cause instanceof Error ? cause.message : "Read aloud could not start."); }
  }
  return <SpeechContext.Provider value={unavailableReason ? null : { active, error, play: (id, text) => void play(id, text), stream: id => void play(id), stop, warm }}>{children}</SpeechContext.Provider>;
}
