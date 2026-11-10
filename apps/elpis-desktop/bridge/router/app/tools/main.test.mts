import { it } from "node:test";
import { expect } from "expect";
import { mainTools, type MainToolsHost } from "./main.mts";

/** The reply tool over an engine that records what it was asked to send. */
function setup(alreadyShown: string[]) {
  const sent: { purpose: string; ticketId?: string; text: string }[] = [];
  const shown = new Set(alreadyShown);
  const host = {
    engine: {
      reply: (request: { purpose: string; ticketId?: string; text: string }) => {
        sent.push(request);
        return { id: "reply", status: "queued" };
      },
    },
    store: { replyStatus: () => "sent" },
    sendReplies: () => Promise.resolve(),
    results: { shown: (id: string) => shown.has(id), mark: (id: string) => void shown.add(id) },
  } as unknown as MainToolsHost;
  const reply = mainTools(host, { id: "main" }).find(tool => tool.name === "orchestrator_reply")!;
  return { sent, shown, run: (args: unknown) => reply.execute(args, new AbortController().signal) };
}

/** The route tool over an engine that stops any ticket it is asked to, for a trigger from `source`. */
function stopping(source: string) {
  const said: unknown[] = [];
  const host = {
    engine: {
      decide: (triggerId: string) => ({ id: "d", kind: "stop", reason: { code: "humanStop" }, triggerIds: [triggerId] }),
      reply: (request: unknown) => {
        said.push(request);
        return { id: "reply", status: "queued" };
      },
    },
    store: {
      triggers: { get: () => ({ source }) },
      tickets: { get: (id: string) => (id === "k1" ? { title: "Count lines" } : undefined) },
    },
    context: { logger: { warn: () => {} } },
    requestPass: () => {},
    sendReplies: () => Promise.resolve(),
  } as unknown as MainToolsHost;
  const route = mainTools(host, { id: "main" }).find(tool => tool.name === "orchestrator_route")!;
  const stop = () =>
    route.execute({ decisions: [{ trigger_id: "t1", kind: "stop", ticket_id: "k1" }] }, new AbortController().signal);
  return { said, stop };
}

it("tells a person in the Elpis chat that the ticket he asked to stop was stopped", async () => {
  const { said, stop } = stopping("elpis-chat");
  await stop();
  expect(said).toEqual([{ purpose: "answer", text: "Stopped “Count lines”.", triggerId: "t1" }]);
});

it("leaves a stop from another Source to that Source's own notices", async () => {
  const { said, stop } = stopping("github");
  await stop();
  expect(said).toEqual([]);
});

it("does not send a result the host already put in his chat", async () => {
  const { sent, run } = setup(["done"]);
  expect(await run({ purpose: "result", ticket_id: "done", text: "It has 141 lines." })).toEqual({
    status: "sent",
    note: "He already has this result in his chat; nothing more to send.",
  });
  expect(sent).toEqual([]);
});

it("sends a result nobody showed yet, and remembers it so the host does not send it again", async () => {
  const { sent, shown, run } = setup([]);
  expect(await run({ purpose: "result", ticket_id: "open", text: "Merged." })).toEqual({ status: "sent" });
  expect(sent).toEqual([{ purpose: "result", ticketId: "open", text: "Merged." }]);
  expect(shown.has("open")).toBe(true);
});

it("still sends a question for him on a ticket whose result is shown", async () => {
  const { sent, run } = setup(["done"]);
  await run({ purpose: "attention", ticket_id: "done", human_action: "Which branch?", text: "Which branch?" });
  expect(sent).toEqual([{ purpose: "attention", ticketId: "done", question: "Which branch?", text: "Which branch?" }]);
});
