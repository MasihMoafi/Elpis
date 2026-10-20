import type {} from "./desktop";
export type Project = { id: string; name: string; cwd: string };
const CHATS_KEY = "elpis-project-chats-v1";

/** Membership is chosen explicitly, independent of a chat's working folder. */
export function readProjectChats(): Record<string, string> {
  const raw = appStorage().getItem(CHATS_KEY);
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(id => typeof id !== "string" || !id)) throw Error("Saved chat projects could not be read.");
  return value as Record<string, string>;
}

export async function saveProjectChats(chats: Record<string, string>) {
  const raw = JSON.stringify(chats), desktop = window.elpisDesktop?.storage;
  if (desktop?.saveItem) await desktop.saveItem(CHATS_KEY, raw);
  else appStorage().setItem(CHATS_KEY, raw);
}
export function appStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  return window.elpisDesktop?.storage ?? window.localStorage;
}
export function readProjects(): { projects: Project[]; selectedId: string | null } {
  const value = JSON.parse(appStorage().getItem("elpis-projects-v1") || '{"projects":[],"selectedId":null}');
  if (!Array.isArray(value.projects) || value.projects.some((p: Project) => !p || typeof p.id !== "string" || typeof p.name !== "string" || typeof p.cwd !== "string" || !p.cwd.startsWith("/"))) throw Error("Saved projects could not be read.");
  return { projects: value.projects, selectedId: value.projects.some((p: Project) => p.id === value.selectedId) ? value.selectedId : null };
}
export async function saveProjects(projects: Project[], selectedId: string | null) {
  const value = JSON.stringify({ projects, selectedId });
  if (window.elpisDesktop?.storage?.saveItem) await window.elpisDesktop.storage.saveItem("elpis-projects-v1", value);
  else appStorage().setItem("elpis-projects-v1", value);
}
