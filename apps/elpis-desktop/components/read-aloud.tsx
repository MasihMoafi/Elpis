"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, sessionReady } from "@/lib/api";

type Playback = { controller: AbortController; peer: RTCPeerConnection | null; audio: HTMLAudioElement | null; silence: AudioContext | null; timer: ReturnType<typeof setTimeout> | null; session?: string; ready: boolean; complete: boolean };
type Speech = { active: string | null; error: { id: string; message: string } | null; play: (id: string, text: string) => void; stream: (id: string) => void; stop: () => void };
const SpeechContext = createContext<Speech | null>(null);
export const useReadAloud = () => useContext(SpeechContext);

/** One player with generated silence as input. Closing its request also retires its native session. */
export function ReadAloud({ threadId, enabled, children }: { threadId: string; enabled: boolean; children: ReactNode }) {
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<Speech["error"]>(null);
  const call = useRef<Playback | null>(null);
  function stop() {
    const current = call.current; call.current = null;
    if (current) {
      if (current.audio) { current.audio.muted = true; current.audio.pause(); current.audio.srcObject = null; }
      if (current.peer) { current.peer.ontrack = null; current.peer.onconnectionstatechange = null; current.peer.close(); }
      void current.silence?.close().catch(() => {});
      current.controller.abort(); if (current.timer) clearTimeout(current.timer);
    }
    setActive(null);
  }
  useEffect(() => {
    const close = () => stop(); window.addEventListener("pagehide", close);
    return () => { window.removeEventListener("pagehide", close); stop(); };
  }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!enabled) stop(); }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  async function play(id: string, text?: string) {
    stop(); setError(null);
    if (!enabled) { setError({ id, message: "Reconnect to Elpis before using Read aloud." }); return; }
    const current: Playback = { controller: new AbortController(), peer: null, audio: null, silence: null, timer: null, ready: false, complete: false };
    call.current = current; setActive(id);
    const fail = (message: string) => { if (call.current === current) { stop(); setError({ id, message }); } };
    const ready = () => {
      if (call.current !== current || current.ready || !current.session || current.peer?.connectionState !== "connected") return;
      current.ready = true;
      void api("/voice/read-aloud/ready", { id: current.session }, current.controller.signal).catch(cause => fail(cause instanceof Error ? cause.message : "Read aloud could not start."));
    };
    current.timer = setTimeout(() => fail("Read aloud connection timed out. Try again."), 35000);
    try {
      if (typeof RTCPeerConnection === "undefined") throw new Error("Read aloud is unavailable in this window.");
      const peer = new RTCPeerConnection(); current.peer = peer;
      // Generated silence, not the microphone: the voice model only speaks while audio comes in (23 Oct live check).
      const silence = new AudioContext(); current.silence = silence;
      const quiet = silence.createGain(); quiet.gain.value = 0;
      const source = silence.createOscillator(), sink = silence.createMediaStreamDestination();
      source.connect(quiet).connect(sink); source.start();
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
            if (event.type === "error") throw new Error(event.message || "Read aloud failed.");
            if (event.type === "stopped") stop();
            // The last transcript ends with its audio; a moment later the player is done.
            if (event.type === "complete") { current.complete = true; current.timer = setTimeout(() => { if (call.current === current) stop(); }, 1500); }
            if (event.type === "ended") throw new Error("Read aloud ended. Try again explicitly.");
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (call.current === current) fail("Read aloud disconnected.");
    } catch (cause) { fail(cause instanceof Error ? cause.message : "Read aloud could not start."); }
  }
  return <SpeechContext.Provider value={{ active, error, play: (id, text) => void play(id, text), stream: id => void play(id), stop }}>{children}</SpeechContext.Provider>;
}
