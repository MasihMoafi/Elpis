import type { Dispatch, SetStateAction } from "react";
import { useReorder } from "@/components/reorder";
import { arrange, move } from "@/lib/nav-order";
import { savePreferences, type useAppPreferences } from "@/lib/preferences";
import { saveProjects } from "@/lib/projects";
import { errorText } from "@/lib/error-text.mts";
import { NAV_PAGES } from "@/lib/workspace-navigation-pages";
import type { useProjectState } from "@/lib/use-project-state";

export function useWorkspaceOrder(preferences: ReturnType<typeof useAppPreferences>, hiddenPages: string[], projectState: ReturnType<typeof useProjectState>, setError: Dispatch<SetStateAction<string>>) {
  const { projects, projectId, setProjects } = projectState;
  // The sidebar's pages in the person's order (drag and drop, or Alt+Up/Down), saved with the preferences.
  const arrangedPages = arrange(NAV_PAGES.filter(page => !hiddenPages.includes(page.id)), preferences.navOrder.split(",").filter(Boolean));
  const reorderPages = (ids: string[]) => { try { savePreferences({ navOrder: ids.join(",") }); } catch (cause) { setError(errorText(cause)); } };
  const pageReorder = useReorder({ dragType: "text/x-elpis-page", order: () => arrangedPages.map(page => page.id),
    canDrop: (id, target) => arrangedPages.some(page => page.id === id) && arrangedPages.some(page => page.id === target),
    onMove: (id, place) => reorderPages(move(arrangedPages.map(page => page.id), id, place)) });
  const projectReorder = useReorder({ dragType: "text/x-elpis-project", order: () => projects.map(project => project.id),
    canDrop: (id, target) => projects.some(project => project.id === id) && projects.some(project => project.id === target),
    onMove: (id, place) => {
      const next = arrange(projects, move(projects.map(project => project.id), id, place));
      return saveProjects(next, projectId).then(() => setProjects(next)).catch(cause => setError(String(cause)));
    } });
  return { arrangedPages, pageReorder, projectReorder };
}
