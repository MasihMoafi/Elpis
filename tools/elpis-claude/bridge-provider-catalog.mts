import { wireObject } from "./bridge-wire.mts";
import type { ClaudeWindow, AgyBucket, AgyGroup, RateLimit, ProviderAgent, Catalog } from "./bridge-types.mts";
import { isSignedOut, SIGNED_OUT_MESSAGE } from "./anthropic-signout.mts";
import { ClaudeAccounts } from "./claude-accounts.mts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
export function createProviderCatalog({ HOME, STATE_DIR, CLAUDE, ADAPTER, claudeAccounts, log }: {
    HOME: string;
    STATE_DIR: string;
    CLAUDE: string;
    ADAPTER: string;
    claudeAccounts: ClaudeAccounts;
    log(text: string): void;
}) {
    const CATALOG = `${STATE_DIR}/catalog.json`;
    // Elpis's own sign-out of the Claude subscription (anthropic-signout.mts), read whenever it matters, so
    // the terminal and the desktop follow it at once. While it is on, Claude's models, usage and turns are
    // gone from Elpis; Claude Code's own login (~/.claude) is never touched.
    const claudeSignedOut = () => isSignedOut(STATE_DIR);
    // The subscriptions Elpis reaches through ACP, each by a model-id prefix. Antigravity (Gemini on
    // the Google sign-in) runs through agy-acp.mts and is offered only when `agy` is installed.
    const AGY_BIN = process.env.AGY_BIN ?? `${HOME}/.local/bin/agy`;
    const AGENTS: [
        ProviderAgent,
        ...ProviderAgent[]
    ] = [
        { key: "claude", speaker: "Claude", prefix: "claude/", label: "Claude subscription", description: "Claude Code on your Pro/Max plan", adapter: ADAPTER, get env() { return { CLAUDE_CODE_EXECUTABLE: CLAUDE, ...claudeAccounts.environment() }; }, catalogFile: CATALOG, signedOut: claudeSignedOut, limits: () => (claudeSignedOut() ? Promise.resolve([]) : claudeLimitsCached().then((one) => [one])) },
        ...(!process.env.ELPIS_NO_AGY && existsSync(AGY_BIN)
            ? [{ key: "agy", speaker: "Gemini", prefix: "agy/", label: "Antigravity", description: "Antigravity, your Google sign-in", adapter: new URL("./agy-acp.mts", import.meta.url).pathname, env: { AGY_BIN }, catalogFile: CATALOG.replace(/catalog\.json$/, "catalog-agy.json"), limits: () => agyLimitsCached() }]
            : []),
    ];
    const agentOf = (model: unknown) => (typeof model === "string" ? AGENTS.find((a) => model.startsWith(a.prefix)) : undefined);
    // Whether a model (or agent) is one Elpis has signed out of, and the error that refuses its turn.
    const signedOutModel = (model: unknown) => agentOf(model)?.signedOut?.() === true;
    const refuseSignedOut = (agent: ProviderAgent | undefined) => { if (agent?.signedOut?.())
        throw Object.assign(new Error(SIGNED_OUT_MESSAGE), { signedOut: true }); };
    const acpErrorMessage = (e: {
        signedOut?: boolean;
        message?: string;
    } | null | undefined, agent = AGENTS[0]) => (e?.signedOut ? e.message : `${agent.speaker} (ACP) error: ${e?.message ?? JSON.stringify(e)}`);
    // A dropped or timed-out connection is no error to show: the chat retries on its own (any message retries at once).
    const RECONNECT_MS = Number(process.env.ELPIS_RECONNECT_MS) || 180000;
    const connectionDropped = (e: {
        message?: string;
    } | null | undefined) => /API Error/.test(e?.message ?? "") && /connection|timed? ?out|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network/i.test((e as {
        message: string;
    }).message);
    const RECONNECT_NOTE = `Connection lost. Retrying in ${RECONNECT_MS >= 60000 ? `${RECONNECT_MS / 60000} minutes` : `${RECONNECT_MS / 1000} seconds`}; send a message to retry now.`;
    async function readJson(path: string): Promise<Catalog | null> { try {
        const { readFile } = await import("node:fs/promises");
        return JSON.parse(await readFile(path, "utf8")) as Catalog;
    }
    catch {
        return null;
    } }
    async function claudeLimits() {
        const { readFile } = await import("node:fs/promises");
        const creds = claudeAccounts.credentials();
        if (!creds?.accessToken)
            throw new Error("Sign in to the selected Claude account in Models & accounts.");
        const r = await fetch(process.env.ELPIS_CLAUDE_USAGE_URL ?? "https://api.anthropic.com/api/oauth/usage", {
            headers: { Authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
            signal: AbortSignal.timeout(15000),
        });
        if (!r.ok)
            throw new Error(`Claude usage request failed (HTTP ${r.status})`);
        const u = await r.json() as {
            five_hour?: ClaudeWindow | null;
            seven_day?: ClaudeWindow | null;
        };
        const win = (w: ClaudeWindow | null | undefined, mins: number) => w ? { usedPercent: Math.round(w.utilization ?? 0), windowDurationMins: mins, resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : null } : null;
        return { limitId: "claude", limitName: "Claude", normalModelSlug: null, primary: win(u.five_hour, 300), secondary: win(u.seven_day, 10080), credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null };
    }
    // Antigravity's own /usage answer: each model group has a 5-hour and a weekly limit.
    async function agyLimits() {
        const out = await new Promise<string>((resolve, reject) => execFile(AGY_BIN, ["--print", "/usage", "--output-format", "json"], { cwd: HOME, timeout: 30000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
        const groups = (JSON.parse(out) as {
            command?: {
                data?: {
                    groups?: AgyGroup[];
                };
            };
        }).command?.data?.groups ?? [];
        const win = (b: AgyBucket | undefined, mins: number) => b ? { usedPercent: Math.round((1 - (b.remaining_fraction ?? 1)) * 100), windowDurationMins: mins, resetsAt: b.reset_time ? Math.floor(Date.parse(b.reset_time) / 1000) : null } : null;
        return groups.map((g) => ({
            limitId: `antigravity-${g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, limitName: `Antigravity ${g.name}`, normalModelSlug: null,
            primary: win(g.buckets?.find((b) => b.window === "5h"), 300), secondary: win(g.buckets?.find((b) => b.window === "weekly"), 10080),
            credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null,
        }));
    }
    // Anthropic refuses (HTTP 429) when asked after every turn, so each subscription is asked at
    // most once a minute, and its last answer stays when a request fails.
    function everyMinute<T>(fetchLimits: () => Promise<T>, what: string) {
        const c: {
            at: number;
            value: T | null;
            inFlight: Promise<T> | null;
        } = { at: 0, value: null, inFlight: null };
        return () => {
            if (Date.now() - c.at < 60000)
                return c.value ? Promise.resolve(c.value) : Promise.reject(new Error(`${what} unavailable (retrying in a minute)`));
            c.inFlight ??= fetchLimits()
                .then((v) => { c.value = v; return v; })
                .catch((e) => { if (c.value)
                return c.value; throw e; })
                .finally(() => { c.at = Date.now(); c.inFlight = null; });
            return c.inFlight;
        };
    }
    const claudeLimitCaches = new Map<string, () => Promise<RateLimit>>();
    const claudeLimitsCached = () => {
        const id = claudeAccounts.activeId();
        let cache = claudeLimitCaches.get(id);
        if (!cache) {
            cache = everyMinute(claudeLimits, "Claude usage");
            claudeLimitCaches.set(id, cache);
        }
        return cache();
    };
    const agyLimitsCached = everyMinute(agyLimits, "Antigravity usage");
    // The TUI applies a resumed or started thread's collaboration mode after its model, so a bridged
    // chat must name its own model there too, or the engine's default replaces it on screen.
    function nameModel(result: {
        thread: object;
        collaborationMode?: {
            settings?: object;
        } | null;
    }, model: string, effort: string | null | undefined) {
        Object.assign(result, { model, reasoningEffort: effort ?? null });
        Object.assign(result.thread, { model, reasoningEffort: effort ?? null });
        const settings = result.collaborationMode?.settings;
        if (settings)
            Object.assign(settings, { model, reasoning_effort: effort ?? null });
    }
    // A subscription's limits as account/rateLimits/updated notifications, so /usage has them as soon
    // as its chat opens or a turn ends.
    function announceLimits(agent: ProviderAgent | undefined, send: (method: string, params: {
        rateLimits: RateLimit;
    }) => void) {
        agent?.limits().then((all) => {
            for (const rateLimits of all) {
                log(`${rateLimits.limitName} limits: 5h ${rateLimits.primary?.usedPercent}% week ${rateLimits.secondary?.usedPercent}%`);
                send("account/rateLimits/updated", { rateLimits });
            }
        }).catch((e) => log(`${agent.key} limits: ${e.message}`));
    }
    // /usage reads every account's limits at once, but the engine only knows OpenAI's, so a Claude
    // chat showed the GPT plan. Each subscription answers within 5 s or is left out; without a
    // ChatGPT sign-in the engine refuses, and the subscriptions' limits answer instead.
    async function addSubscriptionLimits(answer: {
        result?: Record<string, unknown> | null;
        error?: unknown;
    }) {
        const within = (limits: Promise<RateLimit[]>) => Promise.race([limits, new Promise<RateLimit[]>((resolve) => setTimeout(resolve, 5000, []))]).catch(() => []);
        const limits = (await Promise.all(AGENTS.map((agent) => within(agent.limits())))).flat();
        if (!limits.length)
            return;
        const byId = Object.fromEntries(limits.map((one) => [one.limitId, one]));
        if (answer.result)
            answer.result.rateLimitsByLimitId = { ...(wireObject(answer.result.rateLimitsByLimitId) ? answer.result.rateLimitsByLimitId : {}), ...byId };
        else {
            delete answer.error;
            answer.result = { rateLimits: limits[0] as RateLimit, rateLimitsByLimitId: byId };
        }
    }
    return { AGENTS, agentOf, signedOutModel, refuseSignedOut, acpErrorMessage, RECONNECT_MS, connectionDropped, RECONNECT_NOTE, readJson, nameModel, announceLimits, addSubscriptionLimits, claudeSignedOut };
}
