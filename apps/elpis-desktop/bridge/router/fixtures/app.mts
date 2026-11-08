import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotherApp } from "../app.mts";
import { ElpisAdapter } from "../executor/adapters.mts";
import { FakeServer } from "../executor/fixtures.mts";
import { SettingsSchema } from "../policy.mts";
import type { ElpisChatMessage } from "../sources/elpis-chat.mts";
import { elpisChatTriggerId } from "../sources/elpis-chat.mts";
import type { MotherAppOptions } from "../app.mts";

export function fixture(options: Pick<Partial<MotherAppOptions>, "settings" | "subprocess"> = {}) {
  const home = mkdtempSync(join(tmpdir(), "mother-parity-")),
    server = new FakeServer(),
    replies = new Map<string, string>();
  const messages: ElpisChatMessage[] = [];
  let app: MotherApp,
    loseReply = false;
  const create = () =>
    new MotherApp({
      home,
      threadId: "mother",
      settings: () =>
        SettingsSchema.parse({
          eval: { model: { provider: "openai", model: "router" } },
          executor: { model: { provider: "openai", model: "worker" } },
        }),
      adapters: [new ElpisAdapter(server.connect)],
      subprocess: {
        spawn: () => ({
          done: Promise.resolve({ exitCode: 0 }),
          collected: { stdout: { readFrom: () => ({ text: "" }) } },
        }),
      },
      transport: {
        read: (_thread, after) =>
          Promise.resolve(messages.slice(after ? messages.findIndex(message => message.id === after) + 1 : 0)),
        appendAssistant: (_thread, reply) =>
          Promise.resolve().then(() => {
            if (!replies.has(reply.id)) replies.set(reply.id, reply.text);
            if (loseReply) {
              loseReply = false;
              throw new Error("Acknowledgement lost");
            }
            return "sent" as const;
          }),
      },
      ...options,
    });
  app = create();
  const message = (id: string, text: string) => {
    messages.push({ id, text, threadId: "mother", role: "user", actorId: "local-user", at: new Date().toISOString() });
    return elpisChatTriggerId("mother", id);
  };
  const main = () => app.workers.sessions.nativeId(app.masterId)!;
  const call = async (session: string, name: string, args: unknown) => {
    const result = await server.tool(session, name, args);
    assert.equal(result.success, true, String(result.value));
    return result.value;
  };
  const route = (id: string, name = "check-project") =>
    call(main(), "orchestrator_route", {
      decisions: [
        {
          kind: "accept",
          trigger_id: id,
          title: "Inspect the project",
          worktree_name: name,
          acknowledgement: "I will inspect the project and report the checks.",
        },
      ],
    });
  return {
    home,
    server,
    messages,
    replies,
    get app() {
      return app;
    },
    message,
    main,
    call,
    route,
    loseReply: () => {
      loseReply = true;
    },
    async restart() {
      await app.close();
      app = create();
      await app.start();
    },
    async close() {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
