import path from "node:path";
import { BridgeError, object, text } from "./validate.mts";
import type { DesktopClient } from "./client.mts";
import { askBackground } from "./side-turn.mts";
import { workflowModelRoutes, MOTHER_ROUTE, MOTHER_FALLBACK } from "./workflow-models.mts";

/** "Elpis handle it" on the agents canvas (POST /api/canvas/plan): the Mother agent first decides whether the goal is
 * one agent's job ("direct": one agent whose prompt is the goal) or a team's ("team"), and plans it, in one call.
 * One turn in an ephemeral conversation on the Mother's model (3 Nov, Masih: the team is designed by a powerful model,
 * Opus 5.5 medium, shown worked examples), answered as JSON the schema fixes, then checked strictly: the canvas gets a
 * plan it can draw and run, or a clear refusal. */
export const PLAN_TIMEOUT_MS = 240000;
const LIMIT = 128;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const AGENT_FIELDS = ["key", "title", "prompt", "folders", "doneWhen", "waitsFor", "model", "effort"];
/** Model and thinking level: the planner's choice per agent; an empty one leaves the run's default. The board and the
 * Mother's mid-run additions may leave them out. */
const CHOSEN = ["model", "effort"];
const PLAN_FIELDS = ["name", "mode", "why", "agents"];
const MODES = ["direct", "team"];

const strings = { type: "array", items: { type: "string" } };
const string = { type: "string" };
/** Every property required and nothing extra, as strict structured output asks. */
export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: PLAN_FIELDS,
  properties: {
    name: string,
    mode: { type: "string", enum: MODES },
    why: string,
    agents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: AGENT_FIELDS,
        properties: {
          key: string,
          title: string,
          prompt: string,
          folders: strings,
          doneWhen: strings,
          waitsFor: strings,
          model: string,
          effort: string,
        },
      },
    },
  },
};

type BoardAgent = {
  key: string;
  title: string;
  prompt: string;
  folders: string[];
  doneWhen: string[];
  waitsFor: string[];
};
type Request = { goal: string; cwd?: string | undefined; folders: string[]; agents: BoardAgent[]; maxAgents: number };
type ModelRoute = ReturnType<typeof workflowModelRoutes>[number];
type PlannerClient = Pick<DesktopClient, "settings" | "sideRpc" | "on" | "off"> &
  Partial<Pick<DesktopClient, "models" | "providers">>;
const refuse = (reason: string) => new BridgeError(`Elpis returned a plan that cannot be used: ${reason}`, 502);

// ---- The request ---------------------------------------------------------------------------------------------

function list(value: unknown, label: string, { max = 400, size = 500 } = {}) {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || item.length > size))
    throw new BridgeError(`Invalid ${label}: give a list of text`);
  return value as string[];
}
const sameKey = (key: string) => new BridgeError(`Two agents on the board share the same key "${key}"`);

function folderList(value: unknown) {
  if (value === undefined) return [];
  const folders = list(value, "folders", { size: 300 });
  for (const folder of folders) {
    if (
      !folder ||
      folder.startsWith("/") ||
      /[\\\0]/.test(folder) ||
      folder.split("/").some(part => !part || part === "." || part === "..")
    )
      throw new BridgeError("Folders must be repository-relative paths");
  }
  return [...new Set(folders)];
}

function boardOf(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMIT)
    throw new BridgeError("Invalid agents: give the current board as a list");
  const keys = new Set();
  return value.map(entry => {
    entry = object(entry, AGENT_FIELDS) as Record<string, unknown>;
    if (typeof entry.key !== "string" || !KEY.test(entry.key))
      throw new BridgeError("Invalid agents: every agent needs a key");
    if (keys.has(entry.key)) throw sameKey(entry.key);
    keys.add(entry.key);
    for (const field of ["title", "prompt"])
      if (typeof entry[field] !== "string" || entry[field].length > 8000)
        throw new BridgeError(`Invalid agents: "${entry.key}" needs a ${field} (it may be empty)`);
    return {
      key: entry.key,
      title: entry.title as string,
      prompt: entry.prompt as string,
      folders: list(entry.folders, "agents (folders)", { size: 300 }),
      doneWhen: list(entry.doneWhen ?? [], "agents (doneWhen)", { max: 50 }),
      waitsFor: list(entry.waitsFor, "agents (waitsFor)", { max: LIMIT, size: 64 }),
    };
  });
}

function parseRequest(value: unknown): Request {
  const input = object(value, ["goal", "cwd", "folders", "agents", "maxAgents"]) as Record<string, unknown>;
  const goal = text(input.goal, "goal", 8000).trim();
  if (!Number.isSafeInteger(input.maxAgents) || (input.maxAgents as number) < 1 || (input.maxAgents as number) > LIMIT)
    throw new BridgeError(`Invalid maxAgents: give a whole number from 1 to ${LIMIT}`);
  if (input.cwd !== undefined && !path.isAbsolute(text(input.cwd, "working directory", 4096)))
    throw new BridgeError("Working directory must be absolute");
  return {
    goal,
    cwd: input.cwd as string | undefined,
    folders: folderList(input.folders),
    agents: boardOf(input.agents),
    maxAgents: input.maxAgents as number,
  };
}

// ---- The prompt ----------------------------------------------------------------------------------------------

export function promptFor(
  { goal, folders, agents, maxAgents }: Request,
  { models = [], preferences = "" }: { models?: ModelRoute[]; preferences?: string } = {},
) {
  const rules = [
    `mode: first decide. "direct" when one agent can finish the goal in one sitting (one file, one small change, one answer): then agents holds exactly one agent, whose prompt is the goal, word for word. "team" when the goal has independent parts, or the board already has agents. why: one line that says which and why.`,
    `Use at most ${maxAgents} agents.`,
    "Every agent writes: code or, for research and decisions, a markdown file in its own folder. No agent only reads or reports.",
    "Split by independent parts, not by role. An agent handling a feature also handles its tests. Never add a separate tester, reviewer or planner agent.",
    'folders: copy them from the folder list, the narrowest ones the agent writes; never the whole project, except "." for an agent that must write a file directly in the project root (such as a file the goal names there), which then runs alone. Two agents that run at the same time must not share a folder. Every agent also gets its own folder for its report, so an agent that changes no project files needs none.',
    "waitsFor: the keys of the agents this one builds on (a DAG, no loops). Agents that build on nothing wait for nothing, so they run in parallel.",
    "prompt: short and concrete (what to build, where, what to leave alone). title: plain language, 6 words at most. doneWhen: one to three checks anyone can verify. key: a short lowercase word with dashes. name: two to five plain words for the team.",
    models.length
      ? "model and effort: choose them for each agent from the model list, weighing only three things: how hard its job is, what it costs (a subscription model with quota left costs nothing extra; never choose one whose limit is reached), and the user's preferences. Harder work gets a stronger model and a higher thinking level. effort must be one the model lists."
      : "model and effort: leave both empty.",
    ...(agents.length
      ? [
          "Keep every existing agent's key. For an existing agent, fill only what is empty (prompt, folders, doneWhen) unless the goal asks to change it. Return a field you leave alone as it is, or empty: the canvas keeps what it has. Add agents for parts the board lacks; leave an agent out only if the goal asks.",
        ]
      : []),
  ];
  return [
    "You are the Mother agent, given this goal on a canvas. First decide whether to do it yourself or to split it into a team of coding agents; then give the smallest plan that achieves it. Answer only with the JSON the schema asks for. Use no tools: work from what is below.",
    `Goal:\n${goal}`,
    folders.length
      ? `Project folders (repository-relative). An agent's folders must be copied from this list, exactly:\n${folders.map(folder => `- ${folder}`).join("\n")}`
      : 'No folder list was given, so every agent\'s folders must be an empty list, or "." for an agent that writes a file directly in the project root.',
    agents.length
      ? `Current board (the agents the user already has; waitsFor lists the keys each builds on):\n${JSON.stringify(agents, null, 2)}`
      : "The board is empty: every agent is new.",
    models.length
      ? `Model list (id, thinking levels, whether its limit is reached):\n${models.map(route => `- ${route.model}: ${route.efforts?.join(", ") || "default only"}${route.exhausted ? " (limit reached)" : ""}`).join("\n")}`
      : "",
    preferences.trim()
      ? `The user's preferences (their custom instructions):\n${preferences.trim().slice(0, 4000)}`
      : "",
    `Rules:\n${rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}`,
    PRIORITIES,
    EXAMPLES,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const PRIORITIES = `Priorities, in this order:
1. A result anyone can check: every agent's doneWhen can be verified from what it wrote.
2. Speed: independent parts run side by side. Questions or areas that each need their own study of the code are independent parts, one agent each, even when each is small; an agent waits only for work it really builds on.
3. No waste: one agent per independent part, never one per role or step; one change or one answer that needs no separate studies is "direct".
4. Each agent the model and level its own job needs, weighing only its complexity, the cost and the user's preferences: work that must be right from reading code deeply (rules nobody wrote down, causes of bugs, design) gets the highest levels; mechanical work gets low ones.`;

/** Worked examples (few-shot). Model names here are placeholders: a real plan uses ids from the model list. */
const EXAMPLES = `Worked examples (shapes only; "strong-model" and "light-model" stand for ids from the model list):
Goal: "Rename the helper formatDate to formatDay everywhere." -> one sitting of work:
{"name":"Rename formatDate","mode":"direct","why":"One mechanical change across files; one agent finishes it.","agents":[{"key":"rename","title":"Rename formatDate","prompt":"Rename the helper formatDate to formatDay everywhere.","folders":["src"],"doneWhen":["no formatDate remains","the tests pass"],"waitsFor":[],"model":"light-model","effort":"low"}]}
Goal: "Translate docs/ into French and German." -> two independent parts, equal and easy:
{"name":"Docs in two languages","mode":"team","why":"Each language is independent, so two agents run side by side.","agents":[{"key":"french","title":"Translate the docs to French","prompt":"Translate every file in docs/ into French under docs/fr/.","folders":["docs/fr"],"doneWhen":["every docs/ file has a French copy"],"waitsFor":[],"model":"light-model","effort":"medium"},{"key":"german","title":"Translate the docs to German","prompt":"Translate every file in docs/ into German under docs/de/.","folders":["docs/de"],"doneWhen":["every docs/ file has a German copy"],"waitsFor":[],"model":"light-model","effort":"medium"}]}
Goal: "Review the payments service for security, speed and accessibility problems." -> three independent studies of the code, each deep:
{"name":"Payments review","mode":"team","why":"Three separate studies of the code; side by side they finish in a third of the time.","agents":[{"key":"security","title":"Review payments security","prompt":"Study services/payments for security problems; list each with file, line and evidence in a markdown report.","folders":[],"doneWhen":["every finding cites a file and line"],"waitsFor":[],"model":"strong-model","effort":"xhigh"},{"key":"speed","title":"Review payments speed","prompt":"Study services/payments for slow paths; list each with file, line and evidence in a markdown report.","folders":[],"doneWhen":["every finding cites a file and line"],"waitsFor":[],"model":"strong-model","effort":"high"},{"key":"a11y","title":"Review payments accessibility","prompt":"Study the payments screens for accessibility problems; list each with file, line and evidence.","folders":[],"doneWhen":["every finding cites a file and line"],"waitsFor":[],"model":"strong-model","effort":"high"}]}
Goal: "Find why sign-in fails on Safari, fix it, and update the sign-in guide." -> a hard part, then an easy part that builds on it:
{"name":"Safari sign-in fix","mode":"team","why":"The fix needs deep debugging; the guide depends on the fix but is easy.","agents":[{"key":"fix","title":"Fix Safari sign-in","prompt":"Find why sign-in fails on Safari in src/auth, fix it and add a test that fails without the fix.","folders":["src/auth"],"doneWhen":["the new test fails before the fix and passes after"],"waitsFor":[],"model":"strong-model","effort":"high"},{"key":"guide","title":"Update the sign-in guide","prompt":"Update docs/sign-in.md to match the fix.","folders":["docs"],"doneWhen":["the guide describes the fixed behaviour"],"waitsFor":["fix"],"model":"light-model","effort":"low"}]}`;

// ---- The answer ----------------------------------------------------------------------------------------------

function parse(answer: string): unknown {
  let body = answer.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced) body = fenced[1]!;
  try {
    return JSON.parse(body);
  } catch {
    throw refuse("the answer was not valid JSON");
  }
}
function shape(value: unknown, keys: string[], who: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refuse(`${who} must be an object`);
  const unknown = Object.keys(value).find(key => !keys.includes(key));
  if (unknown !== undefined) throw refuse(`${who} has an unknown field "${unknown}"`);
  return value as Record<string, unknown>;
}
function textList(agent: Record<string, unknown>, field: string, label: string): string[] {
  if (!Array.isArray(agent[field]) || agent[field].some(item => typeof item !== "string" || item.length > 500))
    throw refuse(`${label} has ${field} that is not a list of text`);
  return agent[field] as string[];
}

/** Also checks the Mother's mid-run additions (bridge/workflow-acp.mts): the same rules for keys, folders and wiring. */
export function checkPlan(
  answer: string,
  {
    folders,
    agents: board,
    maxAgents,
    models = [],
  }: { folders: string[]; agents: BoardAgent[]; maxAgents: number; models?: ModelRoute[] },
) {
  const plan = shape(parse(answer), PLAN_FIELDS, "The plan");
  if (typeof plan.name !== "string" || !plan.name.trim() || plan.name.length > 200)
    throw refuse("the plan has no name");
  if (!MODES.includes(plan.mode as string)) throw refuse('the plan has no mode ("direct" or "team")');
  if (typeof plan.why !== "string" || !plan.why.trim() || plan.why.length > 500)
    throw refuse("the plan does not say why it chose its mode");
  if (!Array.isArray(plan.agents) || !plan.agents.length) throw refuse("the plan has no agents");
  if (plan.mode === "direct" && plan.agents.length !== 1)
    throw refuse(`mode "direct" means one agent does the whole goal, but the plan has ${plan.agents.length} agents`);
  if (plan.agents.length > maxAgents)
    throw refuse(`the plan has ${plan.agents.length} agents; the limit is ${maxAgents}`);
  const known = new Map(board.map(agent => [agent.key, agent])),
    listed = new Set(folders),
    seen = new Set();
  const agents = plan.agents.map((raw, index) => {
    const label = `Agent ${typeof raw?.key === "string" && raw.key ? `"${raw.key}"` : `#${index + 1}`}`;
    const agent = shape(raw, AGENT_FIELDS, label);
    for (const field of AGENT_FIELDS)
      if (!(field in agent) && !CHOSEN.includes(field)) throw refuse(`${label} is missing ${field}`);
    if (typeof agent.key !== "string" || !KEY.test(agent.key))
      throw refuse(`${label} needs a key of letters, digits, dashes and underscores`);
    if (seen.has(agent.key)) throw refuse(`Two agents share the key "${agent.key}"`);
    seen.add(agent.key);
    const existing = known.get(agent.key);
    // An existing agent may come back empty: the canvas keeps what it has.
    for (const field of ["title", "prompt"]) {
      if (typeof agent[field] !== "string" || agent[field].length > (field === "title" ? 200 : 8000))
        throw refuse(`${label} has a ${field} that is not text of a usable length`);
      if (!agent[field].trim() && !existing) throw refuse(`${label} has no ${field}`);
    }
    const own = new Set(existing?.folders);
    const chosen = [...new Set(textList(agent, "folders", label))];
    // "." is the whole project: the only way to write a file in its root (28 Oct: "create hello.txt in the sandbox" could never pass).
    for (const folder of chosen)
      if (folder !== "." && !listed.has(folder) && !own.has(folder))
        throw refuse(`${label} uses the folder "${folder}", which is not in the project's folder list`);
    return {
      key: agent.key,
      title: (agent.title as string).trim(),
      prompt: (agent.prompt as string).trim(),
      folders: chosen,
      doneWhen: textList(agent, "doneWhen", label),
      waitsFor: [...new Set(textList(agent, "waitsFor", label))],
      ...route(agent, models),
    };
  });
  for (const agent of agents)
    for (const key of agent.waitsFor)
      if (!seen.has(key)) throw refuse(`Agent "${agent.key}" waits for "${key}", which is not in the plan`);
  const waits = new Map(agents.map(agent => [agent.key, agent.waitsFor])),
    done = new Set();
  const visit = (key: string, trail: string[]) => {
    if (trail.includes(key))
      throw refuse(`the plan has a loop: ${[...trail.slice(trail.indexOf(key)), key].join(" -> ")}`);
    if (done.has(key)) return;
    for (const next of waits.get(key)!) visit(next, [...trail, key]);
    done.add(key);
  };
  for (const agent of agents) visit(agent.key, []);
  return { name: plan.name.trim(), mode: plan.mode, why: plan.why.trim(), agents };
}

/** The planner's model and thinking level, kept only when the model is a listed route with quota left and the level is
 * one it lists; otherwise nothing, so the run's default applies. */
function route(
  agent: Record<string, unknown>,
  models: ModelRoute[],
): { model?: string; provider?: string; effort?: string } {
  const listed = models.find(item => item.model === agent.model && !item.exhausted);
  if (!listed) return {};
  return {
    model: listed.model,
    provider: listed.provider,
    ...(listed.efforts?.includes(agent.effort as string) ? { effort: agent.effort as string } : {}),
  };
}

/** The subscription routes the planner may choose from, and the user's custom instructions as their preferences. */
async function choices(client: Required<PlannerClient>) {
  try {
    const [catalog, providers, settings] = await Promise.all([client.models(), client.providers(), client.settings()]);
    // An unknown managed policy cannot authorize a connection (as the run's own routes, client.mjs modelRoutes).
    const managed = settings?.managed;
    const models = managed?.available
      ? workflowModelRoutes(catalog?.data ?? [], providers ?? {}, { modelProvider: managed.modelProvider as string })
      : [];
    return { models, preferences: settings?.options?.developerInstructions ?? "" };
  } catch {
    return { models: [], preferences: "" };
  }
}

// ---- The route's operation -----------------------------------------------------------------------------------

/** Decides and plans for `input.goal`: `{ name, mode, why, agents }`, one agent when mode is "direct". `client` is the bridge's DesktopClient. */
export async function planCanvas(
  client: PlannerClient,
  input: unknown,
  { timeoutMs = PLAN_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const request = parseRequest(input);
  const options =
    typeof client.models === "function"
      ? await choices(client as Required<PlannerClient>)
      : { models: [], preferences: "" };
  // A Claude-subscription model runs through the elpis-claude bridge: no provider, its level in the thread's config,
  // and no schema parameter, so the schema goes in the prompt (as tools/elpis-claude/workflow-agents.mts does).
  const ask = (route: typeof MOTHER_ROUTE | null) =>
    askBackground(client, {
      cwd: request.cwd,
      permissions: ":danger-full-access",
      timeoutMs,
      ...(signal ? { signal } : {}),
      ...(route?.provider === "claude"
        ? {
            prompt: `${promptFor(request, options)}\n\nAnswer with JSON only, matching this JSON Schema:\n${JSON.stringify(PLAN_SCHEMA)}`,
            model: { model: route.model },
            config: { model_reasoning_effort: route.reasoningEffort },
          }
        : {
            prompt: promptFor(request, options),
            schema: PLAN_SCHEMA,
            ...(route
              ? { model: { model: route.model, provider: route.provider }, effort: route.reasoningEffort }
              : {}),
          }),
      failed: "Elpis could not plan",
      late: `Elpis did not finish planning within ${timeoutMs / 1000} seconds. Try again, or add the agents yourself.`,
    });
  // The Mother's model, then her fallback; a test client without a model list plans on the background model.
  const routes = typeof client.models === "function" ? [MOTHER_ROUTE, MOTHER_FALLBACK] : [null];
  let answer, failure;
  for (const route of routes) {
    try {
      answer = await ask(route);
      break;
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = error;
    }
  }
  if (answer === undefined) throw failure;
  return checkPlan(answer, { ...request, models: options.models });
}
