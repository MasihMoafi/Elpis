"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, Plug } from "lucide-react";
import { api } from "@/lib/api";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type Server = { name: string; enabled: boolean; transport: "stdio" | "http"; command: string | null; url: string | null };
type Snapshot = { servers: Server[] };
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const INTERNAL = new Set(["elpis-agents", "elpis_browser"]);

/** Start-only choices for the new chat. The bridge applies this list to thread/start and never writes config. */
export function McpSessionMenu({ value, disabled, onChange }: { value?: string[]; disabled?: boolean; onChange: (servers?: string[]) => void }) {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let disposed = false;
    api<Snapshot>("/mcp").then(result => {
      if (!Array.isArray(result.servers)) throw new Error("Elpis returned an unreadable MCP server list.");
      if (!disposed) setServers(result.servers.filter(server => NAME.test(server.name) && !INTERNAL.has(server.name)
        && ((server.transport === "stdio" && typeof server.command === "string") || (server.transport === "http" && typeof server.url === "string"))));
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!servers || value === undefined) return;
    const enabled = new Set(servers.filter(server => server.enabled).map(server => server.name));
    const valid = value.filter(name => enabled.has(name));
    if (valid.length !== value.length) onChange(valid);
  }, [servers, value, onChange]);

  if (error) return <span role="status" className="px-2 text-xs text-muted-foreground" title={error}>MCP choices unavailable</span>;
  if (!servers?.length) return null;
  const available = new Set(servers.filter(server => server.enabled).map(server => server.name));
  const selected = new Set((value ?? [...available]).filter(name => available.has(name)));
  const toggle = (name: string) => onChange([...selected].includes(name) ? [...selected].filter(server => server !== name) : [...selected, name]);
  const label = `${selected.size} selected`;
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger data-slot="composer-chip" className="composer-pill" disabled={disabled} aria-label="Choose MCP servers for this chat" aria-description={`${label} MCP servers`} title={`${label} MCP servers. This choice applies only to a new chat.`}>
      <Plug size={16} aria-hidden="true" /><span className="pill-long">MCP servers</span><span className="pill-short">MCP</span><ChevronDown size={16} aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="hud-menu w-80">
      <p className="hud-menu-title">MCP servers for this chat</p>
      {servers.map(server => {
        const checked = selected.has(server.name);
        return <DropdownMenuItem key={server.name} role="menuitemcheckbox" aria-checked={checked} aria-disabled={!server.enabled} disabled={!server.enabled} className="hud-menu-item" onClick={event => { if (!server.enabled) return; event.preventDefault(); toggle(server.name); }}>
          <span className={`flex size-4 items-center justify-center rounded-sm border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50"}`}>{checked && <Check size={12} aria-hidden="true" />}</span>
          <span className="grid gap-0.5"><span>{server.name}</span><small>{server.enabled ? (server.transport === "http" ? "HTTP" : "Local process") : "Disabled in MCP settings"}</small></span>
        </DropdownMenuItem>;
      })}
      <DropdownMenuItem className="hud-menu-item" onClick={() => onChange(undefined)}>
        <span className="grid gap-0.5"><span>Use configured defaults</span><small>Enabled servers from Settings → MCP</small></span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
