// Chats organised in the sidebar, as Claude's desktop app organises sessions: groups the person names and moves chats
// into ("Move to group"), whether the list is drawn by those groups, and the order of its chats. Kept on this computer
// (the desktop store's elpis-chat-groups-v1, desktop/state.cjs); app/page.tsx draws it. No value imports, so the node
// tests load this file as it is.

export type ChatGroup = { id: string; name: string };
/** "custom": the sidebar draws a section for each group, then Recents for the rest; "none": Recents holds every chat. */
export type GroupBy = "none" | "custom";
/** "recency": the bridge's order (last activity first); "created": newest first; "name": A to Z. */
export type SortBy = "recency" | "created" | "name";
/** `members`: chat id → group id; `collapsed`: groups drawn closed. */
export type ChatGroups = { groups: ChatGroup[]; members: Record<string, string>; groupBy: GroupBy; sortBy: SortBy; collapsed: string[] };
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export const GROUPS_KEY = "elpis-chat-groups-v1";
const NAME_LIMIT = 60;
const GROUP_BY: readonly GroupBy[] = ["none", "custom"], SORT_BY: readonly SortBy[] = ["recency", "created", "name"];

export const emptyGroups = (): ChatGroups => ({ groups: [], members: {}, groupBy: "none", sortBy: "recency", collapsed: [] });
/** The sidebar as it is before anyone changes it: no group sections, the bridge's order. */
export const isDefaultView = (state: ChatGroups) => state.groupBy === "none" && state.sortBy === "recency";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** What was saved, keeping only what can be used: named groups once each, members and collapsed of known groups. */
export function readGroups(storage: Storage): ChatGroups {
  let value: unknown;
  try { value = JSON.parse(storage.getItem(GROUPS_KEY) || "null"); } catch { return emptyGroups(); }
  if (!record(value)) return emptyGroups();
  const groups: ChatGroup[] = [];
  for (const item of Array.isArray(value.groups) ? value.groups : []) {
    if (!record(item) || typeof item.id !== "string" || !item.id || typeof item.name !== "string") continue;
    const name = item.name.trim().slice(0, NAME_LIMIT);
    if (name && !groups.some(group => group.id === item.id)) groups.push({ id: item.id, name });
  }
  const known = new Set(groups.map(group => group.id));
  const members = Object.fromEntries(Object.entries(record(value.members) ? value.members : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && known.has(entry[1])));
  const collapsed = [...new Set((Array.isArray(value.collapsed) ? value.collapsed : []).filter((id: unknown): id is string => typeof id === "string" && known.has(id)))];
  return {
    groups, members, collapsed,
    groupBy: GROUP_BY.includes(value.groupBy as GroupBy) ? value.groupBy as GroupBy : "none",
    sortBy: SORT_BY.includes(value.sortBy as SortBy) ? value.sortBy as SortBy : "recency",
  };
}

/** False when the store refused it. */
export function writeGroups(state: ChatGroups, storage: Storage): boolean {
  try { storage.setItem(GROUPS_KEY, JSON.stringify(state)); return true; } catch { return false; }
}

/** Why `name` cannot name a group (empty, too long, or another group's, in any case), or null. `except` is the group
 * being renamed, which may keep its own name. */
export function groupNameProblem(state: ChatGroups, name: string, except?: string): string | null {
  const wanted = name.trim();
  if (!wanted) return "Name the group.";
  if (wanted.length > NAME_LIMIT) return `Use ${NAME_LIMIT} characters or fewer.`;
  const taken = state.groups.some(group => group.id !== except && group.name.toLocaleLowerCase() === wanted.toLocaleLowerCase());
  return taken ? "A group with this name already exists." : null;
}

/** A new group after the others. The list then shows groups, as Claude's does after "Create group". */
export function addGroup(state: ChatGroups, name: string, id: string): ChatGroups {
  return { ...state, groups: [...state.groups, { id, name: name.trim().slice(0, NAME_LIMIT) }], groupBy: "custom" };
}

export function renameGroup(state: ChatGroups, id: string, name: string): ChatGroups {
  return { ...state, groups: state.groups.map(group => group.id === id ? { ...group, name: name.trim().slice(0, NAME_LIMIT) } : group) };
}

/** The group goes; its chats are ungrouped, not deleted. */
export function deleteGroup(state: ChatGroups, id: string): ChatGroups {
  return { ...state, groups: state.groups.filter(group => group.id !== id), members: Object.fromEntries(Object.entries(state.members).filter(([, group]) => group !== id)), collapsed: state.collapsed.filter(group => group !== id) };
}

/** Puts the chats in `groupId`, or takes them out of their groups with null. An unknown group moves nothing. */
export function moveChats(state: ChatGroups, threadIds: string[], groupId: string | null): ChatGroups {
  if (groupId !== null && !state.groups.some(group => group.id === groupId)) return state;
  const members = { ...state.members };
  for (const id of threadIds) { if (groupId === null) delete members[id]; else members[id] = groupId; }
  return { ...state, members };
}

export function toggleCollapsed(state: ChatGroups, id: string): ChatGroups {
  return { ...state, collapsed: state.collapsed.includes(id) ? state.collapsed.filter(group => group !== id) : [...state.collapsed, id] };
}

const byName = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
/** A sorted copy. Last activity keeps the given order; ties keep their order; a chat without a creation time goes last. */
export function sortChats<T extends { createdAt?: number }>(threads: T[], sortBy: SortBy, nameOf: (thread: T) => string): T[] {
  if (sortBy === "recency") return [...threads];
  const indexed = threads.map((thread, index) => ({ thread, index }));
  const compare = sortBy === "name"
    ? (a: { thread: T }, b: { thread: T }) => byName.compare(nameOf(a.thread), nameOf(b.thread))
    : (a: { thread: T }, b: { thread: T }) => (typeof b.thread.createdAt === "number" ? b.thread.createdAt : -Infinity) - (typeof a.thread.createdAt === "number" ? a.thread.createdAt : -Infinity) || 0;
  return indexed.sort((a, b) => compare(a, b) || a.index - b.index).map(entry => entry.thread);
}

/** The list drawn by groups: each group, in its order, with its chats in list order (an empty group too), then the rest. */
export function groupSections<T extends { id: string }>(threads: T[], state: ChatGroups): { groups: { group: ChatGroup; chats: T[] }[]; ungrouped: T[] } {
  const known = new Set(state.groups.map(group => group.id));
  return {
    groups: state.groups.map(group => ({ group, chats: threads.filter(thread => state.members[thread.id] === group.id) })),
    ungrouped: threads.filter(thread => !known.has(state.members[thread.id])),
  };
}
