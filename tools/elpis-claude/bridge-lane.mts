import { randomUUID } from "node:crypto";
import { EDIT_TOOLS,toolItem } from "./bridge-transcript.mts";
import type { ContextChars,Lane,NoticeParams,ToolState,UsageTotals } from "./bridge-types.mts";
import { wireObject } from "./bridge-wire.mts";

type Dependencies = { notify: (method: string, params: NoticeParams) => void; addChars: (threadId: string, part: keyof ContextChars, n: number) => void; lastContext: Map<string, { used?: number; size?: number | null }>; sendUsage: (threadId: string, turnId: string, last: UsageTotals | null) => void; now: () => number };

/** Draw one provider or subagent transcript lane from ACP updates. */
export function createLaneBuilder({ notify, addChars, lastContext, sendUsage, now }: Dependencies) {
  // One transcript drawn from Claude's ACP updates: the chat's turn (`root`), or the turn of a
  // subagent Claude started, in that subagent's child thread. Only the chat's own lane counts
  // toward the chat's context and usage.
  function newLane(threadId: string, turnId: string, cwd: string, root: boolean) {
    const seed: Pick<Lane, "threadId" | "turnId" | "items" | "tools" | "message" | "lastPlan" | "done" | "onIdle"> = { threadId, turnId, items: [], tools: new Map(), message: null, lastPlan: null, done: false, onIdle: () => {} };
    const lane = seed as Lane;
    const chars = (part: keyof ContextChars, n: number) => { if (root) addChars(threadId, part, n); };
    lane.say = (item) => {
      lane.closeMessage();
      notify("item/started", { item, threadId, turnId, startedAtMs: now() });
      notify("item/completed", { item, threadId, turnId, completedAtMs: now() });
      lane.items.push(item);
    };
    // A subagent's start and end, as the rows Elpis's own subagents leave in their parent's turn.
    lane.activity = (kind: string, agentThreadId: string, name: string) => {
      lane.closeMessage();
      const item = { type: "subAgentActivity", id: randomUUID(), kind, agentThreadId, agentPath: name };
      notify("item/completed", { item, threadId, turnId, completedAtMs: now() });
      lane.items.push(item);
    };
    lane.closeMessage = () => {
      if (!lane.message) return;
      notify("item/completed", { item: lane.message, threadId, turnId, completedAtMs: now() });
      lane.items.push(lane.message);
      lane.message = null;
    };
    lane.turn = () => ({ id: turnId, items: [...lane.items], itemsView: "full", status: lane.done ? "completed" : "inProgress", error: null, startedAt: lane.startedAt ?? null, completedAt: null, durationMs: null });
    lane.update = (u) => {
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        if (!lane.message) {
          lane.message = { type: "agentMessage", id: `msg_${randomUUID()}`, text: "", phase: null, memoryCitation: null, delivery: null, questions: null };
          notify("item/started", { item: lane.message, threadId, turnId, startedAtMs: now() });
        }
        lane.message.text += u.content.text;
        chars("agent", u.content.text.length);
        notify("item/agentMessage/delta", { threadId, turnId, itemId: lane.message.id, delta: u.content.text });
      } else if (u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text") {
        chars("reasoning", u.content.text.length);
      } else if (u.sessionUpdate === "usage_update" && typeof u.used === "number") {
        if (!root) return;
        // Claude reports a guessed 200k window until a turn result carries a cost. Antigravity's
        // agent state reports the actual window directly and marks it as such.
        const known = lastContext.get(threadId)?.size ?? null;
        const window = u._meta?.["elpis/contextWindow"];
        const actual = u.cost || (wireObject(window) && window.actual === true);
        const size = actual && typeof u.size === "number" ? u.size : known;
        lastContext.set(threadId, { used: u.used, size });
        sendUsage(threadId, turnId, null);
      } else if (u.sessionUpdate === "plan" && Array.isArray(u.entries)) {
        const step: Record<string, string> = { pending: "pending", in_progress: "inProgress", completed: "completed" };
        const plan = u.entries.map((e) => ({ step: e.content, status: step[e.status] ?? "pending" }));
        // The adapter repeats an unchanged list (each task tool reports it twice); one row each.
        if (JSON.stringify(plan) === lane.lastPlan) return;
        lane.lastPlan = JSON.stringify(plan);
        notify("turn/plan/updated", { threadId, turnId, explanation: null, plan });
      } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        let t = lane.tools.get(u.toolCallId);
        if (!t) {
          if (u.sessionUpdate !== "tool_call") return;
          lane.closeMessage();
          t = { name: u.kind, title: null, raw: {}, response: null, text: null, diffs: [], status: "inProgress", declined: false, shown: false, start: now(), end: null };
          lane.tools.set(u.toolCallId, t);
        }
        if (u.toolName) t.name = u.toolName;
        if (u.title) t.title = u.title;
        if (u.rawInput && Object.keys(u.rawInput).length) t.raw = u.rawInput;
        if (u.toolResponse) t.response = u.toolResponse;
        for (const c of u.content ?? []) { if (c.type === "diff") t.diffs.push(c); else t.text = c.content.text; }
        const finished = u.status === "completed" || u.status === "failed";
        if (finished) { t.status = u.status as "completed" | "failed"; t.end = now(); lane.onIdle(); }
        if (/^(TodoWrite|Task(Create|Update|List|Get))$/.test(t.name as string)) return; // drawn as the plan
        // Draw the row once the real command is known; edits wait for their diff.
        if (!t.shown && Object.keys(t.raw).length && !EDIT_TOOLS.has(t.name as string)) {
          t.shown = true;
          notify("item/started", { item: toolItem(u.toolCallId, t, cwd), threadId, turnId, startedAtMs: t.start });
        }
        if (finished) {
          const item = toolItem(u.toolCallId, t, cwd);
          if (!t.shown) { t.shown = true; notify("item/started", { item: { ...item, status: "inProgress" }, threadId, turnId, startedAtMs: t.start }); }
          notify("item/completed", { item, threadId, turnId, completedAtMs: now() });
          lane.items.push(item);
          chars("toolCalls", JSON.stringify(t.raw).length);
          chars("toolResults", (item.aggregatedOutput ?? item.changes?.map((c) => c.diff).join("") ?? "").length);
        }
      }
    };
    // The open message and any row still running are closed, so nothing spins forever.
    lane.end = () => {
      lane.closeMessage();
      for (const [id, t] of lane.tools) {
        if (!t.shown || t.end) continue;
        t.status = "failed"; t.end = now();
        notify("item/completed", { item: toolItem(id, t, cwd), threadId, turnId, completedAtMs: now() });
      }
    };
    return lane;
  }

  return newLane;
}
