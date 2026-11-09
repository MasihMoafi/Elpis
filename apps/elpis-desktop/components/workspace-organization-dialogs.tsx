import { MoveChatDialog, ProjectDialog } from "@/components/project-picker";
import { PutUnderDialog } from "@/components/put-under-dialog";
import { title } from "@/lib/api";
import type { useProjectState } from "@/lib/use-project-state";
import type { useWorkspaceDialogState } from "@/lib/use-workspace-dialog-state";
import type { useSidebarThreads } from "@/lib/use-sidebar-threads";
import type { useChatGroups } from "@/lib/use-sidebar-state";
import type { useSidebarSelection } from "@/lib/use-sidebar-selection";
import type { createSidebarPlacement } from "@/lib/sidebar-placement";
import type { createProjectActions } from "@/lib/project-actions";

type Props = {
  projectState: ReturnType<typeof useProjectState>;
  dialogs: ReturnType<typeof useWorkspaceDialogState>;
  model: ReturnType<typeof useSidebarThreads>;
  groups: ReturnType<typeof useChatGroups>;
  selection: ReturnType<typeof useSidebarSelection>;
  placement: ReturnType<typeof createSidebarPlacement>;
  actions: ReturnType<typeof createProjectActions>;
  children: React.ReactNode;
};

export function WorkspaceOrganizationDialogs({
  projectState,
  model,
  placement,
  actions,
  children,
}: Props) {
  const {
    projects,
    projectEdit,
    setProjectEdit,
    cwd,
    newProjectFor,
    setNewProjectFor,
    projectMove,
    setProjectMove,
    projectChats,
    nestTargets,
    setNestTargets,
  } = projectState;
  const { ordinaryThreads } = model;
  const { canNest, nestChats } = placement,
    { saveProjectFromChats, saveProject, assignProject } = actions;
  return (
    <>
      <ProjectDialog
        projects={projects}
        editing={projectEdit}
        folders={projectEdit !== undefined ? [cwd, ...ordinaryThreads.map(thread => thread.cwd ?? "")] : []}
        {...(newProjectFor
          ? {
              description: `${newProjectFor.length} chats will move into this project. Their working folders stay as they are.`,
            }
          : {})}
        onClose={() => {
          setProjectEdit(undefined);
          setNewProjectFor(null);
        }}
        onSave={newProjectFor ? saveProjectFromChats : saveProject}
      />
      <MoveChatDialog
        name={
          projectMove
            ? projectMove.length === 1
              ? title(projectMove[0]!)
              : `${projectMove.length} selected chats`
            : null
        }
        {...(projectMove ? { count: projectMove.length } : {})}
        projects={projects}
        currentId={
          projectMove
            ? new Set(projectMove.map(chat => projectChats[chat.id] ?? null)).size === 1
              ? (projectChats[projectMove[0]!.id] ?? null)
              : undefined
            : null
        }
        onMove={id =>
          projectMove
            ? assignProject(
                projectMove.map(chat => chat.id),
                id,
              )
            : Promise.resolve()
        }
        onClose={() => setProjectMove(null)}
      />
      {children}
      <PutUnderDialog
        chats={nestTargets}
        candidates={
          nestTargets
            ? ordinaryThreads.filter(thread =>
                canNest(
                  nestTargets.map(chat => chat.id),
                  thread.id,
                ),
              )
            : []
        }
        onPutUnder={parent =>
          nestChats(
            (nestTargets ?? []).map(chat => chat.id),
            parent,
          )
        }
        onClose={() => setNestTargets(null)}
      />
    </>
  );
}
