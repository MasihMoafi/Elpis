import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createExperimentLab } from "./experiment-lab.mts";

export const stage = { id: "answer", title: "Answer", instruction: "Answer independently.", kind: "implement", dependsOn: [] };

export const input = () => ({ pattern: "voting", task: "What is 19 + 23?", expected: "42", repetitions: 2, stages: [stage] });

export type RpcParams = {
  model: string;
  modelProvider: string;
  input: { text: string }[];
  threadId: string;
  permissions: string;
  config: { forced_login_method: string };
};

export class Client extends EventEmitter {
  close = () => {};
  listThreads: () => Promise<{ data: { id: string; status: { type: string } }[]; nextCursor: null }> = async () => ({
    data: [],
    nextCursor: null,
  });
  calls: { method: string; params: RpcParams }[] = [];
  count = 0;
  prompts: string[] = [];
  auth = "ChatGPT";
  fail = false;
  hang = false;
  missingUsage = false;
  // Answer for the nth pattern-arm turn (1-based); the single-agent arm always answers 42.
  patternAnswer = (_n: number) => "42";
  patternTurns = 0;
  async providers() {
    return { openai: { auth: { state: "signedIn", method: this.auth } } };
  }
  async sideRpc(
    method: string,
    params: RpcParams,
  ): Promise<{
    model?: string;
    modelProvider?: string;
    thread?: { id: string; ephemeral: boolean };
    turn?: { id: string };
  }> {
    this.calls.push({ method, params });
    if (method === "thread/start")
      return {
        model: params.model,
        modelProvider: params.modelProvider,
        thread: { id: `00000000-0000-0000-0000-${String(++this.count).padStart(12, "0")}`, ephemeral: true },
      };
    if (method === "turn/start") {
      const prompt = params.input[0]!.text;
      this.prompts.push(prompt);
      const answer = prompt.includes("Your role: Answer") ? this.patternAnswer(++this.patternTurns) : "42";
      if (!this.hang)
        setTimeout(() => {
          if (!this.missingUsage)
            this.emit("side", {
              method: "thread/tokenUsage/updated",
              params: {
                threadId: params.threadId,
                tokenUsage: { total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
              },
            });
          this.emit("side", {
            method: "item/completed",
            params: {
              threadId: params.threadId,
              item: {
                type: "agentMessage",
                phase: "final_answer",
                text: JSON.stringify({ answer, report: "Computed the sum." }),
              },
            },
          });
          this.emit("side", {
            method: "turn/completed",
            params: {
              threadId: params.threadId,
              turn: {
                status: this.fail ? "failed" : "completed",
                error: this.fail ? { message: "rate limited" } : null,
              },
            },
          });
        }, 2);
      return { turn: { id: `turn-${params.threadId}` } };
    }
    return {};
  }
}

export async function fixture(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-lab-test-"));
  const client = new Client(),
    file = path.join(dir, "latest.json");
  const lab = createExperimentLab({
    client: client as unknown as Parameters<typeof createExperimentLab>[0]["client"],
    file,
    ...options,
  });
  return { client, lab, file };
}

export async function finish(lab: ReturnType<typeof createExperimentLab>) {
  for (let i = 0; i < 100; i++) {
    const value = await lab.read();
    if (value && value.status !== "running") return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("Lab did not finish");
}

export const until = (extra = {}) => ({ ...input(), stopWhen: "solved", ...extra });
