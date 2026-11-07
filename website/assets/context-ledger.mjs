import { DEMO_TOKENS, DEMO_BASE_COUNTS, admissionStateAt } from "./demo-state.mjs?v=refined-20261015b";
// Hue roles and labels mirror tui/src/chatwidget/context_usage.rs. Labels keep
// the foreground color; category colors are graphical markers, not small text.
export const CATEGORIES = Object.freeze([
    { key: "user", label: "User messages", light: "#006cce", dark: "#53b1ff", help: "Your prompts and instructions sent as user messages." },
    { key: "agent", label: "Agent messages", light: "#00875c", dark: "#3fd394", help: "Agent responses retained in the request." },
    { key: "reasoning", label: "Reasoning + compaction", light: "#7143d6", dark: "#ab84ff", help: "Reasoning and compaction items reported in the built request, where available." },
    { key: "calls", label: "Tool calls", light: "#cd6700", dark: "#ffa13a", help: "Tool names and arguments requested by the agent." },
    { key: "results", label: "Tool results", light: "#74841b", dark: "#d9db75", help: "Outputs returned by tools, including file contents, command output and search results." },
    { key: "system", label: "System instructions", light: "#8c2d3c", dark: "#f0445d", help: "Runtime instructions that establish the agent’s baseline behavior." },
    { key: "developer", label: "Developer messages", light: "#ce478f", dark: "#ff99c2", help: "Application rules and capabilities supplied by the harness." },
    { key: "definitions", label: "Tool definitions + schema", light: "#646464", dark: "#a0a0a0", help: "Available tools and their input schemas also occupy the request." },
    { key: "other", label: "Unrecognized request items", light: "#008395", dark: "#1dd1e2", help: "Request items the estimator cannot confidently classify." },
]);
export function demoCategories(state) {
    const counts = [...DEMO_BASE_COUNTS];
    if (["working", "tools", "ace", "done"].includes(state.phase))
        counts[0] += DEMO_TOKENS.prompt;
    if (["tools", "ace", "done"].includes(state.phase))
        counts[4] += DEMO_TOKENS.read;
    if (state.phase === "done")
        counts[4] += DEMO_TOKENS.optimized;
    return counts;
}
const instructionSources = [["Project AGENTS.md", 1900], ["dev/AGENTS.md", 1500], ["dev/CODING_GUIDELINES.md", 976], ["dev/SKILL.md", 437], ["dev/TERMINAL_AND_GIT_RULES.md", 618]];
export function demoSnapshot(state) {
    return {
        total: state.total, limit: DEMO_TOKENS.limit, counts: demoCategories(state), smart: true, subagents: true,
        sources: [
            { name: "ES.md", group: "SESSION CONTINUITY", tokens: 156, admitted: true },
            { name: "MEMORY.md", group: "DURABLE MEMORY", tokens: 19, admitted: false, help: "Saved memory remains available for explicit admission." },
            { name: "Global AGENTS.md", group: "INSTRUCTIONS", tokens: 1538, admitted: false, help: "Global rules available for the next request." },
            ...instructionSources.map(([name, tokens]) => ({ name, tokens, group: "INSTRUCTIONS", admitted: true })),
        ],
    };
}
export const CONTEXT_EXAMPLE = Object.freeze(demoSnapshot(admissionStateAt(1)));
export const compactTokens = (n) => n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
export const sourceProjection = (sources) => sources.reduce((total, source) => total + (source.admitted ? source.tokens : 0), 0);
const share = (tokens, limit) => `${(tokens / limit * 100).toFixed(1)}%`;
const escape = (value) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
const helpAttributes = (help) => `data-ledger-help data-help="${escape(help)}" aria-expanded="false"`;
export function categoryBar(snapshot, className = "native-bar") {
    return `<div class="${className}" role="group" aria-label="${escape(CATEGORIES.map((c, i) => `${c.label}: ${snapshot.counts[i].toLocaleString("en-US")} tokens, ${share(snapshot.counts[i], snapshot.limit)} of the window`).join("; "))}; ${share(snapshot.limit - snapshot.total, snapshot.limit)} free">${CATEGORIES.map((c, i) => `<button type="button" data-category-segment="${c.key}" data-ledger-help data-help="${escape(c.label)}" aria-label="${escape(c.label)}" aria-expanded="false" style="--category:var(--category-${c.key});flex-basis:${share(snapshot.counts[i], snapshot.limit)}"></button>`).join("")}<button type="button" class="native-free" data-ledger-help data-help="Free" aria-label="Free" aria-expanded="false" style="flex-basis:${share(snapshot.limit - snapshot.total, snapshot.limit)}"></button></div>`;
}
export function categoryRows(snapshot, className = "native-categories") {
    return `<div class="${className}">${CATEGORIES.map((c, i) => `<button type="button" class="native-category" ${helpAttributes(c.help)}><i style="--category:var(--category-${c.key})" aria-hidden="true"></i><span>${c.label}</span><span data-category-value="${c.key}">≈${compactTokens(snapshot.counts[i])} · ${share(snapshot.counts[i], snapshot.limit)}</span></button>`).join("")}</div>`;
}
export function ledgerMarkup(snapshot, { interactive = false, compact = false } = {}) {
    const switchMarkup = (key, label, on, help, detail) => `<section class="native-section">
    <div class="native-switch-row"><button type="button" class="native-label" ${helpAttributes(help)}>${label}</button>
    <${interactive ? "button" : "span"} class="native-switch" data-enabled="${on}" ${interactive ? `type="button" data-ledger-switch="${key}" aria-pressed="${on}"` : ""}>${interactive ? `<span class="sr-only">${label} in example </span>` : ""}<span data-switch-glyph aria-hidden="true">${on ? "[━━━●]" : "[●━━━]"}</span> <span data-switch-state>${on ? "ON" : "OFF"}</span></${interactive ? "button" : "span"}></div>
    ${compact ? "" : `<p data-switch-detail="${key}">${detail}</p>${key === "smart" ? '<p>p toggle · /smart-prune on|off</p>' : ""}`}</section>`;
    const sourcesMarkup = ["SESSION CONTINUITY", "DURABLE MEMORY", "INSTRUCTIONS"].map(group => {
        const sources = snapshot.sources.filter(source => source.group === group);
        return `<section class="native-section native-source-group"><div class="native-group-heading"><strong>● ${group}</strong><span data-source-total="${group}">≈${compactTokens(sourceProjection(sources))} tokens admitted</span></div>
    ${sources.map(source => `<button type="button" class="native-source" ${interactive ? `data-ledger-source="${escape(source.name)}" aria-pressed="${source.admitted}"` : helpAttributes(source.help || "Explicitly admitted context; this estimate is attribution within the request, not an additional total.")}><span data-source-mark aria-hidden="true">${source.admitted ? "[x]" : "[ ]"}</span><u>${escape(source.name)}</u><span class="native-source-estimate">≈${source.tokens.toLocaleString("en-US")} est. tokens</span><span class="native-source-state">${source.admitted ? "INCLUDED" : "EXCLUDED"}</span></button>`).join("")}</section>`;
    }).join("");
    return `<div class="native-ledger${compact ? " native-ledger-compact" : ""}" data-ledger-interactive="${interactive}">
    <header class="native-headline"><strong>CONTEXT LEDGER</strong> <span data-native-total>≈${compactTokens(snapshot.total)} tokens in context</span></header>
    ${compact ? "" : '<p class="native-hints">Up/Down move · Space/Enter toggle · p prune · s subagents · i all · w why · Tab/Esc close</p>'}
    ${switchMarkup("smart", "SMART PRUNE", snapshot.smart, "Experimental and off by default. Optimize eligible fresh tool results before their first main-model send; sent history stays stable.", snapshot.smart ? "Before first main-model send · sent history stays stable" : "Tool results pass through unchanged")}
    ${switchMarkup("subagents", "SUBAGENTS", snapshot.subagents, "Allow delegation to other agents. Each agent has its own task and context.", snapshot.subagents ? "May delegate to other agents" : "All work stays in this thread")}
    <section class="native-section"><div class="native-window-heading"><strong>CONTEXT WINDOW</strong> <span data-native-window>≈${compactTokens(snapshot.total)} of ${compactTokens(snapshot.limit)} used (${Math.round(snapshot.total / snapshot.limit * 100)}%)</span></div>
      ${categoryBar(snapshot)}<button type="button" class="native-attribution-label" ${helpAttributes("The total is measured in Elpis. This illustration uses example counts. Category estimates reconcile to the total; percentages use the full window.")}>MEASURED TOTAL · ESTIMATED CATEGORY SHARES</button>
      <p>${compact ? "Shares use the full window" : "Estimated segments reconcile to measured active context; all shares use the full window"}</p>${categoryRows(snapshot)}</section>
    ${sourcesMarkup}</div>`;
}
export function updateLedger(element, snapshot) {
    element.querySelector("[data-native-total]").textContent = `≈${compactTokens(snapshot.total)} tokens in context`;
    element.querySelector("[data-native-window]").textContent = `≈${compactTokens(snapshot.total)} of ${compactTokens(snapshot.limit)} used (${Math.round(snapshot.total / snapshot.limit * 100)}%)`;
    element.querySelector(".native-bar").outerHTML = categoryBar(snapshot);
    CATEGORIES.forEach((category, i) => { element.querySelector(`[data-category-value="${category.key}"]`).textContent = `≈${compactTokens(snapshot.counts[i])} · ${share(snapshot.counts[i], snapshot.limit)}`; });
}
