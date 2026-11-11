import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";
import { handleWorkflowRoutes } from "./server-workflows.mts";

const mother = {
  sessionLinks: () => ({ enabled: true, threadId: "router", tickets: [{ title: "Ticket", threadId: "worker" }] }),
  list: async (threads: unknown[]) => threads,
};
const mapOf = async (client: object, query = "") => {
  let output = "";
  const response = { writeHead() {}, end(value: string) { output = value; } };
  const handled = await handleWorkflowRoutes(
    { client, mother } as never, {} as never, response as never, new URL(`http://localhost/api/sessions-map${query}`), "GET",
  );
  assert.equal(handled, true);
  return JSON.parse(output);
};

test("sessions map route joins owner records and excludes unrelated chats by default", async () => {
  const client = Object.assign(new EventEmitter(), {
    listThreads: async () => ({ data: [
      { id: "router" }, { id: "worker" }, { id: "chat" },
      { id: "agent", parentThreadId: "chat" }, { id: "other" },
    ], nextCursor: null }),
    workflowHistory: async () => ({ data: [{ id: "run", rootThreadId: "chat", status: "running" }] }),
  });
  const graph = await mapOf(client);
  assert(graph.edges.some((edge: { source: string; target: string }) => edge.source === "thread:router" && edge.target === "thread:worker"));
  assert(graph.edges.some((edge: { source: string; target: string }) => edge.source === "workflow:run" && edge.target === "thread:agent"));
  assert(!graph.nodes.some((node: { threadId?: string }) => node.threadId === "other"));
  assert((await mapOf(client, "?all=1")).nodes.some((node: { threadId?: string }) => node.threadId === "other"));
});

// W8: with the Map open the bridge paged every chat each 5 s. Over 15 s of no change it pages the list once; a chat
// that starts working is read again at once, so the Map's next refresh (within 5 s) shows it working.
test("the open Map pages the chat list once in 15 s unless a chat changed", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    let reads = 0,
      status = "idle";
    const client = Object.assign(new EventEmitter(), {
      listThreads: async ({ cursor }: { cursor?: string }) => {
        reads++;
        return cursor
          ? { data: [{ id: "agent", parentThreadId: "chat" }], nextCursor: null }
          : { data: [{ id: "chat", name: "Fix login", status: { type: status } }], nextCursor: "page-2" };
      },
      workflowHistory: async () => ({ data: [] }),
    });
    const chatState = async () =>
      (await mapOf(client)).nodes.find((node: { threadId?: string }) => node.threadId === "chat")?.state;
    assert.equal(await chatState(), "idle");
    assert.equal(reads, 2, "the first reading pages the whole list");
    for (const step of [5_000, 5_000, 4_900]) {
      mock.timers.tick(step);
      assert.equal(await chatState(), "idle");
    }
    assert.equal(reads, 2, "14.9 s of refreshes with no change: one full read");

    status = "active";
    client.emit("event", { type: "message", data: { method: "thread/status/changed", params: { threadId: "chat" } } });
    mock.timers.tick(2_000);
    assert.equal(await chatState(), "working", "a chat that starts working shows at the next refresh");
    assert.equal(reads, 4);

    // A notice about something else (a streamed delta) is no reason to page again; 15 s is the longest a list is kept.
    client.emit("event", { type: "message", data: { method: "item/agentMessage/delta", params: { threadId: "chat" } } });
    mock.timers.tick(5_000);
    await chatState();
    assert.equal(reads, 4);
    mock.timers.tick(10_000);
    await chatState();
    assert.equal(reads, 6, "after 15 s the list is paged again");
  } finally {
    mock.timers.reset();
  }
});
