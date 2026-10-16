"use client";
import { useEffect, useState } from "react";
import { Check, MoreHorizontal, X } from "lucide-react";
import { FolderIcon, PlusIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog";
import type { Project } from "@/lib/projects";

const message = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);

/** Where a new chat works, as in the ChatGPT app: the project named in the new-chat heading
 * and the folder chip above the composer open the same menu. */
export function ProjectMenu({ projects, selected, disabled, variant, onSelect, onEdit }: {
  projects: Project[]; selected: Project | null; disabled: boolean; variant: "heading" | "chip";
  onSelect: (project: Project | null) => Promise<void>; onEdit: (project: Project | null) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function choose(project: Project | null) { setBusy(true); setError(""); try { await onSelect(project); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  return <>
    <DropdownMenu>
      {variant === "heading"
        ? <DropdownMenuTrigger className="project-heading-trigger" title={selected?.cwd} disabled={disabled || busy}>{selected?.name}</DropdownMenuTrigger>
        : <DropdownMenuTrigger className="composer-chip project-chip" aria-label="Choose project" title={selected?.cwd} disabled={disabled || busy}><FolderIcon size={13} aria-hidden="true" /><span>{selected?.name || "Work in a project"}</span></DropdownMenuTrigger>}
      <DropdownMenuContent align="start" className="hud-menu project-menu w-72">
        {projects.map(project => <DropdownMenuItem key={project.id} className="hud-menu-item" onClick={() => void choose(project)}>
          <FolderIcon aria-hidden="true" /><span className="project-option"><strong>{project.name}</strong><small>{project.cwd}</small></span>
          {project.id === selected?.id && <Check className="ml-auto" aria-label="Current" />}
        </DropdownMenuItem>)}
        <DropdownMenuItem className="hud-menu-item" onClick={() => onEdit(null)}><PlusIcon aria-hidden="true" />New project…</DropdownMenuItem>
        {selected && <DropdownMenuItem className="hud-menu-item" onClick={() => void choose(null)}><X aria-hidden="true" />Don’t work in a project</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    {error && <span role="alert" className="project-error">{error}</span>}
  </>;
}

/** A sidebar project's menu, after the ChatGPT app's project actions. */
export function ProjectActions({ project, onEdit, onRemove }: { project: Project; onEdit: (project: Project) => void; onRemove: (project: Project) => void }) {
  const [error, setError] = useState("");
  const openFolder = typeof window === "undefined" ? undefined : window.elpisDesktop?.openFolder;
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Project actions for ${project.name}`} title="Project actions" />}><MoreHorizontal size={13} /></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="hud-menu w-56">
        <DropdownMenuItem className="hud-menu-item" onClick={() => onEdit(project)}>Edit…</DropdownMenuItem>
        {openFolder && <DropdownMenuItem className="hud-menu-item" onClick={() => { setError(""); openFolder(project.cwd).catch(e => setError(message(e))); }}>Open in file manager</DropdownMenuItem>}
        <DropdownMenuItem className="hud-menu-item" onClick={() => onRemove(project)}>Remove project</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {error && <p role="alert" className="project-error">{error}</p>}
  </>;
}

/** Add or edit a project: `editing` is the project, `null` for a new one, `undefined` when closed. */
export function ProjectDialog({ projects, editing, onClose, onSave }: {
  projects: Project[]; editing: Project | null | undefined; onClose: () => void; onSave: (project: Project) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false), [name, setName] = useState(""), [cwd, setCwd] = useState(""), [error, setError] = useState("");
  useEffect(() => { if (editing !== undefined) { setName(editing?.name ?? ""); setCwd(editing?.cwd ?? ""); setError(""); } }, [editing]);
  async function browse() {
    try { const folder = await window.elpisDesktop?.chooseFolder?.(); if (folder) { setError(""); setCwd(folder); if (!name.trim()) setName(folder.split("/").filter(Boolean).at(-1) || folder); } } catch (e) { setError(message(e)); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const folder = window.elpisDesktop?.resolveFolder ? await window.elpisDesktop.resolveFolder(cwd.trim()) : cwd.trim().replace(/\/+$/, "") || "/";
      if (!cwd.trim().startsWith("/")) throw Error("Choose an absolute folder path.");
      const existing = projects.find(project => project.cwd === folder);
      if (existing && existing.id !== editing?.id) throw Error(`This folder already belongs to “${existing.name}”. Choose it from the project menu.`);
      await onSave({ id: editing?.id || crypto.randomUUID(), name: name.trim() || folder.split("/").filter(Boolean).at(-1) || folder, cwd: folder });
      onClose();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <AlertDialog open={editing !== undefined} onOpenChange={next => { if (!next && !busy) onClose(); }}><AlertDialogContent className="project-dialog"><AlertDialogTitle>{editing ? "Edit project" : "New project"}</AlertDialogTitle><AlertDialogDescription>Choose where Elpis works. Existing conversations keep their own folder.</AlertDialogDescription>
    <form onSubmit={save} className="grid gap-4"><label className="field">Project name<Input autoFocus aria-label="Project name" value={name} maxLength={120} onChange={e => setName(e.target.value)} placeholder="Name of your project" disabled={busy} /></label>
      <label className="field">Working folder<Input aria-label="Workspace directory" value={cwd} onChange={e => { setCwd(e.target.value); setError(""); }} placeholder="Absolute folder path" maxLength={4096} required disabled={busy} /></label>
      {typeof window !== "undefined" && window.elpisDesktop?.chooseFolder && <Button type="button" variant="outline" onClick={() => void browse()} disabled={busy}><FolderIcon size={15} />Choose folder…</Button>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !cwd.trim()}>{busy ? "Saving…" : "Save project"}</Button></AlertDialogFooter>
    </form>
  </AlertDialogContent></AlertDialog>;
}
