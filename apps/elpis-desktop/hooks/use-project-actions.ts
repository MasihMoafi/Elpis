/** Owns project selection, saved folders, and moving a chat between folders. */
import { useState, type Dispatch, type SetStateAction } from "react";
import { chooseProject } from "@/components/project-picker";
import { api, type Thread } from "@/lib/api";
import { saveProjects, type Project } from "@/lib/projects";

type Setter<T> = Dispatch<SetStateAction<T>>;
export function useProjectState() {
  const [cwd, setCwd] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectChanging, setProjectChanging] = useState(false);
  const project = projects.find(item => item.id === projectId) ?? null;
  const [projectEdit, setProjectEdit] = useState<Project | null | undefined>(undefined);
  return { cwd, setCwd, projects, setProjects, projectId, setProjectId, projectChanging,
    setProjectChanging, project, projectEdit, setProjectEdit };
}
type Props = {
  projects: Project[]; setProjects: Setter<Project[]>; projectId: string | null;
  setProjectId: Setter<string | null>; setProjectChanging: Setter<boolean>;
  setCwd: Setter<string>; setProjectEdit: Setter<Project | null | undefined>;
  openNewChat: (draftKey?: string) => void; selected: Thread | null;
  patchThread: (id: string, patch: Partial<Thread>) => void; setError: Setter<string>;
};

export function useProjectActions({ projects, setProjects, projectId, setProjectId, setProjectChanging,
  setCwd, setProjectEdit, openNewChat, selected, patchThread, setError }: Props) {
  async function selectProject(next: Project | null) {
    setProjectChanging(true);
    try {
      if (next && window.elpisDesktop?.resolveFolder) await window.elpisDesktop.resolveFolder(next.cwd);
      await saveProjects(projects, next?.id ?? null); setProjectId(next?.id ?? null); setCwd(next?.cwd ?? ""); openNewChat(next ? `new-${next.id}` : "new");
    } finally { setProjectChanging(false); }
  }
  async function saveProject(next: Project) {
    const known = projects.some(item => item.id === next.id), updated = known ? projects.map(item => item.id === next.id ? next : item) : [...projects, next];
    if (known) { await saveProjects(updated, projectId); setProjects(updated); if (projectId === next.id) setCwd(next.cwd); return; }
    await saveProjects(updated, next.id); setProjects(updated); setProjectId(next.id); setCwd(next.cwd); openNewChat(`new-${next.id}`);
  }
  /** "Add new project" in the sidebar and the project menu: one click opens the native folder chooser, as in the ChatGPT app.
   * A browser has no chooser, so it asks for the path instead. */
  async function addProject() {
    try {
      const chosen = await chooseProject(projects);
      if (chosen === undefined) setProjectEdit(null);
      else if (chosen) await (projects.some(item => item.id === chosen.id) ? selectProject(chosen) : saveProject(chosen));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  /** Moves the open chat to a project's folder (A26): its next turns run there; earlier turns keep theirs. */
  async function moveChat(target: Project | null) {
    if (!selected || !target) return;
    const { cwd: moved } = await api<{ cwd: string }>(`/threads/${encodeURIComponent(selected.id)}/folder`, { cwd: target.cwd });
    patchThread(selected.id, { cwd: moved });
  }
  /** The chip's "Choose folder…": the native chooser, then the move; cancelling moves nothing. */
  async function moveChatToFolder() {
    try { const chosen = await chooseProject(projects); if (chosen) await moveChat(chosen); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  /** Forgets the project; its folder and chats stay as they are. */
  async function removeProject(item: Project) {
    const updated = projects.filter(other => other.id !== item.id), current = projectId === item.id ? null : projectId;
    try { await saveProjects(updated, current); setProjects(updated); if (!current) { setProjectId(null); setCwd(""); } }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return { selectProject, saveProject, addProject, moveChat, moveChatToFolder, removeProject };
}
