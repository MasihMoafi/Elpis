"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Choice, Segmented, SettingRow, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";
import { savePreferences, usePreferences, type Accent, type Preferences } from "@/lib/preferences";
import { codeFontProblem, type ChatFont, type InterfaceFont, type ReadingStep } from "@/lib/reading";

export type ThemeChoice = "system" | "light" | "dark";
const OPTIONS: { value: ThemeChoice; label: string; icon: React.ReactNode }[] = [
  { value: "system", label: "System", icon: <Monitor /> },
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "dark", label: "Dark", icon: <Moon /> },
];
const SIZES: { value: ReadingStep; label: string }[] = [{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }];
const WIDTHS: { value: ReadingStep; label: string }[] = [{ value: "s", label: "Narrow" }, { value: "m", label: "Medium" }, { value: "l", label: "Wide" }];
const FONTS: { value: InterfaceFont; label: string }[] = [{ value: "sans", label: "Sans" }, { value: "serif", label: "Serif" }];
const ACCENTS: { value: Accent; label: string }[] = [
  { value: "amber", label: "Amber (default)" }, { value: "blue", label: "Blue" },
  { value: "teal", label: "Teal" }, { value: "green", label: "Green" },
  { value: "violet", label: "Violet" }, { value: "rose", label: "Rose" }, { value: "orange", label: "Orange" },
];
const CHAT_FONTS: { value: ChatFont; label: string }[] = [
  { value: "default", label: "Default" }, { value: "sans", label: "Sans" },
  { value: "serif", label: "Serif" }, { value: "mono", label: "Mono" }, { value: "system", label: "System UI" },
];

/** Theme for this app window (System follows the operating system and changes with it), and Claude's reading options:
 * transcript text size and width, interface font and code font (lib/reading.ts). All saved on this device. */
export function AppearanceSettings({ theme, onTheme }: { theme: ThemeChoice; onTheme: (theme: ThemeChoice) => void }) {
  const preferences = usePreferences();
  const [notice, setNotice] = useState("");
  const save = (patch: Partial<Preferences>) => { setNotice(""); try { savePreferences(patch); } catch (cause) { setNotice(`Could not save this preference: ${cause instanceof Error ? cause.message : String(cause)}`); } };
  return <div aria-label="Appearance">
    <SettingsHeader title="Appearance" description="Saved on this device." />
    <SettingsGroup>
      <SettingRow title="Theme" description="Use light or dark, or follow your system.">
        <Segmented label="Theme" value={theme} options={OPTIONS} onChange={onTheme} />
      </SettingRow>
      <SettingRow title="Accent colour" description="Highlights, links and controls in every view.">
        <Choice label="Accent colour" value={preferences.accent} options={ACCENTS} onChange={accent => save({ accent })} />
      </SettingRow>
      <SettingRow title="Chat font" description="Font for messages and the composer. Default follows the interface font.">
        <Choice label="Chat font" value={preferences.chatFont} options={CHAT_FONTS} onChange={chatFont => save({ chatFont })} />
      </SettingRow>
      <SettingRow title="Interface font" description="Font for the whole interface — menus, sidebars, and panels.">
        <Segmented label="Interface font" value={preferences.interfaceFont} options={FONTS} onChange={interfaceFont => save({ interfaceFont })} />
      </SettingRow>
      <SettingRow title="Transcript text size" description="Size of the conversation transcript text.">
        <Segmented label="Transcript text size" value={preferences.transcriptSize} options={SIZES} onChange={transcriptSize => save({ transcriptSize })} />
      </SettingRow>
      <SettingRow title="Transcript width" description="Maximum width of the transcript and composer columns.">
        <Segmented label="Transcript width" value={preferences.transcriptWidth} options={WIDTHS} onChange={transcriptWidth => save({ transcriptWidth })} />
      </SettingRow>
      <CodeFont font={preferences.codeFont} onSave={codeFont => save({ codeFont })} />
    </SettingsGroup>
    {notice && <SettingsNotice tone="alert">{notice}</SettingsNotice>}
  </div>;
}

/** One monospace family name for code, diffs and the terminal; empty is Elpis's own. A name that could not be one family
 * is refused here and never saved. */
function CodeFont({ font, onSave }: { font: string; onSave: (font: string) => void }) {
  const [text, setText] = useState(font), [problem, setProblem] = useState("");
  useEffect(() => { setText(font); }, [font]);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const refused = codeFontProblem(text);
    setProblem(refused ?? "");
    if (!refused) onSave(text.trim());
  }
  return <SettingRow title="Code font" description={problem ? <span className="text-destructive" role="alert">{problem}</span> : "Set a custom monospace font for code and terminal."}>
    <form className="flex min-w-0 flex-wrap gap-2" onSubmit={submit}>
      <Input aria-label="Code font" className="w-56 max-w-full" value={text} placeholder="JetBrains Mono" maxLength={120} aria-invalid={problem ? true : undefined} onChange={event => { setText(event.target.value); setProblem(""); }} />
      <Button type="submit" variant="outline" size="sm" aria-label="Save code font" disabled={text.trim() === font}>Save</Button>
      {font && <Button type="button" variant="ghost" size="sm" aria-label="Reset code font" onClick={() => { setProblem(""); onSave(""); }}>Reset</Button>}
    </form>
  </SettingRow>;
}
