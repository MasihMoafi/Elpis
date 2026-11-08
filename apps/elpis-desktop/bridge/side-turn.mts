import { BridgeError, threadId } from "./validate.mts";
import type { DesktopClient } from "./client.mts";

type SideClient = Pick<DesktopClient, "settings" | "sideRpc" | "on" | "off">;
type SideEvent = {
  method?: string;
  params?: {
    threadId?: string;
    item?: { type?: string; text?: string; phase?: string };
    turn?: { status?: string; error?: { message?: string }; items?: { type?: string; text?: string }[] };
  };
};
type Options = {
  signal?: AbortSignal;
  prompt: string;
  schema?: unknown;
  cwd?: string | null | undefined;
  permissions: string;
  timeoutMs: number;
  failed: string;
  late: string;
  model?: { model?: string | null | undefined; provider?: string | null | undefined };
  config?: Record<string, unknown>;
  effort?: string | undefined;
};

/** One turn in an ephemeral side conversation with no approvals and no chat in the app: the canvas planner and chat
 * titles. It runs on `model` ({ model, provider }) when given, else the background model (the main model when none is
 * set), under the given permission profile, with `config` overrides and the turn's `effort`. Returns the final answer's
 * text, shaped by `schema`. `failed` starts the error when the turn fails; `late` is the error after `timeoutMs`. */
export async function askBackground(
  client: SideClient,
  { prompt, schema, cwd, permissions, timeoutMs, failed, late, model, config, effort, signal }: Options,
) {
  signal?.throwIfAborted();
  const choice =
    model ?? (await client.settings().then(({ main, background }) => (background?.model ? background : main)));
  const started = (await client.sideRpc("thread/start", {
    ephemeral: true,
    ...(choice?.model ? { model: choice.model, ...(choice.provider ? { modelProvider: choice.provider } : {}) } : {}),
    ...(cwd ? { cwd } : {}),
    approvalPolicy: "never",
    permissions,
    ...(config ? { config } : {}),
  })) as { thread: { id?: unknown; ephemeral?: boolean } };
  const id = threadId(started.thread?.id);
  const turn = follow(client, id, timeoutMs, failed, late, signal);
  let turnId;
  try {
    signal?.throwIfAborted();
    const result = (await client.sideRpc("turn/start", {
      threadId: id,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      outputSchema: schema,
      ...(effort ? { effort } : {}),
    })) as { turn?: { id?: string } };
    turnId = result?.turn?.id;
    return await turn.answer;
  } finally {
    turn.stop();
    await release(client, id, turnId, turn.ended, started.thread.ephemeral !== true);
  }
}

/** Follows one side conversation to the end of its turn. `stop` must be called when done; `ended` tells whether the turn finished. */
function follow(client: SideClient, id: string, timeoutMs: number, failed: string, late: string, signal?: AbortSignal) {
  const state = { ended: false } as { ended: boolean; answer: Promise<string>; stop: () => void };
  let abort: () => void = () => {};
  let listener: (event: SideEvent) => void,
    timer: ReturnType<typeof setTimeout>,
    final: string | undefined,
    last: string | undefined;
  state.answer = new Promise<string>((resolve, reject) => {
    listener = ({ method, params }) => {
      if (params?.threadId !== id) return;
      if (method === "item/completed" && params.item?.type === "agentMessage" && typeof params.item.text === "string") {
        last = params.item.text;
        if (params.item.phase !== "commentary") final = params.item.text;
      }
      if (method !== "turn/completed" || params.turn?.status === "inProgress") return;
      state.ended = true;
      const { status, error, items } = params.turn ?? {};
      if (status !== "completed")
        return reject(new BridgeError(`${failed}: ${error?.message ?? `the turn was ${status ?? "lost"}`}`, 502));
      const answer =
        final ??
        last ??
        items?.findLast?.(item => item?.type === "agentMessage" && typeof item.text === "string")?.text;
      if (answer === undefined) return reject(new BridgeError(`${failed}: it gave no answer`, 502));
      resolve(answer);
    };
    timer = setTimeout(() => reject(new BridgeError(late, 504)), timeoutMs);
    client.on("side", listener);
    abort = () => reject(new BridgeError("Background turn stopped", 409));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  state.answer.catch(() => {});
  state.stop = () => {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
    client.off("side", listener);
  };
  return state;
}

/** Stops a turn that is still running, lets the conversation go, and removes it if Elpis kept it. */
async function release(client: SideClient, id: string, turnId: string | undefined, ended: boolean, kept: boolean) {
  const quietly = (method: string, params: Record<string, unknown>) => client.sideRpc(method, params).catch(() => {});
  if (!ended && turnId) await quietly("turn/interrupt", { threadId: id, turnId });
  await quietly("thread/unsubscribe", { threadId: id });
  if (kept) await quietly("thread/delete", { threadId: id });
}
