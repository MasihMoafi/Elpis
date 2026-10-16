"use client";
import { useState } from "react";
import { Folder, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog";
import type { Project } from "@/lib/projects";

export function ProjectPicker({ projects, selected, disabled, onSelect, onSave }: {
  projects: Project[]; selected: Project | null; disabled: boolean;
  onSelect: (project: Project | null) => Promise<void>; onSave: (project: Project) => Promise<void>;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [name, setName] = useState(""), [cwd, setCwd] = useState(""), [editing, setEditing] = useState<string | null>(null), [error, setError] = useState("");
  const fail = (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
  function edit(project: Project | null) { setEditing(project?.id ?? null); setName(project?.name ?? ""); setCwd(project?.cwd ?? ""); setError(""); setOpen(true); }
  async function choose(project: Project | null) { setBusy(true); setError(""); try { await onSelect(project); } catch (e) { fail(e); } finally { setBusy(false); } }
  async function browse() {
    try { const folder = await window.elpisDesktop?.chooseFolder?.(); if (folder) { setError(""); setCwd(folder); if (!name.trim()) setName(folder.split("/").filter(Boolean).at(-1) || folder); } } catch (e) { fail(e); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const folder = window.elpisDesktop?.resolveFolder ? await window.elpisDesktop.resolveFolder(cwd.trim()) : cwd.trim().replace(/\/+$/, "") || "/";
      if (!cwd.trim().startsWith("/")) throw Error("Choose an absolute folder path.");
      const existing = projects.find(project => project.cwd === folder);
      if (existing && existing.id !== editing) throw Error(`This folder already belongs to “${existing.name}”. Choose it from the project menu.`);
      await onSave({ id: editing || crypto.randomUUID(), name: name.trim() || folder.split("/").filter(Boolean).at(-1) || folder, cwd: folder });
      setOpen(false);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  return <div className="project-picker">
    <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="project-trigger" aria-label="Choose workspace" title={selected?.cwd} disabled={disabled || busy} />}><Folder size={15} /><span>{selected?.name || "All projects"}</span></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="project-menu">
        <DropdownMenuItem onClick={() => void choose(null)}>All projects · default folder</DropdownMenuItem>
        {projects.map(project => <DropdownMenuItem key={project.id} onClick={() => void choose(project)}><span className="project-option"><strong>{project.name}{project.id === selected?.id ? " ✓" : ""}</strong><small>{project.cwd}</small></span></DropdownMenuItem>)}
        <DropdownMenuItem onClick={() => edit(null)}><Plus size={14} />Add project…</DropdownMenuItem>
        {selected && <DropdownMenuItem onClick={() => edit(selected)}>Edit project…</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    {error && !open && <p role="alert" className="project-error">{error}</p>}
    <AlertDialog open={open} onOpenChange={next => { if (!busy) { setOpen(next); if (!next) setError(""); } }}><AlertDialogContent className="project-dialog"><AlertDialogTitle>{editing ? "Edit project" : "Add project"}</AlertDialogTitle><AlertDialogDescription>Choose where Elpis works. Existing conversations keep their own folder.</AlertDialogDescription>
      <form onSubmit={save} className="grid gap-4"><label className="field">Project name<Input autoFocus aria-label="Project name" value={name} maxLength={120} onChange={e => setName(e.target.value)} placeholder="Name of your project" disabled={busy} /></label>
        <label className="field">Working folder<Input aria-label="Workspace directory" value={cwd} onChange={e => { setCwd(e.target.value); setError(""); }} placeholder="Absolute folder path" maxLength={4096} required disabled={busy} /></label>
        {typeof window !== "undefined" && window.elpisDesktop?.chooseFolder && <Button type="button" variant="outline" onClick={() => void browse()} disabled={busy}><Folder size={15} />Choose folder…</Button>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => { setOpen(false); setError(""); }}>Cancel</Button><Button type="submit" disabled={busy || !cwd.trim()}>{busy ? "Saving…" : "Save project"}</Button></AlertDialogFooter>
      </form>
    </AlertDialogContent></AlertDialog>
  </div>;
}
