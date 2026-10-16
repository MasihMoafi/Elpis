"use client";

import { useEffect, useRef, useState } from "react";
import { MicIcon } from "@/components/elpis-icons";
import { ChevronDown, LoaderCircle, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WhisperTypeSettings } from "@/components/mcp-settings";
import { api } from "@/lib/api";
import type { DictationSelection } from "@/lib/dictation";

type Route = { available: boolean; backend?: string; label?: string; reason?: string };
type VoiceConfig = { version: string; write: { available: boolean; reason?: string }; servers: { name: string; whispertype?: { backend: "openrouter" | "codex" | "local"; model: string | null } }[] };
type Props = { disabled: boolean; selection: () => DictationSelection; onTranscript: (selection: DictationSelection, text: string) => void; onBusy: (busy: boolean) => void };

export function Dictation({ disabled, selection, onTranscript, onBusy }: Props) {
  const [route, setRoute] = useState<Route | null>(null);
  const [phase, setPhase] = useState<"idle" | "preparing" | "recording" | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false), [settings, setSettings] = useState<VoiceConfig | null>(null), [settingsError, setSettingsError] = useState(""), [saving, setSaving] = useState(false);
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
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/tools/transcription", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(); return await response.json() as Route;
    }).then(setRoute).catch(() => { if (!controller.signal.aborted) setRoute({ available: false, reason: "Dictation is unavailable. Check Settings → MCP." }); });
    return () => { controller.abort(); generation.current++; request.current?.abort();
      if (recorder.current?.state === "recording") recorder.current.stop(); release(); };
  }, []);
  useEffect(() => { onBusy(phase !== "idle"); return () => onBusy(false); }, [phase, onBusy]);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  async function openSettings(open: boolean) {
    if (phase !== "idle" || saving) return;
    setSettingsOpen(open); if (!open) return; setSettingsError(""); setSettings(null);
    try { setSettings(await api<VoiceConfig>("/mcp")); } catch (e) { setSettingsError(e instanceof Error ? e.message : String(e)); }
  }
  async function saveSettings(body: Record<string, unknown>) {
    if (!settings || saving) return; setSaving(true);
    try {
      const saved = await api<VoiceConfig>("/mcp", { version: settings.version, name: "whispertype", ...body });
      setSettings(saved);
      const response = await fetch("/api/tools/transcription");
      if (!response.ok) throw Error("Settings saved, but the transcription route could not be refreshed. Reopen transcription settings.");
      setRoute(await response.json()); setSettingsOpen(false);
    } catch (e) { const fresh = await api<VoiceConfig>("/mcp").catch(() => null); if (fresh) setSettings(fresh); throw e; }
    finally { setSaving(false); }
  }

  async function start() {
    if (disabled || settingsOpen || saving || !route?.available || phase !== "idle") return;
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
          const response = await fetch("/api/tools/transcription", { method: "POST", body: audio, headers: { "Content-Type": mimeType, "X-Elpis-Transcription-Backend": route?.backend || "" }, signal: controller.signal });
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
  const label = phase === "recording" ? `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : phase === "transcribing" ? "Transcribing…" : "Opening microphone…";
  return <div className="dictation-control">
    <div className="dictation-buttons">
      <Button type="button" size="icon" variant={active ? "secondary" : "ghost"} disabled={active ? phase !== "recording" : disabled || settingsOpen || !route?.available}
        aria-label={phase === "recording" ? "Stop recording and transcribe" : "Dictate message"} title={active ? label : route?.available ? `Dictate with ${route.label}. Inserts text without sending.` : route?.reason || "Checking dictation…"}
        onClick={() => phase === "recording" ? recorder.current?.stop() : void start()}>
        {phase === "recording" ? <Square size={15} className="text-red-400" /> : active ? <LoaderCircle size={17} className="animate-spin" /> : <MicIcon size={17} />}
      </Button>
      {active && <Button type="button" size="icon" variant="ghost" aria-label="Cancel dictation" onClick={cancel}><X size={15} /></Button>}
    </div>
    <Popover open={settingsOpen} onOpenChange={open => void openSettings(open)}><PopoverTrigger render={<Button type="button" variant="ghost" size="sm" className="dictation-route" aria-label="Transcription settings" disabled={disabled || active || saving} />}><span>{route?.label || "Transcription"}</span><ChevronDown size={12} /></PopoverTrigger><PopoverContent className="transcription-popover"><h3 className="mb-3 text-sm font-semibold">Transcription</h3>
      {settingsError && <p role="alert" className="text-sm text-destructive">{settingsError}</p>}
      {!settings && !settingsError && <p role="status" className="text-sm text-muted-foreground">Reading transcription settings…</p>}
      {settings?.servers.find(server => server.name === "whispertype") ? <WhisperTypeSettings server={settings.servers.find(server => server.name === "whispertype")!} disabled={!settings.write?.available || saving} save={saveSettings} /> : settings && <p className="text-sm text-muted-foreground">Configure WhisperType in Settings → MCP servers to use transcription.</p>}
      {settings?.write?.reason && !settings.write?.available && <p className="mt-2 text-xs text-muted-foreground">{settings.write?.reason}</p>}
    </PopoverContent></Popover>
    <span className={`dictation-status${error ? " dictation-error" : ""}`} role="status">{error || (active ? label : route?.available ? "" : route?.reason || "Checking dictation…")}</span>
  </div>;
}
