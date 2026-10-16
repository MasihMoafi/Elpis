import type {} from "./desktop";
export type Project = { id: string; name: string; cwd: string };
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
