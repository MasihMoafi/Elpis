import type { Dispatch, RefObject, SetStateAction } from "react";
import { chooseProject, projectAt } from "@/components/project-picker";
import { api, type Thread } from "@/lib/api";
import { chatSelectionRoots, chatSubtree, putChatsUnder, sidebarParents, writeGroups, type ChatGroups } from "@/lib/chat-groups";
import { errorText } from "@/lib/error-text.mts";
import { appStorage, saveProjectChats, saveProjects, type Project } from "@/lib/projects";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useProjectState } from "@/lib/use-project-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useChatGroups } from "@/lib/use-sidebar-state";
import type { View } from "@/lib/workspace-types";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = RefObject<T>;
type Placement = { opened: Record<string, boolean>; section: string; project: string | undefined; group: string | undefined };
type ProjectInputs = {
  projectState: ReturnType<typeof useProjectState>; conversations: ReturnType<typeof useConversationList>; runtime: ReturnType<typeof useRuntimeState>;
  chatGroupsRef: ReturnType<typeof useChatGroups>["chatGroupsRef"]; commitGroups: ReturnType<typeof useChatGroups>["commitGroups"];
  getNativeParents: () => Readonly<Record<string, string | null | undefined>>;
  placementReveal: (target: string, state: ChatGroups, memberships: Record<string, string>, moved: string[]) => Placement;
  revealPlacement: (paths: Placement[]) => void; setMarked: Setter<string[]>; viewRef: Ref<View>; selected: Thread | null;
  openNewChat: (draftKey?: string) => void; setError: Setter<string>;
};

export function createProjectActions({ projectState, conversations, runtime, chatGroupsRef, commitGroups, getNativeParents, placementReveal, revealPlacement, setMarked, viewRef, selected, openNewChat, setError }: ProjectInputs) {
  const { projects, setProjects, projectId, setProjectId, setCwd, projectChatsRef, projectChatSave, setProjectChats, newProjectFor, setNewProjectFor, setProjectChanging, setWorkflowProjectId, setProjectEdit } = projectState;
  const { patchThread } = conversations;
  const { ready, connected } = runtime;
  function assignProject(threadIds: string | string[], destination: string | null | undefined, parentId?: string, arrangeGroups?: (state: ChatGroups, roots: string[]) => ChatGroups): Promise<void> {
    const saved = projectChatSave.current.catch(() => {}).then(async () => {
      const nativeParents = getNativeParents();
      const requested = typeof threadIds === "string" ? [threadIds] : threadIds;
      const currentParents = sidebarParents(Object.keys(nativeParents), chatGroupsRef.current, nativeParents);
      const roots = chatSelectionRoots(requested, currentParents), ids = new Set(chatSubtree(roots, currentParents));
      const previous = projectChatsRef.current, next = { ...previous };
      if (destination !== undefined) for (const id of ids) { if (destination) next[id] = destination; else delete next[id]; }
      if (parentId && (!Object.hasOwn(nativeParents, parentId) || ids.has(parentId))) throw Error("A chat cannot be put under itself or one of its descendants.");
      if (destination !== undefined) await saveProjectChats(next);
      const state = chatGroupsRef.current;
      const latestParents = sidebarParents(Object.keys(nativeParents), state, nativeParents);
      if (parentId && chatSubtree(roots, latestParents).includes(parentId)) { if (destination !== undefined) await saveProjectChats(previous); throw Error("A chat cannot be put under one of its descendants."); }
      let groups = putChatsUnder(state, parentId ? roots : roots.filter(id => !!latestParents[id]), parentId ?? null, nativeParents);
      if (arrangeGroups) groups = arrangeGroups(groups, roots);
      const reveals = parentId ? [placementReveal(parentId, groups, next, roots)] : roots.map(root => placementReveal(root, groups, next, []));
      const revealGroups = new Set(reveals.map(reveal => reveal.group));
      if (groups.collapsed.some(id => revealGroups.has(id))) groups = { ...groups, collapsed: groups.collapsed.filter(id => !revealGroups.has(id)) };
      if (!writeGroups(groups, appStorage())) { if (destination !== undefined) await saveProjectChats(previous); throw Error("Could not save chat placement on this device."); }
      commitGroups(groups);
      projectChatsRef.current = next; setProjectChats(next); setMarked([]);
      revealPlacement(reveals);
    });
    projectChatSave.current = saved; return saved;
  }
  async function selectProject(next: Project | null) {
    setProjectChanging(true);
    try {
      if (next && window.elpisDesktop?.resolveFolder) await window.elpisDesktop.resolveFolder(next.cwd);
      await saveProjects(projects, next?.id ?? null); setWorkflowProjectId(next?.id ?? null);
      if (viewRef.current === "canvas") return;
      setProjectId(next?.id ?? null); setCwd(next?.cwd ?? ""); openNewChat(next ? `new-${next.id}` : "new");
    } finally { setProjectChanging(false); }
  }
  async function saveProject(next: Project) {
    const known = projects.some(item => item.id === next.id), updated = known ? projects.map(item => item.id === next.id ? next : item) : [...projects, next];
    if (known) { await saveProjects(updated, projectId); setProjects(updated); if (projectId === next.id) setCwd(next.cwd); return; }
    await saveProjects(updated, next.id); setProjects(updated); setWorkflowProjectId(next.id);
    if (viewRef.current === "canvas") return;
    setProjectId(next.id); setCwd(next.cwd); openNewChat(`new-${next.id}`);
  }
  function newProjectFrom(chats: Thread[]) { setNewProjectFor(chats); setProjectEdit(null); }
  async function saveProjectFromChats(next: Project) {
    const updated = [...projects, next];
    await saveProjects(updated, projectId);
    try { await assignProject((newProjectFor ?? []).map(chat => chat.id), next.id); }
    catch (cause) { await saveProjects(projects, projectId); throw cause; }
    setProjects(updated); setNewProjectFor(null);
  }
  /** "Add new project" in the sidebar and the project menu: one click opens the native folder chooser, as in the ChatGPT app.
   * A browser has no chooser, so it asks for the path instead. */
  /** Workflows' own folder choice (Transcribe images): the project that has it, or a new one named after it. */
  async function workIn(folder: string) {
    const next = projectAt(projects, folder);
    await (projects.some(item => item.id === next.id) ? selectProject(next) : saveProject(next));
  }
  async function addProject() {
    try {
      const chosen = await chooseProject(projects);
      if (chosen === undefined) setProjectEdit(null);
      else if (chosen) await (projects.some(item => item.id === chosen.id) ? selectProject(chosen) : saveProject(chosen));
    } catch (e) { setError(errorText(e)); }
  }
  /** Moves the open chat to a project's folder (A26): its next turns run there; earlier turns keep theirs. */
  async function moveChat(target: Project | null) {
    if (!ready || !connected || !selected || !target) return;
    const { cwd: moved } = await api<{ cwd: string }>(`/threads/${encodeURIComponent(selected.id)}/folder`, { cwd: target.cwd });
    patchThread(selected.id, { cwd: moved });
  }
  /** The chip's "Choose folder…": the native chooser, then the move; cancelling moves nothing. */
  async function moveChatToFolder() {
    try { const chosen = await chooseProject(projects); if (chosen) await moveChat(chosen); }
    catch (e) { setError(errorText(e)); }
  }
  /** Forgets the project; its folder and chats stay as they are. */
  async function removeProject(item: Project) {
    const updated = projects.filter(other => other.id !== item.id), current = projectId === item.id ? null : projectId;
    try { await saveProjects(updated, current); setProjects(updated); if (!current) { setProjectId(null); setCwd(""); } }
    catch (e) { setError(errorText(e)); }
  }
  return { assignProject, selectProject, saveProject, newProjectFrom, saveProjectFromChats, workIn, addProject, moveChat, moveChatToFolder, removeProject };
}
