"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppUpdate } from "@/components/app-update";
import { Button } from "@/components/ui/button";
import { SettingRow, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";

type Identity = { version: string; commit: string | null; releaseNotes: string };
export function AboutSettings() {
  const [identity, setIdentity] = useState<Identity | null>(null), [error, setError] = useState("");
  async function load() {
    setError("");
    try { setIdentity(await api<Identity>("/about")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  useEffect(() => { void load(); }, []);
  return <div aria-label="About">
    <SettingsHeader title="About" description="Installed Elpis version and updates." />
    <SettingsGroup>
      <SettingRow title="Installed version"><span>{identity?.version ?? "Loading…"}</span></SettingRow>
      <SettingRow title="Commit"><span className="settings-path"><bdi>{identity ? identity.commit ?? "Unavailable in this installation" : "Loading…"}</bdi></span></SettingRow>
      <SettingRow title="Updates" description="Restart applies an update already installed on this device."><AppUpdate showCurrent /></SettingRow>
      {identity && <SettingRow title="Release notes" description="Changes and release history."><Button variant="outline" render={<a href={identity.releaseNotes} target="_blank" rel="noreferrer" />}>Release notes</Button></SettingRow>}
    </SettingsGroup>
    {error && <SettingsGroup><SettingsNotice tone="alert">{error}</SettingsNotice><Button variant="outline" onClick={() => void load()}>Retry</Button></SettingsGroup>}
  </div>;
}
