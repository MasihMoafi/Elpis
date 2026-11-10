"use client";

import { message } from "./mcp-credentials";
export { message, LOCAL_RERANKERS, providerName } from "./mcp-credentials";
import { Key, CredentialSettings, RagSettings } from "./mcp-credentials";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { PlusIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SettingsEmpty, SettingsHeader, SettingsNotice } from "@/components/settings/rows";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";

type Credential = { name: string; source: "config" | "environment"; set: boolean };
export type Server = {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string | null;
  url: string | null;
  credentials: Credential[];
  whispertype?: { backend: "openrouter" | "codex" | "local"; model: string | null };
};
type Mcp = {
  configPath?: string | null;
  reloadRequested?: boolean;
  version: string | null;
  write: { available: boolean };
  servers: Server[];
};
type ClaudePreview = {
  revision: string;
  version: string;
  servers: { name: string; transport: string; status: "available" | "exists" | "unsupported" }[];
};
export type Stage = {
  stage: "embedding" | "reranking" | "generation";
  provider: string | null;
  model: string | null;
  location: "local" | "api" | null;
};
export type Rag = { stages: Stage[]; keys: { openrouter: boolean } };
/** A reply without its server list (an older or failing bridge) reads as no servers, never as a broken page. */
const readMcp = (value: Mcp): Mcp => ({
  ...value,
  servers: Array.isArray(value?.servers) ? value.servers : [],
  write: value?.write ?? { available: false },
});

export function McpSettings({ onOpenVoice, onCustomize }: { onOpenVoice?: () => void; onCustomize?: (() => void) | undefined }) {
  const [notice, setNotice] = useState("");
  const [data, setData] = useState<Mcp | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<ClaudePreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", command: "", args: "" });
  const [removing, setRemoving] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(readMcp(await api<Mcp>("/mcp")));
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(name: string, body: Record<string, unknown>) {
    setError("");
    try {
      setNotice("");
      const saved = readMcp(await api<Mcp>("/mcp", { version: data?.version, name, ...body }));
      setData(saved);
      if (saved.reloadRequested === false)
        setNotice("Settings saved. Elpis could not refresh the active tools; reconnect Elpis to apply them.");
    } catch (e) {
      setError(message(e));
      await load();
      throw e;
    }
  }
  async function previewImport() {
    setError("");
    setNotice("");
    setImporting(true);
    try {
      setPreview(await api<ClaudePreview>("/mcp/import"));
      setSelected([]);
    } catch (e) {
      setError(message(e));
    } finally {
      setImporting(false);
    }
  }
  async function importSelected() {
    if (!preview) return;
    setError("");
    setImporting(true);
    try {
      const result = await api<{ imported: number }>("/mcp/import", {
        names: selected,
        version: preview.version,
        revision: preview.revision,
      });
      setPreview(null);
      setSelected([]);
      setNotice(
        `Imported ${result.imported} MCP server${result.imported === 1 ? "" : "s"}. Reconnect Elpis to use them.`,
      );
      await load();
    } catch (e) {
      setError(message(e));
      setPreview(null);
      await load();
    } finally {
      setImporting(false);
    }
  }
  async function add(event: React.FormEvent) {
    event.preventDefault();
    try {
      await save(draft.name.trim(), {
        action: "add",
        command: draft.command.trim(),
        args: draft.args
          .split("\n")
          .map(arg => arg.trim())
          .filter(Boolean),
      });
      setAdding(false);
      setDraft({ name: "", command: "", args: "" });
    } catch {}
  }
  return (
    <div aria-label="MCP servers">
      <SettingsHeader
        title="MCP servers"
        description={
          <>
            Server choices apply to new chats; stored API keys stay on this device.
            {onCustomize && (
              <>
                {" "}Plugins and skills are in{" "}
                <Button variant="link" className="h-auto p-0" onClick={onCustomize}>
                  Customize
                </Button>
                .
              </>
            )}
          </>
        }
        action={
          <Button variant="outline" onClick={() => setAdding(true)} disabled={!data?.write?.available}>
            <PlusIcon />
            Add MCP server
          </Button>
        }
      />
      <div className="settings-stack">
        {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
        {notice && <SettingsNotice>{notice}</SettingsNotice>}
        {data?.configPath && (
          <details className="text-xs text-muted-foreground">
            <DisclosureSummary className="cursor-pointer">Configuration file</DisclosureSummary>
            <p className="mt-2 break-all">{data.configPath}</p>
          </details>
        )}
        <Button variant="outline" disabled={importing || !data?.write?.available} onClick={() => void previewImport()}>
          Import from Claude Code
        </Button>
        {preview && (
          <section className="settings-card settings-form" aria-label="Import Claude Code MCP servers">
            <p className="text-sm">
              Choose servers to import. Existing servers are kept. Imported servers start when Elpis reconnects.
            </p>
            {preview.servers.length === 0 && (
              <SettingsEmpty title="No Claude Code servers found">No global MCP servers were found.</SettingsEmpty>
            )}
            {preview.servers.map(server => (
              <label className="flex items-center gap-2 text-sm" key={server.name}>
                <input
                  type="checkbox"
                  checked={selected.includes(server.name)}
                  disabled={importing || server.status !== "available"}
                  onChange={event =>
                    setSelected(old =>
                      event.target.checked ? [...old, server.name] : old.filter(name => name !== server.name),
                    )
                  }
                />
                <span>
                  {server.name} · {server.transport}
                  {server.status === "exists"
                    ? " · already in Elpis"
                    : server.status === "unsupported"
                      ? " · unsupported definition"
                      : ""}
                </span>
              </label>
            ))}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={importing} onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button disabled={importing || !selected.length} onClick={() => void importSelected()}>
                {importing ? "Importing…" : "Import selected"}
              </Button>
            </div>
          </section>
        )}
        {adding && (
          <form
            className="settings-card settings-form"
            aria-label="Add MCP server"
            onSubmit={event => {
              void add(event);
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field">
                Server name
                <Input
                  value={draft.name}
                  onChange={e => setDraft({ ...draft, name: e.target.value })}
                  placeholder="letters, numbers, - or _"
                />
              </label>
              <label className="field">
                Command
                <Input
                  value={draft.command}
                  onChange={e => setDraft({ ...draft, command: e.target.value })}
                  placeholder="/path/to/server or an executable name"
                />
              </label>
            </div>
            <label className="field">
              Arguments
              <Textarea
                value={draft.args}
                onChange={e => setDraft({ ...draft, args: e.target.value })}
                placeholder="One argument per line"
                rows={2}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!draft.name.trim() || !draft.command.trim()}>
                Save server
              </Button>
            </div>
          </form>
        )}
        {!data && !error && <SettingsNotice>Reading MCP servers…</SettingsNotice>}
        {data && !data.servers.length && (
          <SettingsEmpty title="No MCP servers are configured">Add one to give your agents its tools.</SettingsEmpty>
        )}
        {data?.servers.map(server => (
          <section
            key={server.name}
            className="mcp-server settings-card"
            data-name={server.name}
            aria-label={server.name}
          >
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h3 className="font-mono">{server.name}</h3>
              <span className="settings-scope">new chats</span>
              <span
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                title={server.command ?? server.url ?? ""}
              >
                {server.transport === "http" ? server.url : server.command}
              </span>
              <Switch
                aria-label={`Enable ${server.name}`}
                checked={server.enabled}
                disabled={!data.write?.available}
                onCheckedChange={enabled => void save(server.name, { action: "enable", enabled }).catch(() => {})}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${server.name}`}
                disabled={!data.write?.available}
                onClick={() => setRemoving(server.name)}
              >
                <Trash2 size={14} />
              </Button>
            </header>
            {server.credentials.length > 0 && (
              <ul className="grid gap-1 text-sm">
                {server.credentials.map(item => (
                  <Key
                    key={`${item.source}:${item.name}`}
                    name={item.name}
                    set={item.set}
                    note={item.source === "environment" ? "from the environment" : "in config"}
                  />
                ))}
              </ul>
            )}
            <CredentialSettings
              server={server}
              disabled={!data.write?.available}
              save={body => save(server.name, body)}
            />
            {server.name === "rag" && <RagSettings version={data.version} />}
            {server.name === "whispertype" && (
              <p className="provider-note">
                The microphone’s transcription route is set under Voice.
                {onOpenVoice && (
                  <>
                    {" "}
                    <Button variant="link" size="xs" className="h-auto p-0 align-baseline" onClick={onOpenVoice}>
                      Open Voice settings
                    </Button>
                  </>
                )}
              </p>
            )}
          </section>
        ))}
      </div>
      <AlertDialog
        open={!!removing}
        onOpenChange={open => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Elpis agents lose this server's tools. Its entry is deleted from your Elpis config.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const name = removing;
                setRemoving(null);
                if (name) void save(name, { action: "remove" }).catch(() => {});
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
