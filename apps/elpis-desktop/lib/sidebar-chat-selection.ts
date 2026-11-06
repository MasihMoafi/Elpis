import { chatSubtree } from "@/lib/chat-groups";
import type { Thread } from "@/lib/api";
import type { useSidebarThreads } from "@/lib/use-sidebar-threads";
import type { useSidebarSelection } from "@/lib/use-sidebar-selection";

export function createSidebarChatSelection(model: ReturnType<typeof useSidebarThreads>, selection: ReturnType<typeof useSidebarSelection>, selected: Thread | null, find: (id: string) => Thread | undefined) {
  const { searchedThreads, treeParents } = model, { marked } = selection;
  /** Opens the shared delete confirmation for these chats. */
  const chatsOf = (ids: string[]) => ids.map(id => searchedThreads.find(thread => thread.id === id) ?? find(id)).filter((thread): thread is Thread => !!thread);
  /** What Ctrl+Shift+A and the command menu act on: the chats selected in the sidebar, or else the open chat. */
  const chosenChats = () => marked.length ? chatsOf(marked) : selected ? [selected] : [];
  /** These chats and the chats put under them (Put under…): those go wherever their chat goes. */
  const withNested = (ids: string[]) => chatSubtree(ids, treeParents);
  return { chatsOf, chosenChats, withNested };
}
