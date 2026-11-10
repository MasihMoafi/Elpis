import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSessionsMap } from "./sessions-map.mts";

const thread = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, ...extra });

test("maps the router and its ticket chats using their ticket titles", () => {
  const graph = buildSessionsMap({
    threads: [thread("router"), thread("worker1"), thread("worker2")],
    router: { enabled: true, threadId: "router", tickets: [
      { title: "First ticket", threadId: "worker1" }, { title: "Second ticket", threadId: "worker2" },
    ] },
  });
  assert.deepEqual(graph.nodes.map(node => [node.id, node.kind, node.title]), [
    ["thread:router", "router", "Elpis"], ["thread:worker1", "worker", "First ticket"],
    ["thread:worker2", "worker", "Second ticket"],
  ]);
  assert.deepEqual(graph.edges, [
    { source: "thread:router", target: "thread:worker1" }, { source: "thread:router", target: "thread:worker2" },
  ]);
  assert.deepEqual(buildSessionsMap({ threads: [thread("router")], router: { enabled: false, threadId: "router" } }).nodes, []);
});

test("includes nested agents and ignores missing or archived parents", () => {
  const graph = buildSessionsMap({ threads: [
    thread("chat"), thread("child", { parentThreadId: "chat" }), thread("grandchild", { parentThreadId: "child" }),
    thread("orphan", { parentThreadId: "missing" }), thread("old", { archived: true }),
    thread("old-child", { parentThreadId: "old" }),
  ] });
  assert.deepEqual(graph.nodes.map(node => [node.id, node.kind]), [
    ["thread:chat", "chat"], ["thread:child", "agent"], ["thread:grandchild", "agent"],
  ]);
  assert.deepEqual(graph.edges, [
    { source: "thread:chat", target: "thread:child" }, { source: "thread:child", target: "thread:grandchild" },
  ]);
});

test("includes workflow runs with their agents and real states", () => {
  const graph = buildSessionsMap({
    threads: [thread("root", { model: "m1" }), thread("agent")],
    workflows: [{ id: "run", rootThreadId: "root", name: "Review", status: "failed", tasks: [
      { title: "Check", assignedThreadId: "agent", status: "running", model: "m2" },
    ] }],
  });
  assert.deepEqual(graph.nodes, [
    { id: "workflow:run", kind: "workflow", title: "Review", state: "failed", threadId: "root", model: "m1" },
    { id: "thread:agent", kind: "agent", title: "Check", state: "working", threadId: "agent", model: "m2" },
  ]);
  assert.deepEqual(graph.edges, [{ source: "workflow:run", target: "thread:agent" }]);
});

test("adds at most thirty recent independent chats when requested", () => {
  const threads = Array.from({ length: 32 }, (_, index) => thread(`chat${index}`, { updatedAt: index }));
  assert.equal(buildSessionsMap({ threads }).nodes.length, 0);
  const nodes = buildSessionsMap({ threads, showAllChats: true }).nodes;
  assert.equal(nodes.length, 30);
  assert.equal(nodes[0]?.threadId, "chat31");
  assert.equal(nodes.some(node => node.threadId === "chat0"), false);
});

test("shows thread attention and live status", () => {
  const graph = buildSessionsMap({ threads: [
    thread("parent", { status: { type: "active", activeFlags: ["waitingOnUserInput"] } }),
    thread("child", { parentThreadId: "parent", status: { type: "active" }, model: "example" }),
  ] });
  assert.equal(graph.nodes[0]?.state, "needs you");
  assert.equal(graph.nodes[1]?.state, "working");
  assert.equal(graph.nodes[1]?.model, "example");
});

test("uses the sidebar's error state for failed chats", () => {
  const graph = buildSessionsMap({ threads: [
    thread("parent", { status: { type: "systemError" } }), thread("child", { parentThreadId: "parent" }),
  ] });
  assert.equal(graph.nodes[0]?.state, "failed");
});
