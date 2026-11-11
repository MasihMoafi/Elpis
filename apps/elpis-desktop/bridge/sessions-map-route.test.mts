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

// W1: an older run that recorded no root chat was dropped by the route, so it and its agents were missing from the Map.
test("a workflow run with no recorded root chat is its own group; a run with one stays joined to it", async () => {
  const client = Object.assign(new EventEmitter(), {
    listThreads: async () => ({ data: [{ id: "chat" }, { id: "joined" }, { id: "alone" }], nextCursor: null }),
    workflowHistory: async () => ({ data: [
      { id: "old", name: "Manual review", status: "succeeded", tasks: [{ title: "Read", assignedThreadId: "alone" }] },
      { id: "new", name: "Count", rootThreadId: "chat", status: "succeeded", tasks: [{ title: "Do", assignedThreadId: "joined" }] },
      { id: "empty", name: "Nothing listed", status: "succeeded", tasks: [{ title: "Gone", assignedThreadId: "deleted" }] },
    ] }),
  });
  const graph = await mapOf(client);
  const node = (id: string) => graph.nodes.find((item: { id: string }) => item.id === id);
  const edge = (source: string, target: string) =>
    graph.edges.some((item: { source: string; target: string }) => item.source === source && item.target === target);
  assert.equal(node("workflow:old")?.title, "Manual review");
  assert.equal(node("workflow:old")?.threadId, undefined, "a run without its chat opens nothing it cannot prove");
  assert.equal(node("thread:alone")?.title, "Read");
  assert(edge("workflow:old", "thread:alone"), "the run's agent is joined to the run");
  assert(!graph.edges.some((item: { target: string }) => item.target === "workflow:old"), "the run is joined to nothing");
  assert.equal(node("workflow:new")?.threadId, "chat");
  assert(edge("workflow:new", "thread:joined"));
  assert.equal(node("workflow:empty"), undefined, "a finished run with nothing to open is not a card");
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
