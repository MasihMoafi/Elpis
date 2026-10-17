"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Plus, RefreshCw, Settings2 } from "lucide-react";
import { FileRefLink } from "@/components/file-ref";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Segmented, SettingsEmpty, SettingsNotice } from "@/components/settings/rows";
import { api, unreadable } from "@/lib/api";

/** Claude's Customize page (its /customize: Skills, Plugins and Connectors, each with "Your …" and Add) over what
 * Elpis has: the skills it finds for the project, the plugins installed, and gh and MCP servers as connectors
 * (bridge/customize.mjs). */

type Part<T> = { data?: T[]; error?: string };
type Skill = { id: string; name: string; description: string; path: string; scope: "user" | "repo" | "system" | "admin"; enabled: boolean; plugin: string | null };
type Plugin = { id: string; name: string; description: string; marketplace: string; enabled: boolean };
type Connector = { name: string; enabled: boolean; transport: "stdio" | "http" | "gh"; login?: string | null };
type Customize = { skills: Part<Skill> & { errors?: { path: string; message: string }[] }; plugins: Part<Plugin>; connectors: Part<Connector> };
type Section = "skills" | "plugins" | "connectors";

function readCustomize(data: Customize): Customize {
  for (const part of [data.skills, data.plugins, data.connectors]) {
    if (!part || typeof part !== "object" || Array.isArray(part) || (part.data !== undefined && !Array.isArray(part.data))) throw unreadable("customize");
  }
  return data;
}

const SCOPE: Record<Skill["scope"], string> = { user: "Yours", repo: "This project", system: "Built in", admin: "Admin" };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const folderOf = (path: string) => path.split("/").slice(0, -1).join("/") || "/";

function Description({ text }: { text: string }) {
  return <span className="customize-description" title={text}>{text}</span>;
}

export function CustomizeView({ cwd, onCreateSkill, onOpenSettings, onConnectGithub }: { cwd: string | null; onCreateSkill: () => void; onOpenSettings: () => void; onConnectGithub?: () => void }) {
  const [section, setSection] = useState<Section>("skills");
  const [data, setData] = useState<Customize | null>(null), [error, setError] = useState("");
  const [savingGithub, setSavingGithub] = useState(false);
  const load = useCallback(async () => {
    try { setError(""); setData(readCustomize(await api<Customize>(`/customize${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`))); }
    catch (cause) { setError(message(cause)); }
  }, [cwd]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (section !== "connectors") return;
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [section, load]);
  const setGithub = async (enabled: boolean, connect = false) => {
    if (connect && !onConnectGithub) { setError("Connect GitHub in the Elpis desktop app."); return; }
    try {
      setSavingGithub(true); setError("");
      setData(readCustomize(await api<Customize>("/customize/github", { enabled, ...(cwd ? { cwd } : {}) })));
      if (connect) onConnectGithub?.();
    } catch (cause) { setError(message(cause)); }
    finally { setSavingGithub(false); }
  };
  const setSkill = async (skill: Skill, enabled: boolean) => {
    try { setError(""); setData(readCustomize(await api<Customize>("/customize/skill", { path: skill.path, enabled, ...(cwd ? { cwd } : {}) }))); }
    catch (cause) { setError(message(cause)); }
  };
  const openFolder = async (folder: string) => {
    const open = window.elpisDesktop?.openFolder;
    if (!open) { setError("Folders open in the Elpis desktop app."); return; }
    try { await open(folder); } catch (cause) { setError(message(cause)); }
  };
  const skills = data?.skills.data ?? [], plugins = data?.plugins.data ?? [], connectors = data?.connectors.data ?? [];
  const own = skills.find(skill => skill.scope === "user");

  return <div className="customize" aria-label="Customize">
    <header className="customize-head">
      <Segmented label="Customize" value={section} onChange={setSection} options={[{ value: "skills", label: "Skills" }, { value: "plugins", label: "Plugins" }, { value: "connectors", label: "Connectors" }]} />
    </header>
    {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
    {!data && !error && <SettingsNotice>Reading what Elpis has…</SettingsNotice>}
    {data && section === "skills" && <section aria-label="Your skills">
      <div className="customize-title"><h2>Your skills</h2><span className="customize-actions">
        {own && <Button variant="ghost" size="sm" onClick={() => void openFolder(folderOf(folderOf(own.path)))}><FolderOpen />Skills folder</Button>}
        <Button size="sm" onClick={onCreateSkill}><Plus />Create skill</Button>
      </span></div>
      <p className="customize-note">Skills teach Elpis a way of working. It reads one when a task calls for it, or when you type <code>$</code> and its name.</p>
      {data.skills.error && <SettingsNotice tone="alert">{data.skills.error}</SettingsNotice>}
      {!data.skills.error && !skills.length && <SettingsEmpty title="No skills yet">Create one, or add a folder with a SKILL.md to your skills folder.</SettingsEmpty>}
      <ul className="customize-list">{skills.map(skill => <li key={skill.path} className="customize-item" title={skill.path}>
        <span className="customize-text"><span className="customize-name"><FileRefLink target={{ path: skill.path }}>{skill.name}</FileRefLink></span>{skill.description && <Description text={skill.description} />}</span>
        <span className="customize-badge">{skill.plugin ? `From ${skill.plugin.split("@")[0]}` : SCOPE[skill.scope]}</span>
        <Switch aria-label={`Use ${skill.name}`} checked={skill.enabled} onCheckedChange={enabled => void setSkill(skill, enabled)} />
      </li>)}</ul>
      {(data.skills.errors?.length ?? 0) > 0 && <details className="customize-errors"><summary>{data.skills.errors!.length} {data.skills.errors!.length === 1 ? "skill" : "skills"} could not be read</summary>
        <ul>{data.skills.errors!.map(item => <li key={item.path}><FileRefLink target={{ path: item.path }}><code>{item.path}</code></FileRefLink> {item.message}</li>)}</ul></details>}
    </section>}
    {data && section === "plugins" && <section aria-label="Your plugins">
      <div className="customize-title"><h2>Your plugins</h2></div>
      <p className="customize-note">Plugins bundle skills, tools and connectors. These are the ones installed for Elpis.</p>
      {data.plugins.error && <SettingsNotice tone="alert">{data.plugins.error}</SettingsNotice>}
      {!data.plugins.error && !plugins.length && <SettingsEmpty title="No plugins installed" />}
      <ul className="customize-list">{plugins.map(plugin => <li key={plugin.id} className="customize-item" title={plugin.id}>
        <span className="customize-text"><span className="customize-name">{plugin.name}</span>{plugin.description && <Description text={plugin.description} />}</span>
        <span className="customize-badge">{plugin.marketplace || "Local"}</span>
        <span className="customize-state" data-on={plugin.enabled || undefined}>{plugin.enabled ? "On" : "Off"}</span>
      </li>)}</ul>
    </section>}
    {data && section === "connectors" && <section aria-label="Your connectors">
      <div className="customize-title"><h2>Your connectors</h2><span className="customize-actions"><Button size="icon-sm" variant="ghost" aria-label="Refresh connectors" onClick={() => void load()}><RefreshCw /></Button><Button size="sm" variant="outline" onClick={onOpenSettings}><Settings2 />Manage connectors</Button></span></div>
      <p className="customize-note">Connectors give Elpis access to other apps and services.</p>
      {data.connectors.error && <SettingsNotice tone="alert">{data.connectors.error}</SettingsNotice>}
      {!data.connectors.error && !connectors.length && <SettingsEmpty title="No connectors yet">Add an MCP server under Manage connectors.</SettingsEmpty>}
      <ul className="customize-list">{connectors.map(connector => <li key={`${connector.transport}:${connector.name}`} className="customize-item">
        <span className="customize-text"><span className="customize-name">{connector.name}</span><Description text={connector.transport === "gh" ? (connector.login ? `Connected as ${connector.login}` : "Not connected") : connector.transport === "http" ? "Remote server" : "Local server"} /></span>
        {connector.transport === "gh" ? <>
          {!connector.login && <Button size="sm" disabled={savingGithub} onClick={() => void setGithub(true, true)}>Connect</Button>}
          <Switch aria-label="Use GitHub" checked={connector.enabled} disabled={savingGithub} onCheckedChange={enabled => void setGithub(enabled)} />
        </> : <span className="customize-state" data-on={connector.enabled || undefined}>{connector.enabled ? "On" : "Off"}</span>}
      </li>)}</ul>
    </section>}
  </div>;
}
