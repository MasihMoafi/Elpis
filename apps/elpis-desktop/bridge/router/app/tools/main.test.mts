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
