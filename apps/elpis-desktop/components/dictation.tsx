"use client";

import { useEffect, useRef, useState } from "react";
import { MicIcon, StopIcon } from "@/components/elpis-icons";
import { LoaderCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DictationSelection } from "@/lib/dictation";

type Route = { available: boolean; backend?: string; label?: string; reason?: string };
/** `provider` is the chat's provider (see chatProvider): the bridge picks the transcriber that provider uses, or the Settings → Voice fallback. */
type Props = { disabled: boolean; provider: string; selection: () => DictationSelection; onTranscript: (selection: DictationSelection, text: string) => void; onBusy: (busy: boolean) => void; purpose?: string };

export function Dictation({ disabled, provider, selection, onTranscript, onBusy, purpose = "Inserts text without sending." }: Props) {
  const [route, setRoute] = useState<Route | null>(null);
  const [phase, setPhase] = useState<"idle" | "preparing" | "recording" | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const callbacks = useRef({ selection, onTranscript }); callbacks.current = { selection, onTranscript };

  const release = () => {
    if (timer.current) clearInterval(timer.current); timer.current = null;
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
  };
  const cancel = () => {
    generation.current++; request.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.stop();
    release(); recorder.current = null; setPhase("idle");
  };
  // The transcriber belongs to the chat's provider, so it is asked for again whenever the chat or its model's provider changes.
  const providerQuery = `?provider=${encodeURIComponent(provider)}`;
  useEffect(() => {
    const controller = new AbortController(); setRoute(null);
    fetch(`/api/tools/transcription${providerQuery}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(); return await response.json() as Route;
    }).then(setRoute).catch(() => { if (!controller.signal.aborted) setRoute({ available: false, reason: "Dictation is unavailable. Check Settings → MCP." }); });
    return () => controller.abort();
  }, [providerQuery]);
  useEffect(() => () => { generation.current++; request.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.stop(); release(); }, []);
  useEffect(() => { onBusy(phase !== "idle"); return () => onBusy(false); }, [phase, onBusy]);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);

  async function start() {
    if (disabled || !route?.available || phase !== "idle") return;
    const token = ++generation.current; const insertion = callbacks.current.selection();
    setError(""); setSeconds(0); setPhase("preparing"); onBusy(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This window does not support microphone recording.");
      const source = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (token !== generation.current) { source.getTracks().forEach(track => track.stop()); return; }
      stream.current = source;
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("No supported recording format is available.");
      const recording = new MediaRecorder(source, { mimeType, audioBitsPerSecond: 64000 }); recorder.current = recording;
      const chunks: Blob[] = []; let size = 0;
      recording.ondataavailable = event => {
        if (!event.data.size) return; size += event.data.size;
        if (size > 8 * 1024 * 1024) { cancel(); setError("The recording is too large. Try a shorter recording."); }
        else chunks.push(event.data);
      };
      recording.onerror = () => { cancel(); setError("The microphone stopped. Your draft is unchanged."); };
      recording.onstop = async () => {
        if (token !== generation.current) return;
        release();
        setPhase("transcribing"); const controller = new AbortController(); request.current = controller;
        try {
          const audio = new Blob(chunks, { type: mimeType });
          if (!audio.size) throw new Error("The recording is empty. Try again.");
          const response = await fetch(`/api/tools/transcription${providerQuery}`, { method: "POST", body: audio, headers: { "Content-Type": mimeType, "X-Elpis-Transcription-Backend": route?.backend || "" }, signal: controller.signal });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Transcription failed.");
          if (token !== generation.current) return;
          if (typeof result.text !== "string" || !result.text.trim()) throw new Error("No speech was recognized. Your draft is unchanged.");
          callbacks.current.onTranscript(insertion, result.text);
        } catch (cause) {
          if (token === generation.current) setError(cause instanceof Error ? cause.message : "Transcription failed. Your draft is unchanged.");
        } finally { if (token === generation.current) { request.current = null; recorder.current = null; setPhase("idle"); } }
      };
      recording.start(250); setPhase("recording"); const started = Date.now();
      timer.current = setInterval(() => { const elapsed = Math.floor((Date.now() - started) / 1000); setSeconds(elapsed);
        if (elapsed >= 119 && recording.state === "recording") recording.stop(); }, 250);
    } catch (cause) {
      if (token !== generation.current) return;
      release(); setPhase("idle");
      setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your system settings and try again." : cause instanceof Error ? cause.message : "The microphone could not start.");
    }
  }

  const active = phase !== "idle";
  // Without a usable transcriber the button stays focusable and hoverable so its title can say why; a click shows the same reason.
  const unavailable = !active && !route?.available, reason = route?.reason || "Checking dictation…";
  const label = phase === "recording" ? `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : phase === "transcribing" ? "Transcribing…" : "Opening microphone…";
  return <div className="dictation-control">
    <div className="dictation-buttons">
      <Button type="button" size="icon" variant={active ? "secondary" : "ghost"} disabled={active ? phase !== "recording" : disabled} aria-disabled={unavailable || undefined} className={unavailable ? "opacity-50" : undefined}
        aria-label={phase === "recording" ? "Stop recording and transcribe" : "Dictate message"} title={active ? label : route?.available ? `Dictate with ${route.label}. ${purpose}` : reason}
        onClick={() => phase === "recording" ? recorder.current?.stop() : unavailable ? setError(reason) : void start()}>
        {phase === "recording" ? <StopIcon size={15} className="text-red-400" /> : active ? <LoaderCircle size={17} className="animate-spin" /> : <MicIcon size={17} />}
      </Button>
      {active && <Button type="button" size="icon" variant="ghost" aria-label="Cancel dictation" onClick={cancel}><X size={15} /></Button>}
    </div>
    <span className={`dictation-status${error ? " dictation-error" : ""}`} role="status">{error || (active ? label : "")}</span>
  </div>;
}
