import { agentParentId } from "../lib/agent-runs.mts";
import { isArchivedThread } from "./client-thread-decorate.mts";
import type { MapNode, MapState } from "../lib/sessions-map.ts";

export type MapThread = {
  id: string;
  name?: string | null | undefined;
  preview?: string | null | undefined;
  model?: string | null | undefined;
  archived?: boolean | undefined;
  path?: string | null | undefined;
  parentThreadId?: string | null | undefined;
  source?: unknown;
  status?: { type?: string; activeFlags?: string[] } | undefined;
  updatedAt?: number | undefined;
};
type Member = { title?: string; status?: string; model?: string; assignedThreadId?: string | null; threads?: string[] };
type Workflow = {
  id: string;
  rootThreadId: string;
  name?: string;
  status: string;
  tasks?: Member[];
};
export type SessionsMapInputs = {
  threads: MapThread[];
  router?: { enabled: boolean; threadId: string | null; tickets?: { title: string; threadId: string }[] };
  workflows?: Workflow[];
  showAllChats?: boolean;
};

function state(status?: string, flags: string[] = []): MapState {
  if (flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")) return "needs you";
  if (["failed", "error", "systemError", "blocked"].includes(status ?? "")) return "failed";
  if (["running", "active", "inProgress"].includes(status ?? "")) return "working";
  if (["succeeded", "completed", "done"].includes(status ?? "")) return "done";
  return "idle";
}
const parentId = (thread: MapThread) => agentParentId({ parentThreadId: thread.parentThreadId ?? null, source: thread.source });

/** Assemble a read-only graph from the existing thread, router and workflow records. */
export function buildSessionsMap(input: SessionsMapInputs): { nodes: MapNode[]; edges: { source: string; target: string }[] } {
  const threads = input.threads.filter(thread => !isArchivedThread(thread));
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  const nodes: MapNode[] = [], edges: { source: string; target: string }[] = [];
  const included = new Set<string>();
  const addThread = (thread: MapThread, kind: MapNode["kind"], title?: string, status?: string, model?: string) => {
    const id = `thread:${thread.id}`;
    if (included.has(id)) return id;
    included.add(id);
    const chosenModel = model || thread.model;
    nodes.push({
      id, kind, title: title || thread.name || thread.preview || "Untitled",
      state: state(status || thread.status?.type, thread.status?.activeFlags), threadId: thread.id,
      ...(chosenModel ? { model: chosenModel } : {}),
    });
    return id;
  };
  const link = (source: string, target: string) => {
    if (source !== target && !edges.some(edge => edge.source === source && edge.target === target))
      edges.push({ source, target });
  };
  const router = input.router;
  const root = router?.enabled && router.threadId ? byId.get(router.threadId) : undefined;
  if (root) {
    const parent = addThread(root, "router", "Elpis");
    for (const ticket of router?.tickets ?? []) {
      const worker = byId.get(ticket.threadId);
      if (worker) link(parent, addThread(worker, "worker", ticket.title));
    }
  }
  for (const run of input.workflows ?? []) {
    const id = `workflow:${run.id}`;
    if (included.has(id)) continue;
    included.add(id);
    const rootThread = byId.get(run.rootThreadId);
    nodes.push({
      id, kind: "workflow", title: run.name || "Workflow", state: state(run.status),
      ...(rootThread ? { threadId: rootThread.id } : {}), ...(rootThread?.model ? { model: rootThread.model } : {}),
    });
    for (const task of run.tasks ?? []) {
      const ids = new Set([...(task.threads ?? []), ...(task.assignedThreadId ? [task.assignedThreadId] : [])]);
      for (const threadId of ids) {
        const child = byId.get(threadId);
        if (child && child.id !== run.rootThreadId)
          link(id, addThread(child, "agent", task.title, task.status, task.model));
      }
    }
  }
  const children = new Map<string, MapThread[]>();
  for (const thread of threads) {
    const parent = parentId(thread);
    if (!parent || !byId.has(parent) || parent === thread.id) continue;
    const list = children.get(parent) ?? [];
    list.push(thread);
    children.set(parent, list);
  }
  const visiting = new Set<string>();
  const visit = (thread: MapThread, parent: string) => {
    if (visiting.has(thread.id)) return;
    visiting.add(thread.id);
    for (const child of children.get(thread.id) ?? []) {
      if (visiting.has(child.id)) continue;
      const childId = addThread(child, "agent");
      link(parent, childId);
      visit(child, childId);
    }
    visiting.delete(thread.id);
  };
  for (const thread of threads) {
    if (!children.has(thread.id) || parentId(thread)) continue;
    const existing = `thread:${thread.id}`;
    const workflow = (input.workflows ?? []).find(run => run.rootThreadId === thread.id);
    const parent = included.has(existing) ? existing : workflow ? `workflow:${workflow.id}` : addThread(thread, "chat");
    visit(thread, parent);
  }
  if (input.showAllChats) {
    const workflowRoots = new Set((input.workflows ?? []).map(run => run.rootThreadId));
    threads.filter(thread => !included.has(`thread:${thread.id}`) && !parentId(thread) && !workflowRoots.has(thread.id))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 30)
      .forEach(thread => addThread(thread, "chat"));
  }
  return { nodes, edges };
}
