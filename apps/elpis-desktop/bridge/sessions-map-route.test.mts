import { strict as assert } from "node:assert";
import { test } from "node:test";
import { handleWorkflowRoutes } from "./server-workflows.mts";

test("sessions map route joins owner records and excludes unrelated chats by default", async () => {
  const client = {
    listThreads: async () => ({ data: [
      { id: "router" }, { id: "worker" }, { id: "chat" },
      { id: "agent", parentThreadId: "chat" }, { id: "other" },
    ], nextCursor: null }),
    workflowHistory: async () => ({ data: [{ id: "run", rootThreadId: "chat", status: "running" }] }),
  };
  const mother = {
    sessionLinks: () => ({ enabled: true, threadId: "router", tickets: [{ title: "Ticket", threadId: "worker" }] }),
    list: async (threads: unknown[]) => threads,
  };
  const call = async (query = "") => {
    let output = "";
    const response = { writeHead() {}, end(value: string) { output = value; } };
    const handled = await handleWorkflowRoutes(
      { client, mother } as never, {} as never, response as never, new URL(`http://localhost/api/sessions-map${query}`), "GET",
    );
    assert.equal(handled, true);
    return JSON.parse(output);
  };
  const graph = await call();
  assert(graph.edges.some((edge: { source: string; target: string }) => edge.source === "thread:router" && edge.target === "thread:worker"));
  assert(graph.edges.some((edge: { source: string; target: string }) => edge.source === "workflow:run" && edge.target === "thread:agent"));
  assert(!graph.nodes.some((node: { threadId?: string }) => node.threadId === "other"));
  assert((await call("?all=1")).nodes.some((node: { threadId?: string }) => node.threadId === "other"));
});
