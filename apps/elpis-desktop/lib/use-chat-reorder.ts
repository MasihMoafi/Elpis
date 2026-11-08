import type { Dispatch, SetStateAction } from "react";
import { useReorder } from "@/components/reorder";
import type { Thread } from "@/lib/api";
import { placeChat, prioritizeChats, type ChatGroup, type ChatGroups } from "@/lib/chat-groups";
import { move } from "@/lib/nav-order";
import type { createProjectActions } from "@/lib/project-actions";
import type { useProjectState } from "@/lib/use-project-state";
import type { useChatGroups } from "@/lib/use-sidebar-state";

const CHAT_DRAG_TYPE = "text/x-elpis-chat";
type Inputs = {
  projectState: ReturnType<typeof useProjectState>;
  chatGroups: ChatGroups;
  updateGroups: ReturnType<typeof useChatGroups>["updateGroups"];
  treeParents: Readonly<Record<string, string | null | undefined>>;
  pins: string[];
  ordinaryThreads: Thread[];
  ordinaryIds: Set<string>;
  pinnedChats: Thread[];
  recentChats: Thread[];
  grouped: { groups: { group: ChatGroup; chats: Thread[] }[] } | null;
  movingIds: (id: string) => string[];
  canNest: (ids: string[], parent: string) => boolean;
  assignProject: ReturnType<typeof createProjectActions>["assignProject"];
  nestChats: (ids: string[], parent: string) => Promise<void>;
  searchTerm: string;
  needsYou: (thread: Thread) => boolean;
  sidebarState: (thread: Thread) => string;
  setError: Dispatch<SetStateAction<string>>;
};

export function useChatReorder({
  projectState,
  chatGroups,
  updateGroups,
  treeParents,
  pins,
  ordinaryThreads,
  ordinaryIds,
  pinnedChats,
  recentChats,
  grouped,
  movingIds,
  canNest,
  assignProject,
  nestChats,
  searchTerm,
  needsYou,
  sidebarState,
  setError,
}: Inputs) {
  const { projectChats, projectChatsRef, projects } = projectState;
  // Manual order: drag a chat onto another (or onto a group's heading, or Recents') or press Alt+Up/Down on it. Pinned chats
  // stay pinned and others stay unpinned; a drop in another section moves the chat there. The first move makes Sort by Manual.
  const sectionOf = (id: string) =>
    treeParents[id]
      ? `under:${treeParents[id]}`
      : pins.includes(id)
        ? "pinned"
        : projectChats[id]
          ? `project:${projectChats[id]}`
          : chatGroups.groupBy === "custom" && chatGroups.groups.some(group => group.id === chatGroups.members[id])
            ? `group:${chatGroups.members[id]}`
            : "recents";
  const sectionChats = (section: string) =>
    section.startsWith("under:")
      ? ordinaryThreads.filter(thread => treeParents[thread.id] === section.slice(6))
      : section === "pinned"
        ? pinnedChats
        : section === "recents"
          ? recentChats
          : section.startsWith("project:")
            ? ordinaryThreads.filter(
                thread =>
                  !treeParents[thread.id] && !pins.includes(thread.id) && projectChats[thread.id] === section.slice(8),
              )
            : (grouped?.groups.find(item => `group:${item.group.id}` === section)?.chats ?? []);
  async function placeDragged(id: string, section: string, place?: { target: string; after: boolean }) {
    const moving = movingIds(id);
    const inParent = section.startsWith("under:");
    if (!inParent && (section === "pinned") !== pins.includes(id)) return;
    const parent = inParent ? section.slice(6) : undefined;
    const destination = parent
      ? (projectChatsRef.current[parent] ?? null)
      : section.startsWith("project:")
        ? section.slice(8)
        : null;
    if (parent && !canNest(moving, parent)) return;
    try {
      const ids = ordinaryThreads.map(thread => thread.id);
      await assignProject(moving, section === "pinned" ? undefined : destination, parent, (state, roots) => {
        let next = state,
          order = ids;
        for (const movingId of place?.after ? [...roots].reverse() : roots) {
          if (place && !roots.includes(place.target)) order = move(order, movingId, place);
          next = placeChat(
            next,
            order,
            movingId,
            inParent || section === "pinned" || destination
              ? undefined
              : section === "recents"
                ? null
                : section.slice(6),
          );
        }
        return next;
      });
    } catch (cause) {
      setError(String(cause));
    }
  }
  const chatReorder = useReorder({
    dragType: CHAT_DRAG_TYPE,
    order: id => sectionChats(sectionOf(id)).map(thread => thread.id),
    dropInto: (id, target) => (canNest(movingIds(id), target) ? "middle" : false),
    canDrop: (id, target, place) => {
      if (searchTerm || !ordinaryIds.has(id) || movingIds(id).includes(target)) return false;
      if (place.into && ordinaryIds.has(target)) return canNest(movingIds(id), target);
      const section = ordinaryThreads.some(thread => thread.id === target) ? sectionOf(target) : target;
      if (section.startsWith("under:")) return canNest(movingIds(id), section.slice(6));
      return (
        (section === "pinned") === pins.includes(id) &&
        (section === "pinned" ||
          section === "recents" ||
          (section.startsWith("group:") && chatGroups.groups.some(group => `group:${group.id}` === section)) ||
          (section.startsWith("project:") && projects.some(project => `project:${project.id}` === section)))
      );
    },
    onMove: (id, place) => {
      if (place.into && ordinaryIds.has(place.target)) {
        return nestChats(movingIds(id), place.target).catch(cause => setError(String(cause)));
      }
      const section = place.into ? place.target : sectionOf(place.target);
      if (!place.into) return placeDragged(id, section, place);
      const others = sectionChats(section).filter(thread => thread.id !== id);
      return placeDragged(
        id,
        section,
        section === "recents" && others[0]
          ? { target: others[0].id, after: false }
          : others.at(-1)
            ? { target: others.at(-1)!.id, after: true }
            : undefined,
      );
    },
  });
  /** Ctrl+[ and Ctrl+]: the open chat goes to the top or the bottom of the list it is in (Pinned, its group, its project or Recents). */
  function moveToEdge(id: string, top: boolean) {
    if (searchTerm || !ordinaryThreads.some(thread => thread.id === id)) return;
    const tier = (thread: Thread) =>
      needsYou(thread)
        ? "waiting"
        : ["working", "unread"].includes(sidebarState(thread))
          ? sidebarState(thread)
          : "idle";
    const chats = prioritizeChats(sectionChats(sectionOf(id)), tier);
    const target = chats.find(thread => thread.id === id);
    if (!target) return;
    const peers = chats.filter(thread => tier(thread) === tier(target));
    const edge = top ? peers[0] : peers.at(-1);
    const ordered = edge
      ? move(
          chats.map(thread => thread.id),
          id,
          { target: edge.id, after: !top },
        )
      : chats.map(thread => thread.id);
    const inSection = new Set(ordered);
    let index = 0;
    const order = ordinaryThreads.map(thread => (inSection.has(thread.id) ? ordered[index++]! : thread.id));
    updateGroups(state => placeChat(state, order, id));
  }
  return { chatReorder, moveToEdge };
}
