"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { followUpSummary, savePreferences, usePreferences, type Preferences } from "@/lib/preferences";
import { editable, reloadSettings, saveOptions } from "@/lib/settings-store";
import { Choice, SaveFeedback, Segmented, SettingRow, SettingsActions, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";
import { useSaver } from "@/components/settings/use-saver";
import { ConfigChoice, SettingsLoader } from "@/components/settings/config-choice";
import { SystemSettings } from "@/components/settings/system-settings";
import { ProfileFields } from "@/components/profile-fields";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Where chats started outside a project run. The desktop app picks and checks the folder natively. */
function DefaultFolder({ folder, onSave }: { folder: string; onSave: (folder: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const desktop = typeof window !== "undefined" ? window.elpisDesktop : undefined;
  async function choose() {
    setError("");
    try { const picked = await desktop?.chooseFolder?.(); if (picked) onSave(picked); }
    catch (cause) { setError(message(cause)); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    const value = editing?.trim() ?? "";
    if (!value.startsWith("/")) { setError("Enter an absolute folder path, such as /home/you/projects."); return; }
    try { onSave(desktop?.resolveFolder ? await desktop.resolveFolder(value) : value); setEditing(null); }
    catch (cause) { setError(message(cause)); }
  }
  return <SettingRow title="Default folder for new chats" description={error ? <span className="text-destructive" role="alert">{error}</span> : "Where chats started outside a project run. Projects keep their own folder."}>
    {editing === null ? <>
      <span className={`settings-path${folder ? "" : " unset"}`} title={folder || undefined}><bdi>{folder || "Elpis default"}</bdi></span>
      <Button variant="outline" onClick={() => desktop?.chooseFolder ? void choose() : setEditing(folder)}>Change</Button>
      {folder && <Button variant="ghost" onClick={() => onSave("")}>Reset</Button>}
    </> : <form className="flex min-w-0 flex-wrap gap-2" onSubmit={submit}>
      <Input aria-label="Default folder for new chats" className="w-64 max-w-full" autoFocus value={editing} placeholder="/home/you/projects" onChange={event => setEditing(event.target.value)} />
      <Button type="submit">Save</Button><Button type="button" variant="ghost" onClick={() => { setEditing(null); setError(""); }}>Cancel</Button>
    </form>}
  </SettingRow>;
}

/** `service_tier`, as ChatGPT's Speed setting. */
function Speed() {
  const saver = useSaver();
  return <SettingsLoader>{settings => <>
    <ConfigChoice settings={settings} name="serviceTier" title="Speed" scope="new chats" description="How quickly new chats run. Fast uses plan limits faster. Supported models only."
      values={[{ value: "default", label: "Standard" }, { value: "fast", label: "Fast" }]} disabled={!editable(settings) || saver.pending !== null}
      onSave={patch => void saver.run("speed", () => saveOptions(settings, patch), "Speed saved. Applies to new conversations.")} />
    {saver.outcome && <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={() => void saver.run("reload", reloadSettings, "Settings reloaded.")} />} />}
  </>}</SettingsLoader>;
}

/** The name the sidebar shows; it saves when the field loses focus. */
function Profile({ name, save }: { name: string; save: (patch: Partial<Preferences>) => void }) {
  const [draft, setDraft] = useState(name);
  return <SettingRow title="Name" description="Shown at the bottom of the sidebar.">
    <ProfileFields name={draft} onName={setDraft} onNameCommit={() => { if (draft.trim() !== name) save({ profileName: draft.trim() }); }} />
  </SettingRow>;
}

export function GeneralSettings() {
  const preferences = usePreferences();
  const [error, setError] = useState("");
  const save = (patch: Partial<Preferences>) => { setError(""); try { savePreferences(patch); } catch (cause) { setError(`Could not save this preference: ${message(cause)}`); } };
  return <div aria-label="General">
    <SettingsHeader title="General" description="Saved on this device, except Speed, which is saved in the Elpis config." />
    {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
    <SettingsGroup title="Profile">
      <Profile name={preferences.profileName} save={save} />
    </SettingsGroup>
    <SettingsGroup>
      <DefaultFolder folder={preferences.defaultFolder} onSave={defaultFolder => save({ defaultFolder })} />
      <SettingRow title="Prevent sleep while Elpis is working" description="Keep this computer awake during running turns. Sleep resumes when all turns finish.">
        <Switch aria-label="Prevent sleep while Elpis is working" checked={preferences.preventSleep} onCheckedChange={preventSleep => save({ preventSleep })} />
      </SettingRow>
      <SettingRow title="Confirm before closing the window" description="Ask before Elpis closes. Running chats continue either way.">
        <Switch aria-label="Confirm before closing the window" checked={preferences.confirmClose} onCheckedChange={confirmClose => save({ confirmClose })} />
      </SettingRow>
      <SettingRow title="Confirm before deleting chats" description="Ask before Delete or D removes chats. “Don’t show me this again” turns this off.">
        <Switch aria-label="Confirm before deleting chats" checked={preferences.confirmDeleteChats} onCheckedChange={confirmDeleteChats => save({ confirmDeleteChats })} />
      </SettingRow>
      <Speed />
    </SettingsGroup>
    <SettingsGroup title="Sidebar">
      <SettingRow title="Show Agent runs in sidebar" description="Show background agent history as a separate group. Hiding it keeps the history.">
        <Switch aria-label="Show Agent runs in sidebar" checked={preferences.showAgentRuns} onCheckedChange={showAgentRuns => save({ showAgentRuns })} />
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title="Composer">
      <SettingRow title="Send shortcut" description="Choose whether Enter sends a message or inserts a new line.">
        <Choice label="Send shortcut" value={preferences.sendShortcut} options={[{ value: "enter", label: "Enter" }, { value: "modEnter", label: "Ctrl+Enter" }]} onChange={sendShortcut => save({ sendShortcut })} />
      </SettingRow>
      <SettingRow title="Follow-up behavior" description={followUpSummary(preferences)}>
        <Segmented label="Follow-up behavior" value={preferences.followUp} options={[{ value: "queue", label: "Queue" }, { value: "steer", label: "Steer" }]} onChange={followUp => save({ followUp })} />
      </SettingRow>
      <SettingRow title="Show context window usage" description="Show how much of the context window the chat’s latest request used, under the composer.">
        <Switch aria-label="Show context window usage" checked={preferences.showContextUsage} onCheckedChange={showContextUsage => save({ showContextUsage })} />
      </SettingRow>
    </SettingsGroup>
    <SystemSettings preferences={preferences} save={save} />
  </div>;
}
