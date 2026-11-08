import type { Dependencies } from './bridge-turn-types.mts';
import type { Acp } from "./bridge-acp.mts";
import type { BridgeError, ClaudeTurnRequest, ProviderAgent, ProviderTurn } from "./bridge-types.mts";
export async function prepareProviderSession({ log, SUBAGENT_TOOLS, SUBAGENTS_DISABLED, mcpServersFor, acpServersFrom, loadStore, storeChain, updateStore, refuseSignedOut, smartPruneProxy, threadCwd, threadSeen, threadPolicy, smartPrune, sessions, threadMcp, threadEnvironment, claudeModel, claudeEffort, materializedProviders, sessionModel, MODE_NAMES, claudeModeOf, sessionMode, devChars, ensureAcp, catalogFor, engineCall, elpisInstructions, subagentsAllowed, pendingMirrors, threadId, req, followup, agent, accountId, turnState, cwd }: Pick<Dependencies, "log" | "SUBAGENT_TOOLS" | "SUBAGENTS_DISABLED" | "mcpServersFor" | "acpServersFrom" | "loadStore" | "storeChain" | "updateStore" | "refuseSignedOut" | "smartPruneProxy" | "threadCwd" | "threadSeen" | "threadPolicy" | "smartPrune" | "sessions" | "threadMcp" | "threadEnvironment" | "claudeModel" | "claudeEffort" | "materializedProviders" | "sessionModel" | "MODE_NAMES" | "claudeModeOf" | "sessionMode" | "devChars" | "ensureAcp" | "catalogFor" | "engineCall" | "elpisInstructions" | "subagentsAllowed" | "pendingMirrors"> & {
    threadId: string;
    req: ClaudeTurnRequest;
    followup: boolean;
    agent: ProviderAgent;
    accountId: string | null;
    turnState: ProviderTurn;
    cwd: string;
}) {
    await pendingMirrors.get(threadId);
    const carrier = threadSeen.get(threadId);
    if (!carrier?.ephemeral && carrier?.historyMode === "paginated" && !materializedProviders.has(threadId)) {
        // Native turns persist at TurnStart; provider turns never enter that path.
        // A full paginated read is the engine's Standard persistence barrier. Wait
        // before inference so a crash cannot leave Claude's record without its carrier.
        await engineCall("thread/read", { threadId, includeTurns: true }, 5000);
        materializedProviders.add(threadId);
    }
    refuseSignedOut(agent);
    const acp = followup ? req.acp as Acp : await ensureAcp(agent);
    turnState.acp = acp;
    // The engine's confirmed policy only: the TUI puts its own choice on every turn/start,
    // also one the engine has not accepted yet, or refused.
    const policy = threadPolicy.get(threadId) ?? "on-request";
    const ask = policy !== "never";
    const mode = ask ? "ask" : "full";
    const appServers = acpServersFrom(threadMcp.get(threadId), threadId);
    const managed = appServers.some(server => server.name === 'elpis_mother');
    const environment: Record<string, string> = managed ? { ...threadEnvironment.get(threadId), GH_TOKEN: '', GITHUB_TOKEN: '' } : {};
    const managedMain = managed && environment.ELPIS_MOTHER_ROLE === 'orchestrator';
    const subagents = !managedMain && await subagentsAllowed(cwd);
    let live = sessions.get(threadId);
    let sessionId = null;
    let freshSession = false;
    // Smart Prune on: Claude's requests go through the proxy (`smartPruneProxy`).
    const prune = agent.key === "claude" && smartPrune.get(threadId) === true;
    // Capture admitted context at the turn boundary. Changed instructions (including an empty
    // selection), approval mode, Subagents or Smart Prune reload the native conversation.
    // Nothing reloads an in-flight turn; a changed agent starts afresh.
    const instructions = [await elpisInstructions(threadId, req.params.collaborationMode?.settings?.developer_instructions), ...(!subagents ? [SUBAGENTS_DISABLED] : [])].filter(Boolean).join("\n\n");
    // MCP servers are fixed when a session is created, so changed app servers reload it.
    const mcp = JSON.stringify(appServers);
    const environmentKey = JSON.stringify(environment);
    if (followup)
        sessionId = req.sessionId as string;
    else if (live && (live.accountId ?? null) === accountId && live.mode === mode && live.subagents === subagents && live.agent === agent.key && live.prune === prune && live.instructions === instructions && (live.mcp ?? "[]") === mcp && (live.environment ?? '{}') === environmentKey)
        sessionId = live.id;
    else {
        const cwd = threadCwd.get(threadId) ?? process.cwd();
        const proxy = prune ? await smartPruneProxy() : null;
        const browser = appServers.some((s) => s.name === "elpis_browser");
        const options = { ...(ask && { settingSources: ["project", "local"] }), ...(browser && { allowedTools: ["mcp__elpis_browser"] }), ...(managedMain && { tools: [] }), ...(!subagents && { disallowedTools: SUBAGENT_TOOLS }), ...((managed || proxy) && { env: { ...environment, ...(proxy && { ANTHROPIC_BASE_URL: proxy, NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",") }) } }) };
        const _meta = { systemPrompt: { append: instructions }, claudeCode: { options, emitRawSDKMessages: [{ type: "system", subtype: "init" }] } };
        devChars.set(threadId, instructions.length);
        log(`Elpis instructions for ${agent.speaker}: ${instructions.length} chars`);
        await storeChain();
        const store = await loadStore();
        const helper = !!store._delegations?.[threadId] || !!store[threadId]?.parentThreadId;
        const mcpServers = [...(managedMain ? [] : mcpServersFor(subagents, threadId, helper ? null : cwd, !helper)), ...appServers];
        // A session belongs to one agent; a chat that switched agent starts a fresh one, seeded below.
        const sameAccount = agent.key !== "claude" || (store[threadId]?.claudeAccountId ?? "default") === accountId;
        const sameAgent = (store[threadId]?.agent ?? "claude") === agent.key && sameAccount;
        const saved = (live && live.agent === agent.key && (live.accountId ?? null) === accountId ? live.id : null) ?? (sameAgent ? store[threadId]?.session ?? Object.values(store[threadId]?.sessions ?? {})[0] : null);
        if (saved) {
            acp.loading.add(saved);
            try {
                await acp.call("session/load", { sessionId: saved, cwd, mcpServers, _meta });
                sessionId = saved;
                log(`session ${saved} reloaded for thread ${threadId} (subagents ${subagents ? "on" : "off"})`);
            }
            catch (e) {
                log(`session reload failed: ${(e as BridgeError).message ?? JSON.stringify(e)}`);
            }
            acp.loading.delete(saved);
        }
        if (!sessionId) {
            sessionId = (await acp.call("session/new", { cwd, mcpServers, _meta })).sessionId;
            freshSession = true;
            log(`session ${sessionId} for thread ${threadId} in ${cwd} (${ask ? "Elpis asks" : "full access"}, policy ${policy}, subagents ${subagents ? "on" : "off"})`);
        }
        live = { id: sessionId, mode, subagents, agent: agent.key, accountId, prune, instructions, mcp, environment: environmentKey };
        sessions.set(threadId, live);
        const sid = sessionId;
        updateStore((st) => { st[threadId] = { ...st[threadId], session: sid, mode, agent: agent.key, ...(agent.key === "claude" && { claudeAccountId: accountId }) }; });
    }
    if (!followup) {
        updateStore((st) => { st[threadId] = { ...st[threadId], model: claudeModel.get(threadId), effort: claudeEffort.get(threadId) ?? null }; });
        const want = claudeModel.get(threadId)?.slice(agent.prefix.length);
        if (want && sessionModel.get(sessionId) !== want) {
            await acp.call("session/set_config_option", { sessionId, configId: "model", value: want });
            sessionModel.set(sessionId, want);
            log(`session ${sessionId} model -> ${want}`);
        }
        // The router has no built-in tools at all (tools: [] above); Plan mode would only block its routing tools.
        const wantMode = managedMain ? "bypassPermissions" : claudeModeOf(threadId, agent.key, ask);
        if (sessionMode.get(sessionId) !== wantMode) {
            await acp.call("session/set_mode", { sessionId, modeId: wantMode })
                .then(() => { sessionMode.set(sessionId, wantMode); log(`session ${sessionId} mode -> ${wantMode}`); })
                .catch(async (e) => {
                log(`mode ${wantMode}: ${e.message ?? JSON.stringify(e)}`);
                // A refused Bypass changes nothing the user sees: Full Access answers every question.
                if (wantMode === "bypassPermissions")
                    return;
                const allowed = (await catalogFor(agent)).modes;
                const why = allowed && !allowed.includes(wantMode) ? `${agent.speaker}'s own settings turn it off` : (e.message ?? "it refused");
                const kept = (MODE_NAMES as Record<string, string>)[sessionMode.get(sessionId) as string];
                throw new Error(`${agent.speaker} did not switch to ${MODE_NAMES[wantMode] ?? wantMode}: ${why}. ${kept ? `It stays in ${kept}.` : "Its mode is unchanged."} The turn was not started.`);
            });
        }
        const effort = claudeEffort.get(threadId);
        const known = (await catalogFor(agent)).efforts[want as string];
        if (effort && (!known || known.levels.some((l) => l.reasoningEffort === effort)))
            await acp.call("session/set_config_option", { sessionId, configId: "effort", value: effort }).catch((e) => log(`effort ${effort}: ${e.message}`));
    }
    turnState.sessionId = sessionId;
    return { acp, sessionId, freshSession, ask, subagents, policy };
}
