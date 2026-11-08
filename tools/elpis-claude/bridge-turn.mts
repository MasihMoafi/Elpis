import { completeProviderTurn } from './bridge-turn-completion.mts';
import { prepareProviderSession } from './bridge-provider-session.mts';
import type { Dependencies, Mode } from './bridge-turn-types.mts';
import { randomUUID } from "node:crypto";
import { statSync, watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { recordedClaudeEnd } from "./claude-turn-record.mts";
import { acpErrorInfo } from "./acp-errors.mts";
import { previewOf } from "./bridge-thread-list.mts";
import { clipTurn, inputSummary, toAcpPrompt, plainCommand } from "./bridge-transcript.mts";
import { wireObject } from "./bridge-wire.mts";
import type { Acp } from "./bridge-acp.mts";

import type { AcpHandlers, AcpPermission, AcpUpdate, AcpUsage, BridgeError, ChildThread, ClaudeTurnRequest, EngineThread, Lane, PromptInput, ProviderTurn, SubagentUpdate, SubLane, TranscriptItem, TranscriptTurn, TurnOutcome, UsageTotals } from "./bridge-types.mts";

/** Execute a provider turn and draw its updates, approvals, and child sessions. */
export function createProviderTurn({
  log, now, SUBAGENT_TOOLS, SUBAGENTS_DISABLED, AUTONOMOUS_ORIGINS, REPLY_UPDATES, mcpServersFor, acpServersFrom,
  loadStore, storeChain, updateStore, deletedThreads, claudeAccounts, AGENTS, agentOf, refuseSignedOut,
  acpErrorMessage, RECONNECT_MS, RECONNECT_NOTE, connectionDropped, announceLimits, smartPruneProxy,
  recordAccounts, fullFor, cancelRelays, ws, toTui, notify, threadCwd, threadSeen, childThreads,
  childIds, threadPolicy, smartPrune, sessions, threadMcp, threadEnvironment, claudeModel, claudeEffort,
  materializedProviders, sessionModel, threadAccess, MODE_NAMES, claudeModeOf, accessModeOf, sessionMode,
  tokenSums, ctxChars, devChars, addChars, transcriptOf, lastTurnUsage, sendUsage, ensureAcp, catalogFor,
  engineCall, elpisInstructions, subagentsAllowed, activeTurns, reconnects, pendingMirrors, priorTranscript,
  askTui, newLane, runNext,
}: Dependencies) {
  // A37: a background job Claude started can end after its reply. Claude then answers on its own,
  // outside any prompt (the adapter's autonomous cycle), so between turns the chat's session wakes
  // a followup turn that shows the answer, as Claude Code does. Updates that carry no reply
  // (commands, modes, usage) wake nothing.
  function listenBetweenTurns(threadId: string, acp: Acp, sessionId: string) {
    const turnFor = (wake: boolean) => {
      const running = activeTurns.get(threadId);
      if (running || !wake || sessions.get(threadId)?.id !== sessionId || deletedThreads.has(threadId)) return running ?? null;
      void claudeTurn({ kind: "followup", params: { threadId }, acp, sessionId });
      return activeTurns.get(threadId) ?? null;
    };
    acp.bySession.set(sessionId, {
      // Until the turn listens itself, its updates reach it in order once its session is ready.
      onUpdate: (params: AcpUpdate) => { const t = turnFor(REPLY_UPDATES.has(params.update?.sessionUpdate)); t?.ready.then(() => (t.own as { onUpdate: (params: AcpUpdate) => void } | undefined)?.onUpdate(params)); },
      onPermission: async (params: AcpPermission) => { const t = turnFor(true); return t && (await t.ready) && t.own?.onPermission ? t.own.onPermission(params) : null; },
    });
  }

  async function claudeTurn(req: ClaudeTurnRequest): Promise<TurnOutcome> {
    const { threadId, input = [] } = req.params;
    clearTimeout(reconnects.get(threadId));
    reconnects.delete(threadId);
    const turnId = randomUUID();
    const turn: TranscriptTurn = { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null };
    if (req.id !== undefined) toTui({ id: req.id, result: req.kind === "review" ? { turn, reviewThreadId: threadId } : { turn } });
    const compacting = req.kind === "compact";
    // A37: Claude's own reply after a background job it started ends (listenBetweenTurns): no user message, no prompt.
    const followup = req.kind === "followup";
    const startedAt = Math.floor(now() / 1000);
    notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    notify("turn/started", { threadId, turn: { ...turn, startedAt } });
    notify("turn/costUpdated", { threadId, turnId, cost: { type: "unavailable", reason: "subscriptionAuthentication" } });
    const t0 = now();
    turn.startedAtMs = t0;
    let firstTokenAt = null;
    const userItem = followup ? null : req.kind === "review"
      ? { type: "enteredReviewMode", id: randomUUID(), review: req.reviewHint }
      : { type: "userMessage", id: randomUUID(), clientId: req.params.clientUserMessageId ?? null, content: input };
    const lead = userItem ? [userItem] : [];
    // A chat's first turn is not a saved turn until it ends; this lets any connection list the chat meanwhile.
    updateStore((st) => { st[threadId] = { ...st[threadId], active: { turnId, startedAt, startedAtMs: t0, pid: process.pid, cwd: threadCwd.get(threadId) ?? process.cwd(), userItems: lead, ...(userItem && { preview: previewOf(userItem).trim().slice(0, 500) }) } }; });
    for (const item of lead) {
      notify("item/started", { item, threadId, turnId, startedAtMs: now() });
      notify("item/completed", { item, threadId, turnId, completedAtMs: now() });
    }

    const cwd = threadCwd.get(threadId) ?? process.cwd();
    const lane = newLane(threadId, turnId, cwd, true);
    const { items, tools, closeMessage } = lane;
    // Claude's subagents in this turn: ACP session -> the child thread's lane.
    const subLanes = new Map<string, SubLane>();
    const busy = () => [...tools.values()].some((t) => !t.end) || [...subLanes.values()].some((l) => !l.done);
    // The running turn, from its first moment, so a steer or a stop during setup finds it.
    let sessionReady: (sessionId: string | null) => void = () => {}, finishTurn = () => {};
    const done = new Promise<void>((resolve) => { finishTurn = resolve; });
    const seed: Pick<ProviderTurn, "threadId" | "turnId" | "done" | "sessionId" | "items" | "closeMessage" | "cancelled" | "ready" | "toolsIdle" | "steers" | "promptEnded" | "bufferedUpdates"> = { threadId, turnId, done, sessionId: null, items, closeMessage, cancelled: false, ready: new Promise<string | null>((r) => { sessionReady = r; }), toolsIdle: [], steers: Promise.resolve(), promptEnded: false, bufferedUpdates: null };
    const turnState = seed as ProviderTurn;
    // Claude Code takes a steer at once and drops a tool that is still running (a subagent too),
    // so a steer waits for the running tools, as Claude Code's own queue does.
    turnState.toolsBusy = busy;
    turnState.whenToolsIdle = () => (!busy() ? Promise.resolve() : new Promise((r) => turnState.toolsIdle.push(r)));
    lane.onIdle = () => { if (!busy()) turnState.toolsIdle.splice(0).forEach((r) => r()); };
    turnState.snapshot = (view = "full") => ({ ...turn, startedAt, itemsView: view, items: view === "notLoaded" ? [] : view === "summary" ? [...lead, ...(lane.message ? [lane.message] : items.filter(item => item.type === "agentMessage").slice(-1))] : [...lead, ...items, ...(lane.message ? [lane.message] : [])] });
    // A followup ends at Claude's autonomous result, or when the user stops it.
    if (followup) turnState.followupEnded = new Promise((resolve) => { turnState.endFollowup = resolve; });
    activeTurns.set(threadId, turnState);
    let status = "completed";
    let error = null;
    const agent = agentOf(claudeModel.get(threadId)) ?? AGENTS[0];
    const accountId = agent.key === "claude" ? claudeAccounts.activeId() : null;
    let lastClaudeMessageId = null;
    try {
      const { acp, sessionId, freshSession, ask, subagents, policy } = await prepareProviderSession({ log, SUBAGENT_TOOLS, SUBAGENTS_DISABLED, mcpServersFor, acpServersFrom, loadStore, storeChain, updateStore, refuseSignedOut, smartPruneProxy, threadCwd, threadSeen, threadPolicy, smartPrune, sessions, threadMcp, threadEnvironment, claudeModel, claudeEffort, materializedProviders, sessionModel, MODE_NAMES, claudeModeOf, sessionMode, devChars, ensureAcp, catalogFor, engineCall, elpisInstructions, subagentsAllowed, pendingMirrors, threadId, req, followup, agent, accountId, turnState, cwd });
      sessionReady(sessionId);
      // The chat's updates draw into this turn; a subagent's come under its own ACP session and
      // draw into its child thread (see spawnSubagent). The turn hears only its own sessions.
      const own: AcpHandlers = turnState.own = {};
      const drawUpdate = ({ sessionId: sid, update: u }: AcpUpdate) => {
        // A subagent's start and each change of its work state, on its parent's session (the subagents RFD form).
        if (u.sessionUpdate === "subagent_update") {
          if (!subLanes.has(u.sessionId)) spawnSubagent(u, sid === sessionId ? lane : subLanes.get(sid) ?? lane);
          if (u.state?.state === "idle") finishSubagent(subLanes.get(u.sessionId), ({ end_turn: "completed", cancelled: "cancelled", error: "failed" } as Record<string, string>)[u.state.stopReason as string] ?? "completed");
          return;
        }
        const into = sid === sessionId ? lane : subLanes.get(sid);
        if (!into) { log(`update for unknown session ${sid}: ${u.sessionUpdate}`); return; }
        // The task its parent gave a subagent.
        if (u.sessionUpdate === "session_message") {
          if (into !== lane) into.say({ type: "userMessage", id: randomUUID(), clientId: null, content: (u.content ?? []).filter((b) => b.type === "text").map((b) => ({ type: "text", text: b.text, text_elements: [] })) });
          return;
        }
        if (into === lane && u.sessionUpdate === "agent_message_chunk") {
          firstTokenAt ??= now();
          // A143: Claude's id for its reply, where a rewind to the next turn forks its session.
          if (typeof u.messageId === "string" && u.messageId) lastClaudeMessageId = u.messageId;
        }
        into.update(u);
        if (followup && into === lane) {
          const origin = u.sessionUpdate === "usage_update" ? u._meta?.["_claude/origin"] : undefined;
          if (u.sessionUpdate === "usage_update" && wireObject(origin) && typeof origin.kind === "string" && AUTONOMOUS_ORIGINS.has(origin.kind)) (turnState.endFollowup as (result: { stopReason: string }) => void)({ stopReason: "end_turn" });
          else quietEnd();
        }
      };
      // Without the adapter's end marker, a followup ends after a minute without updates or running tools.
      const quietEnd = () => {
        clearTimeout(turnState.quiet);
        turnState.quiet = setTimeout(() => { if (busy()) quietEnd(); else (turnState.endFollowup as (result: { stopReason: string }) => void)({ stopReason: "end_turn" }); }, 60_000);
      };
      own.onUpdate = update => { if (turnState.bufferedUpdates) turnState.bufferedUpdates.push(update); else drawUpdate(update); };
      turnState.flushUpdates = () => {
        const buffered = turnState.bufferedUpdates ?? [];
        turnState.bufferedUpdates = null;
        for (const update of buffered) drawUpdate(update);
      };
      const spawnSubagent = (u: SubagentUpdate, parent: Lane) => {
        const childId = randomUUID();
        const name = u.title?.trim() || `${agent.speaker} subagent`;
        const task = (u.description ?? "").trim();
        const base: Partial<EngineThread> = threadSeen.get(threadId) ?? {};
        const t = Math.floor(now() / 1000);
        const depth = (parent.depth ?? 0) + 1;
        const thread: EngineThread = {
          ...base, id: childId, turns: [], forkedFromId: null, parentThreadId: parent.threadId, preview: task.slice(0, 200), ephemeral: false,
          name, agentNickname: name, agentRole: agent.speaker, canAcceptDirectInput: false, threadSource: "subagent", historyMode: "legacy",
          source: { subAgent: { thread_spawn: { parent_thread_id: parent.threadId, depth, agent_path: null, agent_nickname: name, agent_role: agent.speaker } } },
          model: claudeModel.get(threadId) ?? base.model ?? null, createdAt: t, updatedAt: t, recencyAt: t, path: null,
        };
        const sub = newLane(childId, randomUUID(), cwd, false) as SubLane;
        sub.depth = depth; sub.name = name; sub.parent = parent; sub.startedAt = t;
        subLanes.set(u.sessionId, sub);
        acp.bySession.set(u.sessionId, own);
        // Stop on its thread stops only this subagent, when the adapter can (its `cancel` capability).
        childThreads.set(childId, { thread, lane: sub, rootThreadId: threadId, cancel: u.capabilities?.cancel ? () => acp.send({ method: "session/cancel", params: { sessionId: u.sessionId } }) : null });
        childIds.add(childId);
        log(`claude subagent "${name}" (session ${u.sessionId}) -> child thread ${childId} of ${parent.threadId}`);
        notify("thread/started", { thread: { ...thread, status: { type: "active", activeFlags: [] } } });
        parent.activity("started", childId, name);
        notify("thread/status/changed", { threadId: childId, status: { type: "active", activeFlags: [] } });
        notify("turn/started", { threadId: childId, turn: { id: sub.turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: t, completedAt: null, durationMs: null } });
      };
      const finishSubagent = (sub: SubLane | undefined, state: string) => {
        if (!sub || sub.done) return;
        sub.end();
        sub.done = true;
        const turnStatus = state === "completed" ? "completed" : state === "failed" ? "failed" : "interrupted";
        const completedAt = Math.floor(now() / 1000);
        const record = { ...sub.turn(), status: turnStatus, completedAt, durationMs: (completedAt - sub.startedAt) * 1000 };
        notify("turn/completed", { threadId: sub.threadId, turn: { ...record, itemsView: "summary" } });
        notify("thread/status/changed", { threadId: sub.threadId, status: { type: "idle" } });
        sub.parent.activity(state === "completed" ? "completed" : "interrupted", sub.threadId, sub.name);
        log(`claude subagent "${sub.name}" ${state} (child thread ${sub.threadId})`);
        const thread = { ...(childThreads.get(sub.threadId) as ChildThread).thread, status: { type: "idle" } };
        updateStore((st) => { st[sub.threadId] = { parentThreadId: sub.parent.threadId, rootThreadId: threadId, thread, turns: [clipTurn(record)] }; });
        lane.onIdle();
      };
      turnState.endSubagents = () => { for (const sub of subLanes.values()) finishSubagent(sub, "cancelled"); };
      own.onPermission = async (p) => {
        const t = [lane, ...subLanes.values()].map((l) => l.tools.get(p.toolCall?.toolCallId as string)).find(Boolean);
        const what = (t && t.name === "Bash" && t.raw.command) || p.toolCall?.title || t?.title || "a tool";
        const pick = (kind: string) => p.options.find((o) => o.kind === kind)?.optionId;
        if (turnState.cancelled) return undefined;
        let access = accessModeOf(threadId, agent.key, (threadPolicy.get(threadId) ?? policy) !== "never");
        // Approving a plan is the user's to decide, in every mode (as Codex asks to implement it).
        const planIds = p.options.map((o) => o.optionId).filter((id) => id?.startsWith("exit-plan-"));
        // Full Access never asks, as in Codex: whatever the agent's own mode (its settings may
        // refuse Bypass, Claude Code still asks before writing in .claude, and a Plan turn goes on
        // after its plan), the bridge says yes.
        if (((threadPolicy.get(threadId) ?? policy) === 'never' && fullFor(threadId)) && !planIds.length) {
          log(`approval ${what} -> allowed (Full Access)`);
          return pick("allow_once") ?? pick("allow_always");
        }
        if ((threadPolicy.get(threadId) ?? policy) === "never" && !planIds.length) {
          log(`approval ${what} -> denied (restricted permissions cannot ask)`);
          if (t) t.declined = true;
          return pick("reject_once") ?? pick("reject_always") ?? null;
        }
        let reason = `${agent.speaker} wants to run: ${what}`;
        if (threadAccess.get(threadId)?.reviewer === "auto_review" && !planIds.length) {
          const reviewAccess = threadAccess.get(threadId);
          try {
            const review = await engineCall("thread/approval/review", { threadId, command: what, cwd, reason });
            if (turnState.cancelled) return undefined;
            if (reviewAccess !== threadAccess.get(threadId)) throw new Error("Permissions changed during automatic review; review the action again.");
            if (!["approved", "denied"].includes(review?.decision as string) || typeof review.rationale !== "string") throw new Error("Invalid automatic approval review response");
            log(`approval ${what} -> ${review.decision} (auto-review): ${review.rationale}`);
            if (review.decision === "approved") return pick("allow_once");
            if (t) t.declined = true;
            lane.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Automatic approval review denied the action: ${review.rationale}\n` } });
            lane.closeMessage();
            return pick("reject_once") ?? null;
          } catch (error) {
            if (turnState.cancelled) return undefined;
            reason += `\nAutomatic approval review failed: ${(error as BridgeError).message ?? JSON.stringify(error)}`;
          }
        }
        const decision = await askTui("item/commandExecution/requestApproval", {
          kind: "command", threadId, turnId, itemId: p.toolCall?.toolCallId ?? randomUUID(), startedAtMs: now(),
          environmentId: null, reason, command: what, cwd,
          // No "don't ask again": Claude Code would save that rule to the project for good,
          // while Elpis's label promises only this session.
          availableDecisions: ["accept", "decline", "cancel"],
        }, !planIds.length);
        if (turnState.cancelled) return undefined;
        access = accessModeOf(threadId, agent.key, (threadPolicy.get(threadId) ?? policy) !== "never");
        if ((threadPolicy.get(threadId) ?? policy) === "never" && !fullFor(threadId) && !planIds.length) {
          if (t) t.declined = true;
          return pick("reject_once") ?? pick("reject_always") ?? null;
        }
        const d = decision?.decision;
        log(`approval ${what} -> ${JSON.stringify(d)}`);
        if (d === "accept" && planIds.length) {
          // An approved plan goes on in the chat's permission mode, not Claude's "manually
          // approve edits". Claude offers Accept edits only when it offers neither Auto nor Bypass;
          // then the bridge switches to it once Claude has left Plan.
          const choices: Partial<Record<Mode, string[]>> = { bypassPermissions: ["bypass", "auto", "accept-edits"], auto: ["auto", "accept-edits"], acceptEdits: ["accept-edits"] };
          const want = choices[access] ?? [];
          const id = want.map((m) => `exit-plan-${m}`).find((x) => planIds.includes(x)) ?? "exit-plan-default";
          const mode = { "exit-plan-bypass": "bypassPermissions", "exit-plan-auto": "auto", "exit-plan-accept-edits": "acceptEdits" }[id] ?? "default";
          sessionMode.set(sessionId, mode);
          if (access === "acceptEdits" && mode === "default") {
            setTimeout(() => {
              if (turnState.cancelled || activeTurns.get(threadId) !== turnState
                || accessModeOf(threadId, agent.key, (threadPolicy.get(threadId) ?? policy) !== "never") !== "acceptEdits") return;
              acp.call("session/set_mode", { sessionId, modeId: "acceptEdits" })
                .then(() => { sessionMode.set(sessionId, "acceptEdits"); log(`session ${sessionId} mode -> acceptEdits (plan approved)`); })
                .catch((e) => log(`mode acceptEdits after the plan: ${e.message ?? JSON.stringify(e)}`));
            }, 200);
          }
          log(`plan approved: ${id}`);
          return planIds.includes(id) ? id : pick("allow_once");
        }
        if (d === "accept") return pick("allow_once") ?? pick("allow_always");
        if (t) t.declined = true;
        if (d === "cancel") {
          // "No, and tell Elpis what to do differently": stop the reply so the user can answer.
          turnState.cancelled = true;
          setImmediate(() => acp.send({ method: "session/cancel", params: { sessionId } }));
        }
        return pick("reject_once") ?? pick("reject_always") ?? null;
      };
      acp.bySession.set(sessionId, own);
      const userText = req.kind === "review" ? `[Code review requested: ${req.reviewHint}]` : inputSummary(input);
      const prompt = await toAcpPrompt(input);
      if (freshSession) {
        const history = await priorTranscript(threadId);
        if (history) {
          prompt.unshift({ type: "text", text: `This conversation started earlier in Elpis, possibly with another model. Here is the conversation so far, for context:\n\n${history}\n\n--- The user's new message follows. ---` });
          log(`seeded Claude with ${history.length} chars of earlier history`);
        }
      }
      if (compacting) ctxChars.delete(threadId);
      else addChars(threadId, "user", prompt.filter((c) => c.type === "text").reduce((n, c) => n + (c.text as string).length, 0));
      const file = transcriptOf(threadId);
      let transcriptOffset = 0;
      try { if (file) transcriptOffset = statSync(file).size; } catch {}
      const inputs = [prompt.filter(block => block.type === "text").map(block => block.text).join("\n")];
      turnState.inputs = inputs;
      await updateStore(st => { if (st[threadId]?.active?.turnId === turnId) Object.assign(st[threadId].active, { transcriptOffset, inputs }); });
      let recovering: Promise<void> | null = null;
      turnState.recover = () => {
        if (recovering) return recovering;
        if (followup || !file || turnState.promptEnded || turnState.cancelled) return;
        return recovering ??= (async () => {
          const expected = [...inputs];
          const final = await recordedClaudeEnd(file, transcriptOffset, expected);
          if (!final || expected.length !== inputs.length || expected.some((text: string, index) => text !== inputs[index]) || turnState.promptEnded || turnState.cancelled || activeTurns.get(threadId) !== turnState) return;
          // The record proves this prompt ended even if the adapter lost its live answer/result.
          turnState.promptEnded = true;
          turnState.toolsIdle.splice(0).forEach(resolve => resolve());
          acp.settleRecorded(sessionId, "_session/steering", { outcome: "injected" });
          await turnState.steers;
          (turnState.flushUpdates as () => void)();
          const known = lane.message?.text ?? items.filter(item => item.type === "agentMessage").at(-1)?.text ?? "";
          if (!known.endsWith(final.text)) lane.say({ type: "agentMessage", id: final.id ?? randomUUID(), text: final.text });
          acp.send({ method: "session/cancel", params: { sessionId } });
          acp.settleRecorded(sessionId, "session/prompt", { stopReason: "end_turn" });
          await done;
        })().catch(e => log(`turn recovery: ${e.message}`)).finally(() => { recovering = null; });
      };
      if (file && !followup) {
        try {
          await mkdir(dirname(file), { recursive: true });
          let timer: NodeJS.Timeout;
          const watcher = watch(dirname(file), (_event, name) => {
            if (String(name) !== basename(file)) return;
            clearTimeout(timer);
            // Let ordinary ACP delivery finish first. No polling, and no watcher after the turn.
            timer = setTimeout(() => { void (turnState.recover as () => Promise<void>)(); }, 250);
          });
          watcher.on("error", error => log(`turn record watcher: ${error.message}`));
          turnState.stopRecordWatch = () => { clearTimeout(timer); watcher.close(); };
        } catch (error) { log(`turn record watcher: ${(error as BridgeError).message}`); }
      }
      const followupEnded = turnState.followupEnded;
      if (followup && !followupEnded) throw new Error("The provider follow-up has no completion signal.");
      const result: { stopReason: string; usage?: AcpUsage | null } = turnState.cancelled ? { stopReason: "cancelled" } : followupEnded ? await followupEnded : await acp.call("session/prompt", { sessionId, prompt });
      clearTimeout(turnState.quiet);
      turnState.promptEnded = true;
      turnState.toolsIdle.splice(0).forEach(resolve => resolve());
      await turnState.steers;
      const tu = result.usage;
      if (tu) {
        const turnUsage = { input: tu.inputTokens ?? 0, output: tu.outputTokens ?? 0, cachedRead: tu.cachedReadTokens ?? 0, cachedWrite: tu.cachedWriteTokens ?? 0, total: tu.totalTokens ?? 0 };
        const sum = tokenSums.get(threadId) ?? { input: 0, output: 0, cachedRead: 0, cachedWrite: 0, total: 0 };
        for (const k of Object.keys(sum) as (keyof UsageTotals)[]) sum[k] += turnUsage[k];
        tokenSums.set(threadId, sum);
        sendUsage(threadId, turnId, turnUsage);
      }
      if (result.stopReason === "cancelled") status = "interrupted";
      closeMessage();
      // The engine's copy of this turn, in order, so other models and resume see it.
      const record: { type: string; role: string; content: { type: string; text: string }[] }[] = [];
      const say = (role: string, text: string) => record.push({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });
      let used: string[] = [];
      const flush = () => { if (used.length) say("assistant", `[${claudeModel.get(threadId) ?? agent.speaker} used tools: ${used.join("; ")}]`); used = []; };
      if (!followup) say("user", userText);
      for (const it of items) {
        if (it.type === "userMessage") { flush(); say("user", inputSummary(it.content as PromptInput[])); }
        else if (it.type === "commandExecution") used.push(plainCommand(it.command as string));
        else if (it.type === "fileChange") used.push(`edited ${(it.changes as NonNullable<TranscriptItem["changes"]>).map((c) => c.path).join(", ")}`);
        else if (it.type === "subAgentActivity" && it.kind === "started") used.push(`started the subagent "${it.agentPath}"`);
        else if (it.type === "agentMessage" && (it.text as string).trim()) { flush(); say("assistant", (it.text as string).trim()); }
      }
      flush();
      if (!compacting) {
        const mirror = engineCall("thread/inject_items", { threadId, items: record }, 5000)
          .then(() => log(`recorded Claude turn in thread ${threadId} (${record.length} items)`))
          .catch(e => {
            log(`record failed for ${threadId}: ${e.message ?? JSON.stringify(e)}`);
            notify("warning", { threadId, message: "The answer is saved, but its native history copy could not be confirmed." });
          }).finally(() => { if (pendingMirrors.get(threadId) === mirror) pendingMirrors.delete(threadId); });
        pendingMirrors.set(threadId, mirror);
      }
    } catch (e) {
      status = "failed";
      const dropped = connectionDropped(e as BridgeError) && !compacting;
      error = { message: dropped ? RECONNECT_NOTE : acpErrorMessage(e as BridgeError, agent), codexErrorInfo: dropped ? null : acpErrorInfo(e as BridgeError), additionalDetails: null };
      log(`turn error ${JSON.stringify(e)}`);
      if (dropped) reconnects.set(threadId, setTimeout(() => {
        reconnects.delete(threadId);
        if (activeTurns.has(threadId) || deletedThreads.has(threadId) || !claudeModel.has(threadId)) return;
        void claudeTurn({ kind: "queued", params: { threadId, input: [{ type: "text", text: "The connection dropped before you could answer. Continue where you left off.", text_elements: [] }] } });
      }, RECONNECT_MS));
    }
    turnState.stopRecordWatch?.();
    sessionReady(null);
    // The ended turn answers for its sessions no more: a late approval from them is refused.
    for (const sid of [turnState.sessionId, ...subLanes.keys()]) {
      if (turnState.own && (turnState.acp as Acp).bySession.get(sid as string) === turnState.own) (turnState.acp as Acp).bySession.delete(sid as string);
    }
    if (agent.key === "claude" && turnState.sessionId) listenBetweenTurns(threadId, turnState.acp as Acp, turnState.sessionId);
    // A subagent or row still running when the turn ends (stop, error) must not spin forever.
    turnState.endSubagents?.();
    lane.end();
    if (req.kind === "review") {
      const exit = { type: "exitedReviewMode", id: randomUUID(), review: items.filter((i) => i.type === "agentMessage").map((i) => i.text).join("\n\n").trim() };
      notify("item/started", { item: exit, threadId, turnId, startedAtMs: now() });
      notify("item/completed", { item: exit, threadId, turnId, completedAtMs: now() });
      items.push(exit);
    }
    cancelRelays(ws, threadId, turnId);
    turnState.toolsIdle.splice(0).forEach((r) => r());
    return completeProviderTurn({ now, updateStore, sessions, activeTurns, notify, announceLimits, recordAccounts, log, runNext, lastTurnUsage }, { threadId, turnId, lead, items, status, error, startedAt, t0, lastClaudeMessageId, turnState, agent, firstTokenAt, finishTurn });
  }

  return claudeTurn;
}
