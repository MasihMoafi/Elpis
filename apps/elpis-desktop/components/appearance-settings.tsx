"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Choice, Segmented, SettingRow, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";
import { savePreferences, usePreferences, type Accent, type Preferences } from "@/lib/preferences";
import { parseCustomThemes, STARTER_THEME, THEME_COLORS, validTheme, type CustomTheme, type ThemeColor } from "@/lib/theme-palettes";
import { codeFontProblem, type ReadingStep } from "@/lib/reading";

export type ThemeChoice = "system" | "light" | "dark";
const OPTIONS: { value: ThemeChoice; label: string; icon: React.ReactNode }[] = [
  { value: "system", label: "System", icon: <Monitor /> },
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "dark", label: "Dark", icon: <Moon /> },
];
const SIZES: { value: ReadingStep; label: string }[] = [{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }];
const WIDTHS: { value: ReadingStep; label: string }[] = [{ value: "s", label: "Narrow" }, { value: "m", label: "Medium" }, { value: "l", label: "Wide" }];
const ACCENTS: { value: Accent; label: string }[] = [
  { value: "amber", label: "Amber (default)" }, { value: "blue", label: "Blue" },
  { value: "teal", label: "Teal" }, { value: "green", label: "Green" },
  { value: "violet", label: "Violet" }, { value: "rose", label: "Rose" }, { value: "orange", label: "Orange" },
];

/** Theme for this app window (System follows the operating system and changes with it), and reading options:
 * transcript text size and width plus the code font (lib/reading.ts). All saved on this device. */
export function AppearanceSettings({ theme, onTheme }: { theme: ThemeChoice; onTheme: (theme: ThemeChoice) => void }) {
  const preferences = usePreferences();
  const [notice, setNotice] = useState("");
  const save = (patch: Partial<Preferences>) => { setNotice(""); try { savePreferences(patch); } catch (cause) { setNotice(`Could not save this preference: ${cause instanceof Error ? cause.message : String(cause)}`); } };
  const themes = parseCustomThemes(preferences.customThemes);
  const selectedId = themes.some(item => item.id === preferences.selectedPalette) ? preferences.selectedPalette : "elpis";
  const selectedTheme = themes.find(item => item.id === selectedId) ?? null;
  const createTheme = () => {
    const source = selectedTheme ?? STARTER_THEME;
    const id = `theme-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const created = { ...source, id, name: `My theme ${themes.length + 1}`, light: { ...source.light }, dark: { ...source.dark } };
    save({ customThemes: JSON.stringify([...themes, created]), selectedPalette: id });
  };
  const saveTheme = (updated: CustomTheme) => save({ customThemes: JSON.stringify(themes.map(item => item.id === updated.id ? updated : item)) });
  const deleteTheme = (removed: CustomTheme) => {
    if (!window.confirm(`Delete the “${removed.name}” theme?`)) return;
    save({ customThemes: JSON.stringify(themes.filter(item => item.id !== removed.id)), selectedPalette: "elpis" });
  };
  return <div aria-label="Appearance">
    <SettingsHeader title="Appearance" description="Saved on this device." />
    <SettingsGroup>
      <SettingRow title="Theme" description="Use light or dark, or follow your system.">
        <Segmented label="Theme" value={theme} options={OPTIONS} onChange={onTheme} />
      </SettingRow>
      <SettingRow title="Colour palette" description="Choose Elpis colours or make and save your own full theme.">
        <div className="flex min-w-0 flex-wrap gap-2">
          <Choice label="Theme palette" value={selectedId} options={[{ value: "elpis", label: "Elpis" }, ...themes.map(item => ({ value: item.id, label: item.name }))]} onChange={selectedPalette => save({ selectedPalette })} />
          <Button type="button" variant="outline" onClick={createTheme}>Create theme</Button>
        </div>
      </SettingRow>
      {selectedId === "elpis" && <SettingRow title="Accent colour" description="Highlights, links and controls in every view.">
        <Choice label="Accent colour" value={preferences.accent} options={ACCENTS} onChange={accent => save({ accent })} />
      </SettingRow>}
      <SettingRow title="Transcript text size" description="Size of the conversation transcript text.">
        <Segmented label="Transcript text size" value={preferences.transcriptSize} options={SIZES} onChange={transcriptSize => save({ transcriptSize })} />
      </SettingRow>
      <SettingRow title="Interface size" description="Size of text across menus, sidebars, and panels.">
        <Segmented label="Interface size" value={preferences.interfaceSize} options={SIZES} onChange={interfaceSize => save({ interfaceSize })} />
      </SettingRow>
      <SettingRow title="Code size" description="Text size in code blocks, file editors, diffs, and terminals.">
        <Segmented label="Code size" value={preferences.codeSize} options={SIZES} onChange={codeSize => save({ codeSize })} />
      </SettingRow>
      <SettingRow title="Corner style" description="Corners of controls and panels across the app.">
        <Segmented label="Corner style" value={preferences.cornerStyle} options={[{ value: "cut", label: "Cut" }, { value: "sharp", label: "Sharp" }, { value: "rounded", label: "Rounded" }]} onChange={cornerStyle => save({ cornerStyle })} />
      </SettingRow>
      <SettingRow title="Transcript width" description="Maximum width of the transcript and composer columns.">
        <Segmented label="Transcript width" value={preferences.transcriptWidth} options={WIDTHS} onChange={transcriptWidth => save({ transcriptWidth })} />
      </SettingRow>
      <CodeFont font={preferences.codeFont} onSave={codeFont => save({ codeFont })} />
    </SettingsGroup>
    {selectedTheme && <ThemeEditor theme={selectedTheme} onSave={saveTheme} onDelete={() => deleteTheme(selectedTheme)} />}
    {notice && <SettingsNotice tone="alert">{notice}</SettingsNotice>}
  </div>;
}

function ThemeEditor({ theme, onSave, onDelete }: { theme: CustomTheme; onSave: (theme: CustomTheme) => void; onDelete: () => void }) {
  const [draft, setDraft] = useState(theme);
  useEffect(() => { setDraft(theme); }, [theme]);
  const valid = validTheme(draft), changed = JSON.stringify(draft) !== JSON.stringify(theme);
  const setColor = (mode: "light" | "dark", key: ThemeColor, value: string) => setDraft(current => ({ ...current, [mode]: { ...current[mode], [key]: value } }));
  const colorFields = (mode: "light" | "dark") => THEME_COLORS.map(({ key, label }) => {
    const value = draft[mode][key], color = /^#[\da-f]{6}$/i.test(value) ? value : "#000000";
    const modeName = mode === "light" ? "Light" : "Dark";
    return <label key={key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_36px_minmax(6rem,8rem)] items-center gap-2 text-sm">
      <span>{label}</span>
      <input aria-label={`${modeName} ${label} picker`} className="h-8 w-9 cursor-pointer rounded-md border border-input bg-transparent p-1" type="color" value={color} onChange={event => setColor(mode, key, event.target.value)} />
      <Input aria-label={`${modeName} ${label} hex`} value={value} maxLength={7} aria-invalid={!/^#[\da-f]{6}$/i.test(value) || undefined} onChange={event => setColor(mode, key, event.target.value)} />
    </label>;
  });
  return <SettingsGroup title="Build your theme" description="Set the full palette for light and dark mode. Colours apply across the app when saved.">
    <SettingRow title="Theme name" description="Up to 40 characters.">
      <Input aria-label="Theme name" maxLength={40} value={draft.name} aria-invalid={!draft.name.trim() || draft.name.trim().length > 40 || undefined} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} />
    </SettingRow>
    <SettingRow stacked title="Light theme colors" description="Used when Theme is set to Light, or System follows a light appearance.">
      <div className="grid gap-2 sm:grid-cols-2">{colorFields("light")}</div>
    </SettingRow>
    <SettingRow stacked title="Dark theme colors" description="Used when Theme is set to Dark, or System follows a dark appearance.">
      <div className="grid gap-2 sm:grid-cols-2">{colorFields("dark")}</div>
    </SettingRow>
    {!valid && <p className="text-sm text-destructive" role="alert">Use a theme name and six-digit hex colours before saving.</p>}
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="destructive" onClick={onDelete}>Delete theme</Button>
      <Button type="button" disabled={!valid || !changed} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>Save theme</Button>
    </div>
  </SettingsGroup>;
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
      <Button type="submit" variant="outline" aria-label="Save code font" disabled={text.trim() === font}>Save</Button>
      {font && <Button type="button" variant="ghost" aria-label="Reset code font" onClick={() => { setProblem(""); onSave(""); }}>Reset</Button>}
    </form>
  </SettingRow>;
}
