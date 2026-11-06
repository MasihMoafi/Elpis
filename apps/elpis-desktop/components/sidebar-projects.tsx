import type React from "react";
import { FolderIcon, PlusIcon } from "@/components/elpis-icons";
import { ProjectActions } from "@/components/project-picker";
import { ReorderItem, type useReorder } from "@/components/reorder";
import { SidebarGroup } from "@/components/sidebar-group";
import { Button } from "@/components/ui/button";
import type { Thread } from "@/lib/api";
import type { createProjectActions } from "@/lib/project-actions";
import type { useProjectState } from "@/lib/use-project-state";
import type { useSidebarFolds } from "@/lib/use-sidebar-state";

type Props = {
  projectState: ReturnType<typeof useProjectState>; collapsedSections: Record<string, boolean>; collapsedProjects: Record<string, boolean>;
  ordinaryThreads: Thread[]; sidebarParent: (thread: Thread) => string | null | undefined; pins: string[]; ownChat: (thread: Thread) => boolean;
  chatReorder: ReturnType<typeof useReorder>; projectReorder: ReturnType<typeof useReorder>; setCollapsedProjects: ReturnType<typeof useSidebarFolds>["setCollapsedProjects"];
  foldable: (key: string, name: string) => React.ReactNode; addProject: ReturnType<typeof createProjectActions>["addProject"];
  removeProject: ReturnType<typeof createProjectActions>["removeProject"]; selectProject: ReturnType<typeof createProjectActions>["selectProject"];
  ready: boolean; busy: boolean; chatRows: (thread: Thread) => React.ReactNode;
};

export function SidebarProjects({ projectState, collapsedSections, collapsedProjects, ordinaryThreads, sidebarParent, pins, ownChat, chatReorder, projectReorder, setCollapsedProjects, foldable, addProject, removeProject, selectProject, ready, busy, chatRows }: Props) {
  const { projects, projectChats, project, setProjectEdit } = projectState;
  return <section aria-label="Projects"><div className="section-label-row">{foldable("projects", "Projects")}<Button variant="ghost" size="icon-xs" aria-label="Add new project" title="Add new project: choose a folder" onClick={() => void addProject()}><PlusIcon size={13} /></Button></div>
          {!collapsedSections.projects && projects.map(item => { const open = !collapsedProjects[item.id], chats = ordinaryThreads.filter(t => !sidebarParent(t) && projectChats[t.id] === item.id && !pins.includes(t.id) && ownChat(t));
            return <SidebarGroup key={item.id} kind="project" dropProps={chatReorder.targetProps(`project:${item.id}`, true)} name={item.name} title={item.cwd} icon={<FolderIcon size={14} />} open={open} active={project?.id === item.id} onToggle={() => setCollapsedProjects(prev => ({ ...prev, [item.id]: open }))}
              wrap={(area, content) => <ProjectActions project={item} onEdit={setProjectEdit} onRemove={item => { void removeProject(item); }} area={<ReorderItem reorder={projectReorder} itemId={item.id} render={area as React.ReactElement<React.HTMLAttributes<HTMLElement>>} />}>{content}</ProjectActions>}
              trailing={<Button className="project-new-chat" variant="ghost" size="icon-xs" aria-label={`Start new chat in ${item.name}`} title="New chat in this project" disabled={!ready || busy} onClick={() => void selectProject(item)}><PlusIcon size={13} /></Button>}
              empty={!chats.length}>{chats.map(chatRows)}</SidebarGroup>; })}
        </section>;
}
