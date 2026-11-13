"use client";
import { useEffect, useRef, useState } from "react";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { OptionSelect } from "@/components/ui/option-select";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dictation } from "@/components/dictation";
import { api } from "@/lib/api";
import { errorText } from "@/lib/error-text.mts";
import { insertTranscript } from "@/lib/dictation";
import { CHARACTER_LIMITS, type CharacterGeneration, type PortraitSources } from "@/lib/custom-character-types.mts";
import { saveCustomCharacter } from "@/lib/custom-characters";
import { characterChoice } from "@/lib/character-choice.mts";
import { savePreferences, usePreferences } from "@/lib/preferences";
import { BUILT_IN_THEMES, parseCustomThemes } from "@/lib/theme-palettes";

/** Where a message belongs: each one is shown at the part of the form it is about. */
type Place = "source" | "generate" | "portrait" | "save";
const hint = "text-sm text-muted-foreground";
const fault = "whitespace-pre-wrap break-words text-sm text-destructive";

/** One editable draft of a new character. She starts without a face: the portrait is the one generated or the
 * image he chooses, never a saved character's. Closing it releases dictation and cancels every request. */
export function CreateCharacterDialog({ onClose }: { onClose: () => void }) {
  const preferences = usePreferences();
  const [description, setDescription] = useState(""), [name, setName] = useState(""), [personality, setPersonality] = useState("");
  const [sources, setSources] = useState<PortraitSources | null>(null), [sourceId, setSourceId] = useState("");
  const [result, setResult] = useState<CharacterGeneration | null>(null), [portrait, setPortrait] = useState<"generated" | "uploaded" | null>(null), [uploaded, setUploaded] = useState("");
  const [theme, setTheme] = useState("keep"), [busy, setBusy] = useState<"generate" | "upload" | "save" | null>(null), [dictating, setDictating] = useState(false), [error, setError] = useState<{ at: Place; text: string } | null>(null), [notice, setNotice] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null), request = useRef<AbortController | null>(null), generation = useRef(0), job = useRef<string | null>(null);
  const fail = (at: Place, cause: unknown, fallback: string) => setError({ at, text: errorText(cause, fallback) });
  useEffect(() => {
    const controller = new AbortController();
    void api<PortraitSources>("/characters/sources", undefined, controller.signal).then(setSources).catch(cause => { if (!controller.signal.aborted) { setSources({ sources: [], unavailable: [] }); fail("source", cause, "Image sources could not be checked."); } });
    return () => { controller.abort(); generation.current++; request.current?.abort(); if (job.current) void api("/characters/stop", { id: job.current }).catch(() => {}); };
  }, []);
  function stop() {
    generation.current++; request.current?.abort();
    if (job.current) void api("/characters/stop", { id: job.current }).catch(cause => fail("generate", cause, "The generation could not be stopped."));
    job.current = null; setBusy(null); setNotice("Stopped. Your draft is kept.");
  }
  async function generate() {
    const ticket = ++generation.current, id = crypto.randomUUID(), controller = new AbortController();
    request.current = controller; job.current = id; setBusy("generate"); setError(null); setNotice("");
    try {
      const made = await api<CharacterGeneration>("/characters/generate", { id, description, ...(sourceId ? { sourceId } : {}) }, controller.signal);
      if (ticket !== generation.current) return;
      setResult(made); setName(made.name); setPersonality(made.personality); setPortrait("generated");
      setNotice([`Created with ${made.source.label}.`, ...made.warnings].join("\n"));
    } catch (cause) { if (ticket === generation.current) fail("generate", cause, "Character generation failed."); }
    finally { if (ticket === generation.current) { setBusy(null); job.current = null; } }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > CHARACTER_LIMITS.imageBytes) { setError({ at: "portrait", text: "Choose an image of at most 4 MiB." }); return; }
    const ticket = ++generation.current, controller = new AbortController(); request.current = controller; setBusy("upload"); setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(Error("Image could not be read.")); reader.onerror = () => reject(Error("Image could not be read.")); reader.readAsDataURL(file); });
      if (ticket !== generation.current) return;
      const normalized = await api<{ image: string }>("/characters/portrait", { dataUrl }, controller.signal);
      if (ticket === generation.current) { setUploaded(normalized.image); setPortrait("uploaded"); }
    } catch (cause) { if (ticket === generation.current) fail("portrait", cause, "Portrait could not be loaded."); }
    finally { if (ticket === generation.current) setBusy(null); }
  }
  const image = portrait === "generated" ? result?.image : portrait === "uploaded" ? uploaded : undefined;
  async function save() {
    if (!image) return;
    setBusy("save"); setError(null);
    try {
      const character = await saveCustomCharacter({ name, description, personality: personality.trim() || description, themeId: theme === "keep" ? null : theme === "suggested" ? result?.suggestedThemeId ?? null : theme, portrait: { dataUrl: image } });
      savePreferences(characterChoice(character.id, [character])); onClose();
    } catch (cause) { fail("save", cause, "Character could not be saved."); setBusy(null); }
  }
  const disabled = busy !== null;
  // Each reason Save is off sits under its own field; Save names them for screen readers.
  const reasons = {
    "character-description-hint": !description.trim() ? "Describe your character first." : dictating ? "Finish dictation first." : "",
    "character-name-hint": !name.trim() ? "Give your character a name." : "",
    "character-portrait-hint": !image ? "Choose an image for her face." : "",
  };
  const missing = Object.entries(reasons).filter(([, reason]) => reason).map(([id]) => id);
  const reasonAt = (id: keyof typeof reasons) => reasons[id] ? <p id={id} className={hint}>{reasons[id]}</p> : null;
  const errorAt = (at: Place) => error?.at === at ? <p role="alert" className={fault}>{error.text}</p> : null;
  const themes = [...BUILT_IN_THEMES, ...parseCustomThemes(preferences.customThemes)];
  return <AlertDialog open onOpenChange={open => { if (!open && busy !== "save") onClose(); }}>
    <AlertDialogContent role="dialog" className="max-h-[90dvh] overflow-y-auto">
      <AlertDialogHeader><AlertDialogTitle>Create your own</AlertDialogTitle><AlertDialogDescription>Describe who she is and how she talks. Preview her before saving.</AlertDialogDescription></AlertDialogHeader>
      <div className="grid gap-2">
        <label htmlFor="character-description" className="text-sm">Description</label>
        <Textarea ref={textarea} id="character-description" rows={3} className="max-h-40" maxLength={CHARACTER_LIMITS.description} value={description} disabled={disabled} aria-describedby={reasons["character-description-hint"] ? "character-description-hint" : undefined} placeholder="A curious astronomer with violet hair who explains things patiently…" onChange={event => setDescription(event.target.value)} autoFocus />
        {reasonAt("character-description-hint")}
        <Dictation disabled={disabled} provider={sources?.sources.find(source => source.id === sourceId)?.provider ?? ""} selection={() => ({ text: description, start: textarea.current?.selectionStart ?? description.length, end: textarea.current?.selectionEnd ?? description.length })} onTranscript={(selection, text) => { const next = insertTranscript(description, selection, text); setDescription(next.text.slice(0, CHARACTER_LIMITS.description)); }} onBusy={setDictating} purpose="Describe your character without sending." />
        <label htmlFor="character-source" className="text-sm">Draw with</label>
        <OptionSelect id="character-source" aria-label="Portrait source" value={sourceId} disabled={disabled || !sources?.sources.length} onChange={event => setSourceId(event.target.value)}>
          <option value="">{sources === null ? "Checking your connections…" : sources.sources.length ? "Automatic · try available sources" : "No image source available"}</option>
          {sources?.sources.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}
        </OptionSelect>
        {errorAt("source")}
        {sources?.sources.length === 0 && <p className={hint}>Add an image connection in Settings → Models &amp; accounts. You can still choose an image for her face below and save.</p>}
        {sources?.sources.length === 0 && sources.unavailable.length > 0 && <p className={`max-h-24 overflow-y-auto whitespace-pre-wrap break-words ${hint}`}>{sources.unavailable.join("\n")}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={disabled || dictating || !description.trim() || !sources?.sources.length} title={!description.trim() ? "Describe your character first." : !sources?.sources.length ? "Connect an image source in Models & accounts, or choose an image below." : undefined} onClick={() => void generate()}>{result ? "Try again" : "Create character"}</Button>
          {(busy === "generate" || busy === "upload") && <Button variant="outline" onClick={stop}>Stop</Button>}
          <span role="status" className={hint}>{busy === "generate" ? "Creating her portrait and personality…" : busy === "upload" ? "Checking portrait…" : ""}</span>
        </div>
        {errorAt("generate")}
        {notice && <p role="status" className={`whitespace-pre-wrap break-words ${hint}`}>{notice}</p>}
      </div>
      <div className="grid gap-2">
        <div className="flex items-center gap-3">
          <span className="relative block size-20 shrink-0">{image
            ? <img src={image} alt="Character preview" className="size-full object-contain [image-rendering:pixelated]" />
            : <span role="img" aria-label="No portrait yet" data-empty-portrait className="flex size-full items-center justify-center rounded-md border border-dashed border-border text-muted-foreground"><UserRound aria-hidden className="size-8" /></span>}</span>
          <div className="grid min-w-0 flex-1 gap-2">
            <label htmlFor="character-name" className="text-sm">Name</label>
            <Input id="character-name" value={name} maxLength={CHARACTER_LIMITS.name} disabled={disabled} aria-describedby={reasons["character-name-hint"] ? "character-name-hint" : undefined} onChange={event => setName(event.target.value)} placeholder="Her name" />
            {reasonAt("character-name-hint")}
          </div>
        </div>
        <Input type="file" aria-label="Choose portrait image" aria-describedby={reasons["character-portrait-hint"] ? "character-portrait-hint" : undefined} accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
        {reasonAt("character-portrait-hint")}
        {errorAt("portrait")}
        <label htmlFor="character-personality" className="text-sm">How she talks</label>
        <Textarea id="character-personality" rows={2} className="max-h-32" maxLength={CHARACTER_LIMITS.personality} value={personality} disabled={disabled} onChange={event => setPersonality(event.target.value)} placeholder="Uses your description until you write her a different way of working." />
        <label htmlFor="character-theme" className="text-sm">Theme</label>
        <OptionSelect id="character-theme" aria-label="Character theme" value={theme} disabled={disabled} onChange={event => setTheme(event.target.value)}>
          <option value="keep">Keep my current theme</option>
          {result?.suggestedThemeId && <option value="suggested">Suggested · {themes.find(item => item.id === result.suggestedThemeId)?.name ?? "Elpis"}</option>}
          <option value="elpis">Elpis</option>{themes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </OptionSelect>
      </div>
      {errorAt("save")}
      <AlertDialogFooter><Button variant="outline" disabled={busy === "save"} onClick={onClose}>Discard</Button><Button disabled={disabled || missing.length > 0} {...(!busy && missing.length ? { "aria-describedby": missing.join(" ") } : { disabledReason: "Wait for the current action, or press Stop." })} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save character"}</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
