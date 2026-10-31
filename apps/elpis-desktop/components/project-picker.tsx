"use client";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Check, Laptop, X } from "lucide-react";
import { BranchIcon, FolderIcon, PlusIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MoreMenu, RightClickMenu, type MenuAction } from "@/components/action-menu";
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader } from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";
import type { Project } from "@/lib/projects";

const message = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);

/** Where a new chat works, as in the ChatGPT app: the project named in the new-chat heading
 * and the folder chip above the composer open the same menu. A started chat's chip (`label` "Change folder") moves
 * that chat: `addLabel` names the chooser item, and `allowNone` false drops "Don't work in a project". */
export function MoveChatDialog({ name, projects, currentId, count = 1, onMove, onClose }: { name: string | null; projects: Project[]; currentId: string | null | undefined; count?: number; onMove: (id: string | null) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setError(""); }, [name]);
  async function move(id: string | null) {
    setBusy(true); setError("");
    try { await onMove(id); onClose(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <AlertDialog open={name !== null} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{count > 1 ? `Move ${count} chats to project` : "Move chat to project"}</AlertDialogTitle><AlertDialogDescription>{name}</AlertDialogDescription></AlertDialogHeader>
      <ul className="menu w-full max-h-80 overflow-y-auto p-0">
        {projects.map(project => <li key={project.id}><Button variant="ghost" className="justify-start" disabled={busy || currentId === project.id} onClick={() => void move(project.id)}><FolderIcon size={14} />{project.name}{currentId === project.id && <Check size={14} />}</Button></li>)}
        <li><Button variant="ghost" className="justify-start" disabled={busy || currentId === null} onClick={() => void move(null)}>No project</Button></li>
      </ul>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

export function ProjectMenu({ projects, selected, disabled, variant, onSelect, onAdd, label = "Choose project", addLabel = "New project…", allowNone = true, noneLabel = "Don’t work in a project" }: {
  projects: Project[]; selected: Project | null; disabled: boolean; variant: "heading" | "chip";
  onSelect: (project: Project | null) => Promise<void>; onAdd: () => void; label?: string; addLabel?: string; allowNone?: boolean; noneLabel?: string;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function choose(project: Project | null) { setBusy(true); setError(""); try { await onSelect(project); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  return <>
    <DropdownMenu>
      {variant === "heading"
        ? <DropdownMenuTrigger className="project-heading-trigger" title={selected?.cwd} disabled={disabled || busy}>{selected?.name}</DropdownMenuTrigger>
        : <DropdownMenuTrigger data-slot="composer-chip" className="composer-chip project-chip" aria-label={label} title={selected?.cwd} disabled={disabled || busy}><FolderIcon size={13} aria-hidden="true" /><span>{selected?.name || "Work in a project"}</span></DropdownMenuTrigger>}
      <DropdownMenuContent align="start" className="project-menu w-72">
        {projects.map(project => <DropdownMenuItem key={project.id} onClick={() => void choose(project)}>
          <FolderIcon aria-hidden="true" /><span className="project-option"><strong>{project.name}</strong><small>{project.cwd}</small></span>
          {project.id === selected?.id && <Check className="ml-auto" aria-label="Current" />}
        </DropdownMenuItem>)}
        <DropdownMenuItem onClick={onAdd}><PlusIcon aria-hidden="true" />{addLabel}</DropdownMenuItem>
        {selected && allowNone && <DropdownMenuItem onClick={() => void choose(null)}><X aria-hidden="true" />{noneLabel}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    {error && <span role="alert" className="project-error">{error}</span>}
  </>;
}

/** The ChatGPT app's "Add new project": the native folder chooser, then a project named after the folder;
 * a project that already has the folder is returned instead. Null when cancelled; undefined without a desktop chooser. */
export async function chooseProject(projects: Project[]): Promise<Project | null | undefined> {
  const choose = window.elpisDesktop?.chooseFolder; if (!choose) return undefined;
  const folder = await choose().catch((e: unknown) => { throw Error(message(e)); });
  return folder ? projectAt(projects, folder) : null;
}
/** The project that has `folder`, or a new one named after it. */
export const projectAt = (projects: Project[], folder: string): Project =>
  projects.find(project => project.cwd.replace(/\/+$/, "") === folder.replace(/\/+$/, "")) ?? { id: crypto.randomUUID(), name: folder.split("/").filter(Boolean).at(-1) || folder, cwd: folder };

/** A sidebar project's menu, after the ChatGPT app's project actions: one list drawn by the "…" button and by right-click on `area`.
 * `children` draws the area's contents; `menu` is the "…" button, to place where it belongs. */
export function ProjectActions({ project, onEdit, onRemove, area, children }: {
  project: Project; onEdit: (project: Project) => void; onRemove: (project: Project) => void; area: ReactElement; children: (menu: ReactNode) => ReactNode;
}) {
  const [error, setError] = useState("");
  const openFolder = typeof window === "undefined" ? undefined : window.elpisDesktop?.openFolder;
  const actions: MenuAction[] = [
    { id: "edit", label: "Edit…", run: () => onEdit(project) },
    ...(openFolder ? [{ id: "folder", label: "Open in file manager", run: () => { setError(""); openFolder(project.cwd).catch(e => setError(message(e))); } }] : []),
    { id: "remove", label: "Remove project", run: () => onRemove(project) },
  ];
  return <>
    <RightClickMenu actions={actions} area={area} menuClassName="w-56">
      {children(<MoreMenu actions={actions} label={`Project actions for ${project.name}`} title="Project actions" size={13} align="start" menuClassName="w-56" />)}
    </RightClickMenu>
    {error && <p role="alert" className="project-error">{error}</p>}
  </>;
}

/** Add or edit a project: `editing` is the project, `null` for a new one, `undefined` when closed. */
export function ProjectDialog({ projects, editing, folders = [], description, onClose, onSave }: {
  projects: Project[]; editing: Project | null | undefined; folders?: string[]; description?: string; onClose: () => void; onSave: (project: Project) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false), [name, setName] = useState(""), [cwd, setCwd] = useState(""), [error, setError] = useState("");
  const knownFolders = [...new Set([editing?.cwd, cwd, ...projects.map(project => project.cwd), ...folders].filter((folder): folder is string => !!folder && folder.startsWith("/")))];
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
  return <AlertDialog open={editing !== undefined} onOpenChange={next => { if (!next && !busy) onClose(); }}><AlertDialogContent className="project-dialog"><AlertDialogHeader><AlertDialogTitle>{editing ? "Edit project" : "New project"}</AlertDialogTitle><AlertDialogDescription>{description ?? "Choose where Elpis works. Existing conversations keep their own folder."}</AlertDialogDescription></AlertDialogHeader>
    <form onSubmit={save} className="grid gap-4"><label className="field">Project name<Input autoFocus aria-label="Project name" value={name} maxLength={120} onChange={e => setName(e.target.value)} placeholder="Name of your project" disabled={busy} /></label>
      <label className="field">Working folder<OptionSelect aria-label="Working folder" value={cwd} onChange={e => { setCwd(e.target.value); setError(""); }} required disabled={busy}><option value="" disabled>Choose a folder</option>{knownFolders.map(folder => <option key={folder} value={folder}>{folder}</option>)}</OptionSelect></label>
      {typeof window !== "undefined" && window.elpisDesktop?.chooseFolder && <Button type="button" variant="outline" onClick={() => void browse()} disabled={busy}><FolderIcon size={15} />Choose folder…</Button>}
      <details><DisclosureSummary>Advanced: custom folder</DisclosureSummary><label className="field">Working folder<Input aria-label="Workspace directory" value={cwd} onChange={e => { setCwd(e.target.value); setError(""); }} placeholder="Absolute folder path" maxLength={4096} disabled={busy} /></label></details>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !cwd.trim()} disabledReason={busy ? "Saving the project…" : "Choose a project folder."}>{busy ? "Saving…" : "Save project"}</Button></AlertDialogFooter>
    </form>
  </AlertDialogContent></AlertDialog>;
}

const DEFAULT_FOLDER = "Elpis's default folder";
/** Where a new chat works, beside the project chip: "Local" is the folder itself (the project's, or with none the folder
 * Elpis starts in); "Worktree" is Claude's "Start with worktree", a worktree of its own on a new branch, which needs a
 * Git repository with a commit (GET /api/repository). */
export function EnvironmentMenu({ folder, disabled, worktree, onWorktree }: { folder: string | null; disabled: boolean; worktree: boolean; onWorktree: (on: boolean) => void }) {
  const [repository, setRepository] = useState<boolean | null>(null);
  useEffect(() => {
    if (!folder) { setRepository(false); return; }
    let live = true; setRepository(null);
    api<{ repository?: boolean }>(`/repository?cwd=${encodeURIComponent(folder)}`).then(result => { if (live) setRepository(result.repository === true); }, () => { if (live) setRepository(false); });
    return () => { live = false; };
  }, [folder]);
  useEffect(() => { if (repository === false && worktree) onWorktree(false); }, [repository, worktree, onWorktree]);
  const Icon = worktree ? BranchIcon : Laptop;
  return <DropdownMenu>
    <DropdownMenuTrigger data-slot="composer-chip" className="composer-chip project-chip" aria-label="Where this chat works" title={worktree ? `A new worktree of ${folder}` : folder ?? DEFAULT_FOLDER} disabled={disabled}><Icon size={13} aria-hidden="true" /><span>{worktree ? "Worktree" : "Local"}</span></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="project-menu w-72">
      <DropdownMenuItem onClick={() => onWorktree(false)}><Laptop aria-hidden="true" /><span className="project-option"><strong>Local</strong><small>{folder ?? DEFAULT_FOLDER}</small></span>{!worktree && <Check className="ml-auto" aria-label="Current" />}</DropdownMenuItem>
      <DropdownMenuItem disabled={repository !== true} onClick={() => onWorktree(true)}><BranchIcon aria-hidden="true" /><span className="project-option"><strong>Worktree</strong><small>{repository === false ? "Needs a Git repository with a commit" : "Own worktree, new branch"}</small></span>{worktree && <Check className="ml-auto" aria-label="Current" />}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
