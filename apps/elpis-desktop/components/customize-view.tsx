"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { FileRefLink } from "@/components/file-ref";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { Description, CustomizeRow } from "@/components/customize-row";
import { CustomizePlugins, type ConfigWrite, type Plugin, type PluginChange } from "@/components/customize-plugins";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Segmented, SettingsEmpty, SettingsNotice } from "@/components/settings/rows";
import { api, unreadable } from "@/lib/api";

/** Claude's Customize page (its /customize: Skills, Plugins and Connectors, each with "Your …" and Add) over what
 * Elpis has: the skills it finds for the project, the plugins installed, and gh and MCP servers as connectors
 * (bridge/customize.mjs). */

type Part<T> = { data?: T[]; error?: string };
type Skill = { id: string; name: string; description: string; path: string; scope: "user" | "repo" | "system" | "admin"; enabled: boolean; plugin: string | null; deletable: boolean };
type Connector = { name: string; enabled: boolean; transport: "stdio" | "http" | "gh"; login?: string | null };
type Customize = { skills: Part<Skill> & { errors?: { path: string; message: string }[] }; plugins: Part<Plugin> & ConfigWrite; connectors: Part<Connector> & ConfigWrite };
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
const skillOrigin = (skill: Skill) => skill.plugin ? `From plugin ${skill.plugin.split("@")[0]}` : skill.scope === "system" ? "Built in with Elpis" : skill.scope === "admin" ? "Managed by your system administrator" : "Protected skill";
const skillProtection = (skill: Skill) => `${folderOf(skill.path)}. This skill can be turned off instead.`;

export function CustomizeView({ cwd, onCreateSkill, onOpenSettings, onConnectGithub }: { cwd: string | null; onCreateSkill: () => void; onOpenSettings: () => void; onConnectGithub?: () => void }) {
  const [section, setSection] = useState<Section>("skills");
  const [data, setData] = useState<Customize | null>(null), [error, setError] = useState("");
  const [savingGithub, setSavingGithub] = useState(false);
  const [savingMcp, setSavingMcp] = useState<string | null>(null), [connectorErrors, setConnectorErrors] = useState<Record<string, string>>({});
  const mcpLock = useRef(false);
  const [deleting, setDeleting] = useState<Skill | null>(null), [deletingError, setDeletingError] = useState("");
  const [deleted, setDeleted] = useState<{ name: string; token: string } | null>(null), [savingSkill, setSavingSkill] = useState(false);
  const skillList = useRef<HTMLUListElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!deleted) return;
    const timer = window.setTimeout(() => setDeleted(null), 4000);
    return () => window.clearTimeout(timer);
  }, [deleted]);
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
  /** The switch flips as it is pressed and the engine catches up; a refused change puts it back and says why. */
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const setSkill = async (skill: Skill, enabled: boolean) => {
    setFlipped(previous => ({ ...previous, [skill.path]: enabled }));
    try { setError(""); const { skills } = await api<Pick<Customize, "skills">>("/customize/skill", { path: skill.path, enabled, ...(cwd ? { cwd } : {}) }); setData(previous => previous && readCustomize({ ...previous, skills })); }
    catch (cause) { setError(message(cause)); }
    finally { setFlipped(({ [skill.path]: _settled, ...rest }) => rest); }
  };
  const setMcp = async (connector: Connector, enabled: boolean) => {
    if (mcpLock.current) return;
    mcpLock.current = true; setSavingMcp(connector.name); setConnectorErrors(previous => ({ ...previous, [connector.name]: "" }));
    try {
      await api("/mcp", { action: "enable", name: connector.name, enabled, version: data?.connectors.version });
      await load();
    } catch (cause) { setConnectorErrors(previous => ({ ...previous, [connector.name]: message(cause) })); await load(); }
    finally { mcpLock.current = false; setSavingMcp(null); }
  };
  const changePlugin = async (change: PluginChange) => {
    const result = await api<Customize & { appsNeedingAuth: { name: string }[] }>("/customize/plugin", { ...change, ...(cwd ? { cwd } : {}) });
    setData(readCustomize(result));
    return result.appsNeedingAuth?.map(app => app.name) ?? [];
  };
  const requestDelete = (skill: Skill) => {
    if (!skill.deletable) return;
    returnFocus.current = skillList.current?.querySelector<HTMLElement>(`[data-skill-path="${CSS.escape(skill.path)}"]`) ?? null;
    setDeletingError(""); setDeleting(skill);
  };
  const deleteSkill = async () => {
    if (!deleting || savingSkill) return;
    setSavingSkill(true); setDeletingError("");
    try {
      const result = await api<Customize & { deleted: { name: string; token: string } }>("/customize/skill/delete", { path: deleting.path, ...(cwd ? { cwd } : {}) });
      setData(readCustomize(result)); setDeleted(result.deleted); setDeleting(null);
    } catch (cause) { setDeletingError(message(cause)); }
    finally { setSavingSkill(false); }
  };
  const undoDelete = async () => {
    if (!deleted || savingSkill) return;
    setSavingSkill(true); setError("");
    try { setData(readCustomize(await api<Customize>("/customize/skill/undo", { token: deleted.token, ...(cwd ? { cwd } : {}) }))); setDeleted(null); }
    catch (cause) { setError(message(cause)); }
    finally { setSavingSkill(false); }
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
    {deleted && <div className="error-banner notice" role="status"><span>Deleted {deleted.name} ·</span><Button variant="link" size="sm" disabled={savingSkill} onClick={() => void undoDelete()}>Undo</Button></div>}
    {!data && !error && <SettingsNotice>Reading what Elpis has…</SettingsNotice>}
    {data && section === "skills" && <section aria-label="Your skills">
      <div className="customize-title"><h2>Your skills</h2><span className="customize-actions">
        {own && <Button variant="ghost" size="sm" onClick={() => void openFolder(folderOf(folderOf(own.path)))}><FolderOpen />Skills folder</Button>}
        <Button size="sm" onClick={onCreateSkill}><Plus />Create skill</Button>
      </span></div>
      <p className="customize-note">Skills teach Elpis a way of working. It reads one when a task calls for it, or when you type <code>$</code> and its name.</p>
      {data.skills.error && <SettingsNotice tone="alert">{data.skills.error}</SettingsNotice>}
      {!data.skills.error && !skills.length && <SettingsEmpty title="No skills yet">Create one, or add a folder with a SKILL.md to your skills folder.</SettingsEmpty>}
      <ul ref={skillList} className="customize-list">{skills.map(skill => <li key={skill.path} className="customize-item" tabIndex={0} data-skill-path={skill.path}
        title={skill.deletable ? skill.path : `${skillOrigin(skill)} · ${skillProtection(skill)}`}
        onKeyDown={event => { if (event.key === "Delete" && event.target === event.currentTarget && !savingSkill && !event.repeat) { event.preventDefault(); event.stopPropagation(); requestDelete(skill); } }}>
        <span className="customize-text"><span className="customize-name"><FileRefLink target={{ path: skill.path }}>{skill.name}</FileRefLink></span>{skill.description && <Description text={skill.description} />}</span>
        {skill.deletable ? <span className="customize-badge">{SCOPE[skill.scope]}</span>
          : <Tooltip content={skillOrigin(skill)} detail={<span className="break-all">{skillProtection(skill)}</span>}><span className="customize-badge">{skill.plugin ? `From ${skill.plugin.split("@")[0]}` : SCOPE[skill.scope]}</span></Tooltip>}
        <Switch aria-label={`Use ${skill.name}`} checked={flipped[skill.path] ?? skill.enabled} onCheckedChange={enabled => void setSkill(skill, enabled)} />
        <span className="flex size-6 shrink-0 items-center justify-center">{skill.deletable && <Button variant="ghost" size="icon-xs" aria-label={`Delete ${skill.name}`} title="Delete (Delete key)" disabled={savingSkill} onClick={() => requestDelete(skill)}><Trash2 size={14} /></Button>}</span>
      </li>)}</ul>
      {(data.skills.errors?.length ?? 0) > 0 && <details className="customize-errors"><DisclosureSummary>{data.skills.errors!.length} {data.skills.errors!.length === 1 ? "skill" : "skills"} could not be read</DisclosureSummary>
        <ul>{data.skills.errors!.map(item => <li key={item.path}><FileRefLink target={{ path: item.path }}><code>{item.path}</code></FileRefLink> {item.message}</li>)}</ul></details>}
    </section>}
    {data && section === "plugins" && <section aria-label="Your plugins">
      {data.plugins.error && <SettingsNotice tone="alert">{data.plugins.error}</SettingsNotice>}
      <CustomizePlugins cwd={cwd} plugins={plugins} loaded={Array.isArray(data.plugins.data)} config={data.plugins} onChange={changePlugin} onReload={load} />
    </section>}
    {data && section === "connectors" && <section aria-label="Your connectors">
      <div className="customize-title"><h2>Your connectors</h2><span className="customize-actions"><Button size="icon-sm" variant="ghost" aria-label="Refresh connectors" onClick={() => void load()}><RefreshCw /></Button><Button size="sm" variant="outline" onClick={onOpenSettings}><Settings2 />Manage connectors</Button></span></div>
      <p className="customize-note">Connectors give Elpis access to other apps and services.</p>
      {data.connectors.error && <SettingsNotice tone="alert">{data.connectors.error}</SettingsNotice>}
      {!data.connectors.error && !connectors.length && <SettingsEmpty title="No connectors yet">Add an MCP server under Manage connectors.</SettingsEmpty>}
      {savingMcp && <SettingsNotice>Saving connector changes…</SettingsNotice>}
      <ul className="customize-list">{connectors.map(connector => <CustomizeRow key={`${connector.transport}:${connector.name}`} name={connector.name}
        description={connector.transport === "gh" ? (connector.login ? `Connected as ${connector.login}` : "Not connected") : connector.transport === "http" ? "Remote server" : "Local server"}
        error={connectorErrors[connector.name]} notice={connector.transport !== "gh" && (!data.connectors.version || !data.connectors.write?.available) ? "Reload Customize to read writable MCP settings." : undefined}>
        {connector.transport === "gh" ? <>
          {!connector.login && <Button size="sm" disabled={savingGithub} onClick={() => void setGithub(true, true)}>Connect</Button>}
          <Switch aria-label="Use GitHub" checked={connector.enabled} disabled={savingGithub} onCheckedChange={enabled => void setGithub(enabled)} />
        </> : <Switch aria-label={`Use ${connector.name}`} checked={connector.enabled} disabled={savingMcp !== null || !data.connectors.version || !data.connectors.write?.available} onCheckedChange={enabled => void setMcp(connector, enabled)} />}
      </CustomizeRow>)}</ul>
    </section>}
    <AlertDialog open={!!deleting} onOpenChange={value => { if (!value && !savingSkill) setDeleting(null); }}>
      <AlertDialogContent finalFocus={() => returnFocus.current?.isConnected ? returnFocus.current : skillList.current?.querySelector<HTMLElement>(".customize-item")}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
          <AlertDialogDescription>Move this skill’s folder to Trash? You can undo for 4 seconds.</AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm break-all">{deleting && folderOf(deleting.path)}</p>
        {deletingError && <p role="alert" className="text-sm text-destructive">{deletingError}</p>}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={savingSkill} />}>Cancel</AlertDialogClose>
          <Button variant="destructive" disabled={savingSkill} onClick={() => void deleteSkill()}>{savingSkill ? "Deleting…" : "Delete"}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
