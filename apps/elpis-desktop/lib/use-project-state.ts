import { useRef, useState } from "react";
import type { Thread } from "@/lib/api";
import type { Project } from "@/lib/projects";

export function useProjectState() {
  const [cwd, setCwd] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  // Workflows and Love Spot use the last project; new chats start without one.
  const [workflowProjectId, setWorkflowProjectId] = useState<string | null>(null);
  const [projectChats, setProjectChats] = useState<Record<string, string>>({});
  const projectChatsRef = useRef(projectChats),
    projectChatSave = useRef(Promise.resolve());
  const [projectMove, setProjectMove] = useState<Thread[] | null>(null);
  const [newProjectFor, setNewProjectFor] = useState<Thread[] | null>(null);
  const [nestTargets, setNestTargets] = useState<Thread[] | null>(null);
  const [projectChanging, setProjectChanging] = useState(false);
  const project = projects.find(item => item.id === projectId) ?? null;
  const workflowProject = projects.find(item => item.id === workflowProjectId) ?? null;
  const [projectEdit, setProjectEdit] = useState<Project | null | undefined>(undefined);
  return {
    cwd,
    setCwd,
    projects,
    setProjects,
    projectId,
    setProjectId,
    workflowProjectId,
    setWorkflowProjectId,
    projectChats,
    setProjectChats,
    projectChatsRef,
    projectChatSave,
    projectMove,
    setProjectMove,
    newProjectFor,
    setNewProjectFor,
    nestTargets,
    setNestTargets,
    projectChanging,
    setProjectChanging,
    project,
    workflowProject,
    projectEdit,
    setProjectEdit,
  };
}
