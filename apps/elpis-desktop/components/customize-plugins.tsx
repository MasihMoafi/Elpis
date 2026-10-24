"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { SettingsEmpty, SettingsNotice } from "@/components/settings/rows";
import { CustomizeRow } from "@/components/customize-row";
import { api, unreadable } from "@/lib/api";

export type Plugin = { id: string; name: string; description: string; marketplace: string; enabled: boolean };
export type ConfigWrite = { version?: string | null; write?: { available: boolean } };
export type PluginChange = { action: "enable" | "uninstall" | "install"; id: string; enabled?: boolean; version?: string | null };
type CatalogPlugin = Plugin & { pluginName: string; marketplaceName: string; marketplacePath: string | null; installed: boolean; installable: boolean; reason: string | null };
type Catalog = { marketplaces: { name: string; displayName: string; path: string | null }[]; appCatalogs?: { app: string; label: string; added: boolean }[]; plugins: CatalogPlugin[]; errors: string[]; nextCursor: string | null };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CustomizePlugins({ cwd, plugins, loaded, config, onChange, onReload }: { cwd: string | null; plugins: Plugin[]; loaded: boolean; config: ConfigWrite; onChange: (change: PluginChange) => Promise<string[]>; onReload: () => Promise<void> }) {
  const [browse, setBrowse] = useState(false), [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({}), [notice, setNotice] = useState("");
  const locked = useRef(false);
  const run = async (key: string, change: PluginChange) => {
    if (locked.current) return false;
    locked.current = true; setPending(key); setErrors(previous => ({ ...previous, [key]: "" })); setNotice("");
    try {
      const auth = await onChange(change);
      if (auth.length) setNotice(`Installed. Connect ${auth.join(", ")} to finish setup.`);
      return true;
    } catch (error) { setErrors(previous => ({ ...previous, [key]: message(error) })); await onReload(); return false; }
    finally { locked.current = false; setPending(null); }
  };
  const writable = !!config.version && config.write?.available === true;
  return <>
    <div className="customize-title"><h2>Your plugins</h2><Button size="sm" aria-expanded={browse} onClick={() => setBrowse(value => !value)}><Plus />Add plugins</Button></div>
    <p className="customize-note">Plugins bundle skills, tools and connectors. Add a Codex or Claude Code marketplace to find more.</p>
    {notice && <SettingsNotice>{notice}</SettingsNotice>}
    {pending && <SettingsNotice>Saving plugin changes…</SettingsNotice>}
    {loaded && !plugins.length && <SettingsEmpty title="No plugins installed" />}
    <ul className="customize-list">{plugins.map(plugin => <CustomizeRow key={plugin.id} name={plugin.name} description={plugin.description} badge={plugin.marketplace || "Local"}
      error={errors[plugin.id]} notice={!writable ? "Reload Customize to read writable plugin settings." : undefined}>
      <Switch aria-label={`Use ${plugin.name}`} checked={plugin.enabled} disabled={pending !== null || !writable} onCheckedChange={enabled => void run(plugin.id, { action: "enable", id: plugin.id, enabled, version: config.version })} />
      <Button size="sm" variant="ghost" aria-label={`Uninstall ${plugin.name}`} disabled={pending !== null} onClick={() => void run(plugin.id, { action: "uninstall", id: plugin.id })}>Uninstall</Button>
    </CustomizeRow>)}</ul>
    {browse && <PluginCatalog cwd={cwd} version={config.version} pending={pending !== null} install={plugin => run(plugin.id, { action: "install", id: plugin.id })} errors={errors} onReload={onReload} />}
  </>;
}

function PluginCatalog({ cwd, version, pending, install, errors, onReload }: { cwd: string | null; version?: string | null; pending: boolean; install: (plugin: CatalogPlugin) => Promise<boolean>; errors: Record<string, string>; onReload: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null), [query, setQuery] = useState(""), [search, setSearch] = useState("");
  const [source, setSource] = useState(""), [loading, setLoading] = useState(false), [fetchError, setFetchError] = useState("");
  const [changing, setChanging] = useState<string | null>(null), [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const request = useRef(0), locked = useRef(false);
  const load = useCallback(async (cursor?: string) => {
    const id = ++request.current;
    setLoading(true); setFetchError("");
    try {
      const params = new URLSearchParams({ ...(cwd ? { cwd } : {}), ...(search ? { search } : {}), ...(cursor ? { cursor } : {}) });
      const result = await api<Catalog>(`/customize/plugins?${params}`);
      if (!Array.isArray(result.marketplaces) || !Array.isArray(result.plugins) || !Array.isArray(result.errors)) throw unreadable("plugin catalog");
      if (request.current === id) setCatalog(previous => cursor && previous ? { ...result, plugins: [...previous.plugins, ...result.plugins.filter(plugin => !previous.plugins.some(item => item.id === plugin.id))] } : result);
    } catch (error) { if (request.current === id) setFetchError(message(error)); }
    finally { if (request.current === id) setLoading(false); }
  }, [cwd, search]);
  useEffect(() => { setCatalog(null); void load(); return () => { request.current++; }; }, [load, version]);
  const marketplace = async (key: string, body: { action: "add"; source: string } | { action: "add-app"; app: string } | { action: "remove"; name: string }) => {
    if (locked.current) return;
    locked.current = true; setChanging(key); setActionErrors(previous => ({ ...previous, [key]: "" }));
    try {
      await api("/customize/marketplace", { ...body, ...(cwd ? { cwd } : {}) });
      if (body.action !== "remove") setSource("");
      await Promise.all([load(), onReload()]);
    } catch (error) { setActionErrors(previous => ({ ...previous, [key]: message(error) })); }
    finally { locked.current = false; setChanging(null); }
  };
  const busy = pending || changing !== null || loading;
  return <section className="mt-5 grid gap-3" aria-label="Plugin catalog">
    <div className="customize-title"><h2>Add plugins</h2><Button variant="ghost" size="icon-sm" aria-label="Refresh plugins" disabled={busy} onClick={() => void load()}><RefreshCw /></Button></div>
    {!!catalog?.appCatalogs?.some(item => !item.added) && <div className="flex flex-wrap items-center gap-2">
      {catalog.appCatalogs.filter(item => !item.added).map(item => <Button key={item.app} size="sm" variant="outline" disabled={busy} onClick={() => void marketplace("add", { action: "add-app", app: item.app })}>Add the {item.label} plugins</Button>)}
      <span className="customize-note">Catalogs already on this computer; add one to search its plugins.</span>
    </div>}
    <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); if (query.trim() === search) void load(); else setSearch(query.trim()); }}>
      <Input className="flex-1" aria-label="Search plugins" placeholder="Search plugins" value={query} maxLength={1000} onChange={event => setQuery(event.target.value)} />
      <Button size="sm" variant="outline" type="submit" disabled={pending || changing !== null}>Search</Button>
    </form>
    {fetchError && <SettingsNotice tone="alert">{fetchError}</SettingsNotice>}
    {loading && <SettingsNotice>Reading plugin catalogs…</SettingsNotice>}
    {catalog?.errors.map((error, index) => <SettingsNotice key={index} tone="alert">{error}</SettingsNotice>)}
    {catalog && !loading && !catalog.plugins.length && <SettingsEmpty title={search ? "No plugins match this search" : "No plugins available"} />}
    <ul className="customize-list">{catalog?.plugins.map(plugin => <CustomizeRow key={plugin.id} name={plugin.name} description={plugin.description} badge={plugin.marketplace} error={errors[plugin.id]} notice={!plugin.installed && !plugin.installable ? plugin.reason || "Unavailable" : undefined}>
      {plugin.installed ? <span className="customize-state">Installed</span> : <Button size="sm" variant="outline" aria-label={`Install ${plugin.name}`} disabled={busy || !plugin.installable} onClick={() => void install(plugin).then(ok => { if (ok) void load(); })}>Install</Button>}
    </CustomizeRow>)}</ul>
    {catalog?.nextCursor && <Button variant="ghost" disabled={busy} onClick={() => void load(catalog.nextCursor!)}>Load more</Button>}
    <section aria-label="Marketplaces" className="grid gap-3">
      <div className="customize-title"><h2>Marketplaces</h2></div>
      <details className="grid gap-3">
        <DisclosureSummary className="cursor-pointer">Advanced: add from Git URL or folder</DisclosureSummary>
        <p className="customize-note">A Git URL (or owner/repo) or a folder on this computer that holds a Codex or Claude Code marketplace.</p>
        <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); if (source.trim() && !busy) void marketplace("add", { action: "add", source: source.trim() }); }}>
          <Input className="flex-1" aria-label="Marketplace source" placeholder="https://github.com/heygen-com/hyperframes" value={source} maxLength={4096} onChange={event => setSource(event.target.value)} />
          <Button type="submit" size="sm" variant="outline" disabled={busy || !source.trim()}>Add marketplace</Button>
        </form>
        {!source.trim() && <SettingsNotice>Enter a Git URL or folder to add a marketplace.</SettingsNotice>}
      </details>
      {changing && <SettingsNotice>Updating marketplaces…</SettingsNotice>}
      {actionErrors.add && <SettingsNotice tone="alert">{actionErrors.add}</SettingsNotice>}
      {catalog && !catalog.marketplaces.length && <SettingsEmpty title="No marketplaces added" />}
      <ul className="customize-list">{catalog?.marketplaces.map(market => <CustomizeRow key={market.name} name={market.displayName} description={market.path || "Remote catalog"} error={actionErrors[market.name]}>
        <Button size="sm" variant="ghost" aria-label={`Remove ${market.displayName}`} disabled={busy} onClick={() => void marketplace(market.name, { action: "remove", name: market.name })}>Remove</Button>
      </CustomizeRow>)}</ul>
    </section>
  </section>;
}
