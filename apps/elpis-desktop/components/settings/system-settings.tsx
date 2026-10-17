"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { DesktopQuickEntry, QuickEntryStatus } from "@/lib/desktop";
import type { Preferences } from "@/lib/preferences";
import { SettingRow, SettingsGroup } from "@/components/settings/rows";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const MODIFIER_KEYS = ["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"];
// Claude's reserved combinations (its Linux and Windows part).
const RESERVED = ["Ctrl+W", "Ctrl+N", "Ctrl+O", "Ctrl+T", "Ctrl+S", "Ctrl+C", "Ctrl+V"];
const RESERVED_TEXT = "This shortcut is reserved for common actions. Try a different combination.";

/** The Electron accelerator a key press names, modifiers in Linux order; null while only modifiers are held. */
function acceleratorOf(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.includes(event.code)) return null;
  const { code } = event;
  const key = code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code.startsWith("Arrow") ? code.slice(5)
    : code === "Space" ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : code;
  return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super", key].filter(Boolean).join("+");
}

/** Claude's shortcut recorder: focus it and press the new combination. A key without a modifier (other than F1–F24)
 * or a common action's combination is refused before anything is registered. */
function ShortcutRecorder({ label, shortcut, disabled, onRecord, onRefuse }: { label: string; shortcut: string; disabled?: boolean; onRecord: (accelerator: string) => void; onRefuse: (text: string) => void }) {
  function keyDown(event: KeyboardEvent) {
    if ((event.key === "Tab" && !(event.altKey || event.ctrlKey || event.metaKey)) || event.nativeEvent.isComposing) return;
    event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation();
    const accelerator = acceleratorOf(event);
    if (!accelerator) return;
    const plain = !accelerator.includes("+") && !/^F([1-9]|1[0-9]|2[0-4])$/.test(accelerator);
    if (plain || RESERVED.includes(accelerator)) { onRefuse(RESERVED_TEXT); return; }
    onRecord(accelerator);
  }
  return <Button variant="outline" size="sm" className="min-w-[120px]" aria-label={label} title="Press the new shortcut" disabled={disabled} onKeyDown={keyDown}>
    {shortcut ? shortcut.split("+").map((key, index) => <kbd key={`${key}:${index}`} className="kbd">{key}</kbd>) : <span className="text-muted-foreground">Set shortcut</span>}
  </Button>;
}

/** Claude's Desktop app → System settings that Elpis has: the Quick Entry shortcut and the tray. Desktop app only. */
export function SystemSettings({ preferences, save }: { preferences: Preferences; save: (patch: Partial<Preferences>) => void }) {
  const [quick, setQuick] = useState<DesktopQuickEntry>();
  const [status, setStatus] = useState<QuickEntryStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const desktop = window.elpisDesktop?.quickEntry;
    setQuick(desktop);
    desktop?.status().then(setStatus).catch(cause => setError(message(cause)));
  }, []);
  if (!quick) return null;
  async function change(accelerator: string) {
    setError("");
    try {
      const { shortcut } = await quick!.setShortcut(accelerator);
      save({ quickEntryShortcut: shortcut });
      setStatus(await quick!.status());
    } catch (cause) { setError(message(cause)); }
  }
  const unsupported = status?.supported === false;
  const problem = error || (unsupported ? "" : status?.problem ?? "");
  const description = problem ? <span className="text-destructive" role="alert">{problem}</span>
    : unsupported ? <span role="status">{status?.reason}</span> : "Quickly open Elpis from anywhere.";
  return <SettingsGroup title="System">
    <SettingRow title="Quick Entry keyboard shortcut" description={description}>
      <ShortcutRecorder label="Quick Entry keyboard shortcut" shortcut={preferences.quickEntryShortcut} disabled={!status || unsupported} onRecord={accelerator => void change(accelerator)} onRefuse={setError} />
      {preferences.quickEntryShortcut && !unsupported && <Button variant="ghost" size="icon-sm" aria-label="Turn off the Quick Entry shortcut" title="No shortcut" onClick={() => void change("")}><X /></Button>}
    </SettingRow>
    <SettingRow title="Close to tray" description="Keep Elpis running in the system tray when you close the window.">
      <Switch aria-label="Close to tray" checked={preferences.closeToTray} onCheckedChange={closeToTray => save({ closeToTray })} />
    </SettingRow>
  </SettingsGroup>;
}
