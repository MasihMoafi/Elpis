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

// W2 (12 Nov, his real app): the engine lists a chat only once its first turn has written its record, so a brand-new
// chat was missing from the Map while it worked and appeared 14 s later as idle. The bridge hears it start and work.
test("a new chat the list does not hold yet is on the Map with its live state, and nothing is paged for it", async () => {
  mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
  try {
    let reads = 0,
      recorded = false;
    const client = Object.assign(new EventEmitter(), {
      listThreads: async () => {
        reads++;
        const old = [{ id: "router" }, { id: "chat", name: "Older chat" }];
        return { data: recorded ? [...old, { id: "plain", name: "Plain", status: { type: "idle" } },
          { id: "worker", status: { type: "idle" } }] : old, nextCursor: null };
      },
      workflowHistory: async () => ({ data: [] }),
    });
    const message = (method: string, params: object) => client.emit("event", { type: "message", data: { method, params } });
    const node = async (threadId: string, query = "") =>
      (await mapOf(client, query)).nodes.find((item: { threadId?: string }) => item.threadId === threadId);
    assert.equal(await node("plain", "?all=1"), undefined);

    // Created, never given a message: it does not have to appear, and does not.
    message("thread/started", { thread: { id: "empty", status: { type: "idle" } } });
    for (const id of ["plain", "worker"]) {
      message("thread/started", { thread: { id, name: id === "plain" ? "Plain" : null, status: { type: "idle" } } });
      message("thread/status/changed", { threadId: id, status: { type: "active", activeFlags: [] } });
      message("turn/started", { threadId: id, turn: { id: "t1", status: "inProgress" } });
    }
    mock.timers.tick(2_000);
    assert.equal((await node("plain", "?all=1"))?.state, "working", "a plain chat shows working in Show all chats");
    assert.equal((await node("worker"))?.state, "working", "the router's new worker shows working by default");
    assert.equal((await node("worker"))?.title, "Ticket");
    assert.equal(await node("empty", "?all=1"), undefined, "a chat that never got a message stays off the Map");
    assert.equal(await node("plain"), undefined, "the default view still leaves plain chats out");
    const pagedWhileWorking = reads;

    // The turn ends before the engine's list holds the chat: its end state shows.
    message("turn/completed", { threadId: "plain", turn: { id: "t1", status: "failed" } });
    message("thread/status/changed", { threadId: "plain", status: { type: "systemError" } });
    mock.timers.tick(2_000);
    assert.equal((await node("plain", "?all=1"))?.state, "failed");
    // Then the list holds both; the listed record wins.
    recorded = true;
    message("thread/status/changed", { threadId: "worker", status: { type: "idle" } });
    mock.timers.tick(2_000);
    assert.equal((await node("plain", "?all=1"))?.state, "idle");
    assert.equal((await node("worker"))?.state, "idle");
    assert(reads <= pagedWhileWorking + 4, "only the events that already re-page the list cause reads");
  } finally {
    mock.timers.reset();
  }
});
