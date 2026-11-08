import type { Engine } from './acp-engine-transport.mts';
import type { EngineItem, EngineParams, EngineMessage, Tool } from './acp-engine-protocol.mts';
import type { RequestPermissionResponse, SessionUpdate, ToolCall, ToolCallContent, ToolCallStatus } from "@agentclientprotocol/sdk";
import type { Session } from './elpis-acp-agent.mts';
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk';
// The options every permission request offers, and the engine decision each one means. A cancelled request (the
// client cancelled the turn) is `cancel`, which also interrupts the turn; anything unknown is `decline`.
const OPTIONS: PermissionOption[] = [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow for this session", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];
const DECISIONS: Record<string, string> = { allow_once: "accept", allow_always: "acceptForSession", reject_once: "decline" };
const APPROVALS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
const cut = (s: string) => (s.length > 4000 ? `${s.slice(0, 4000)}\n…` : s);
export function createEngineEvents({ sessions, update, getEngine, requestPermission }: {
    sessions: Map<string, Session>;
    update(session: Session, event: SessionUpdate): Promise<void>;
    getEngine(): Engine;
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}) {
    // The engine's tool items as ACP tool calls.
    function toolOf(item: EngineItem): Tool | null {
        switch (item.type) {
            case "commandExecution": return { title: item.command || "Run a command", kind: "execute", rawInput: { command: item.command, cwd: item.cwd } };
            case "fileChange": return { title: `Edit ${(item.changes ?? []).map((c) => c.path).join(", ") || "files"}`, kind: "edit", locations: (item.changes ?? []).map((c) => ({ path: c.path })) };
            case "mcpToolCall": return { title: `${item.server}: ${item.tool}`, kind: "other", rawInput: item.arguments };
            case "dynamicToolCall": return { title: item.tool as string, kind: "other", rawInput: item.arguments };
            case "webSearch": return { title: `Search: ${item.query ?? ""}`.trim(), kind: "fetch" };
            default: return null;
        }
    }
    function showTool(s: Session, id: string, tool: Tool, status: ToolCallStatus, extra: Partial<ToolCall> = {}) {
        if (s.announced.has(id))
            return update(s, { sessionUpdate: "tool_call_update", toolCallId: id, status, ...extra });
        s.announced.add(id);
        return update(s, { sessionUpdate: "tool_call", toolCallId: id, status, ...tool, ...extra });
    }
    function chunk(s: Session, itemId: string, text: string) {
        if (!text)
            return;
        s.streamed.set(itemId, (s.streamed.get(itemId) ?? "") + text);
        const phase = s.phases.get(itemId);
        update(s, { sessionUpdate: "agent_message_chunk", messageId: itemId, content: { type: "text", text }, ...(phase ? { _meta: { elpis: { phase } } } : {}) });
    }
    function interrupt(s: Session) {
        const turn = s.turn;
        if (!turn?.id || turn.interrupting)
            return;
        turn.interrupting = true;
        getEngine().call("turn/interrupt", { threadId: s.id, turnId: turn.id }).catch(() => { });
    }
    function onEngineMessage(msg: EngineMessage) {
        const p = msg.params ?? {} as EngineParams;
        const s = sessions.get(p.threadId);
        if (msg.id !== undefined) {
            if (s && APPROVALS.has(msg.method ?? ""))
                return void approve(s, msg);
            return getEngine().refuse(msg.id, `${msg.method} is not supported by the Elpis ACP agent`);
        }
        if (!s)
            return;
        switch (msg.method) {
            case "turn/started":
                if (s.turn) {
                    s.turn.id ??= p.turn?.id;
                    if (s.turn.cancelled)
                        interrupt(s);
                }
                return;
            case "turn/completed": return s.turn?.finish(p.turn ?? {});
            case "item/agentMessage/delta": return chunk(s, p.itemId, p.delta);
            case "item/reasoning/summaryTextDelta":
                if (p.delta)
                    update(s, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: p.delta } });
                return;
            case "turn/plan/updated":
                update(s, { sessionUpdate: "plan", entries: (p.plan ?? []).map((e) => ({ content: e.step, priority: "medium", status: e.status === "inProgress" ? "in_progress" : e.status === "completed" ? "completed" : "pending" })) });
                return;
            case "item/started": {
                const item = p.item ?? {} as EngineItem;
                if (item.type === "agentMessage") {
                    s.phases.set(item.id, item.phase ?? null);
                    return;
                }
                const tool = toolOf(item);
                if (tool)
                    showTool(s, item.id, tool, "in_progress");
                return;
            }
            case "item/completed": {
                const item = p.item ?? {} as EngineItem;
                if (item.type === "agentMessage") {
                    if (item.phase && !s.phases.get(item.id))
                        s.phases.set(item.id, item.phase);
                    // A message that did not stream (or not all of it) is sent whole.
                    const sent = s.streamed.get(item.id) ?? "";
                    if (typeof item.text === "string" && item.text.length > sent.length && item.text.startsWith(sent))
                        chunk(s, item.id, item.text.slice(sent.length));
                    return;
                }
                const tool = toolOf(item);
                if (!tool)
                    return;
                const output: ToolCallContent[] | undefined = item.type === "commandExecution" && item.aggregatedOutput ? [{ type: "content", content: { type: "text", text: cut(item.aggregatedOutput) } }] : undefined;
                showTool(s, item.id, tool, item.status === "completed" ? "completed" : "failed", {
                    ...(output ? { content: output } : {}),
                    ...(item.type === "commandExecution" ? { rawOutput: { exitCode: item.exitCode ?? null, status: item.status } } : {}),
                });
                return;
            }
        }
    }
    // An engine approval request, asked of the ACP client. The tool call is announced (pending) first.
    async function approve(s: Session, msg: EngineMessage) {
        const p = msg.params ?? {} as EngineParams;
        const id = p.itemId;
        const tool: Tool = msg.method === "item/commandExecution/requestApproval"
            ? { title: p.command || "Run a command", kind: "execute", rawInput: { command: p.command, cwd: p.cwd, ...(p.reason ? { reason: p.reason } : {}) } }
            : { title: `Edit files${p.reason ? `: ${p.reason}` : ""}`, kind: "edit", rawInput: { reason: p.reason ?? null, grantRoot: p.grantRoot ?? null } };
        showTool(s, id, tool, "pending");
        let decision = "cancel";
        if (!s.turn?.cancelled) {
            try {
                const answer = await requestPermission({ sessionId: s.id, toolCall: { toolCallId: id, status: "pending", ...tool }, options: OPTIONS });
                decision = answer?.outcome?.outcome === "selected" ? DECISIONS[answer.outcome.optionId] ?? "decline" : "cancel";
            }
            catch {
                decision = "decline";
            }
        }
        getEngine().respond(msg.id as string | number, { decision });
        if (!["accept", "acceptForSession"].includes(decision))
            showTool(s, id, tool, "failed");
    }
    return { onEngineMessage, interrupt };
}
