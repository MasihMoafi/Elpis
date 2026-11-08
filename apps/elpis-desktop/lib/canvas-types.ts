import type { CanvasFrame } from "./canvas-editing";
import type { MOTHER } from "./canvas-graph";
/** The agents canvas (components/agents-canvas.tsx): agents are nodes, a wire A → B means B waits for A, and a run
 * sends the graph to the ACP scheduler (POST /api/workflows/run, bridge/client.mjs `runWorkflow`).
 * Every agent on the board writes: Elpis checks each writer with a verify task that writes only its report, which the run adds itself
 * (`runTasks`), and reading or planning happens inside the writers (lat.md/tasks.md, 17 October 2026). */
/** `provider` is null for the engine's own provider; `effort` is the thinking level (sent per task); `writeScopes` are the project's
 * folders the agent may write ("." is the whole project) besides its own folder (`ownFolders`). */
export type AgentData = {
  character?: string;
  characterImage?: string;
  muted?: boolean;
  title: string;
  instruction: string;
  model: string | null;
  provider?: string | null;
  effort?: string | null | undefined; /** OpenAI Fast: the turn's "priority" tier. */
  fast?: boolean;
  writeScopes: string[];
  acceptanceCriteria: string[];
  /** How its check proves the work, when a ready-made workflow knows better than running the build or the tests; false: no check. */
  check?: string | false;
  /** Done by Elpis, not an agent: `parts` written in order into `output` (`flow`: pages that may end mid-sentence). */
  join?: {
    parts: string[];
    output: string;
    flow?: boolean;
  };
};
export type NoteData = {
  text: string;
};
export type Position = {
  x: number;
  y: number;
};
/** `isoPosition` pins a manually placed pedestal in projected ground units until Arrange is used. */
export type CanvasNode = (
  | {
      id: string;
      type: "agent";
      position: Position;
      data: AgentData;
    }
  | {
      id: string;
      type: "note";
      position: Position;
      data: NoteData;
    }
  | {
      id: typeof MOTHER;
      type: "mother";
      position: Position;
      data: Record<string, never>;
    }
) & {
  isoPosition?: Position | undefined;
};
/** A wire: by default the target waits for the source (directional); `alongside` (undirectional) means the two work
 * at the same time, each told about the other and kept out of its folders, with no order between them. */
export type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  kind?: "alongside" | undefined;
  label?: string;
  feedback?: boolean | undefined;
};
/** The Mother's settings, for the whole run: its goal (`brief`), which every agent gets and from which Elpis fills in
 * what the user left empty, and the model of her chat (the run's root). */
export type MotherSettings = {
  brief: string;
  model: string | null;
  provider: string | null;
};
/** `maxAgents` is the most agents the graph may hold; `template` is the architecture it was loaded from. */
export type CanvasGraph = {
  name: string;
  request?: string | undefined;
  workflowId?: string | undefined;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  frames?: CanvasFrame[] | undefined;
  minimap?: boolean;
  maxAgents?: number | undefined; /** The whole run's time limit, in minutes. */
  timeLimit?: number;
  template?: string | undefined;
  planningPattern?: string;
  result?: string; /** Translate: the target language's id. */
  language?: string;
  mother?: MotherSettings | undefined;
  motherFlow?: string;
  roundLimit?:
    | number
    | undefined; /** "Mother re-plans" (1 Nov): she may add, cancel or steer agents when one succeeds; on unless turned off. */
  replan?: boolean; /** "Runs on" (1 Nov): every agent's task on this computer, or on his CloudRoom VM; the Mother stays here. */
  runsOn?: "local" | "cloudroom";
};
/** A task's state from /api/workflows, shared by ACP runs and retained native history. */
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
/** `reasoningEffort` is the agent's thinking level, checked by its adapter and model. */
export type RunTask = {
  id: string;
  kind: "implement" | "verify" | "join";
  parts?: string[];
  output?: string;
  flow?: boolean;
  title: string;
  instruction: string;
  dependsOn: string[];
  writeScopes: string[];
  acceptanceCriteria: string[];
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: "priority" | "fast"; /** No check follows: the person judges it. */
  unchecked?: true;
  feedbackFrom?: string[];
};
/** The ready-made architectures: the workflow patterns of Anthropic's "Building effective agents", its multi-agent
 * research system, LangGraph's hierarchical teams and Open Deep Research, all as writing agents. Where a pattern has
 * no code to write (voting, debate, research), each agent writes its findings as a file in its folder and the last
 * one writes the result from them. Each is laid out in run order (`arrange`). Routing is left out: the engine runs
 * every branch of a graph, so it can't pick one. */
export type Template = {
  id: string;
  name: string;
  group: "Patterns" | "Research" | "Start";
  source: string;
  description: string;
  caution?: string;
  build: () => CanvasGraph;
};
/** A model an agent can run on: Elpis's work graph takes native providers only (bridge/client.mjs `runWorkflow`). */
export type CatalogModel = {
  provider: string | null;
  providerLabel: string;
  model: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
};
/** A typed command, AutoCAD-style. A prompt alone adds one agent with it; more lines (Shift+Enter) or `;` add one
 * agent per prompt. Before a colon come how many, the model (any words of its name, `@provider` to pick the provider)
 * and the thinking level: `3 sol high: fix the parser; fix the lexer`. `note: text` adds a sticky note. A first line
 * that isn't all count, model and thinking level is itself a prompt; after an explicit colon, words the command can't
 * place are listed, never guessed. `prompted` says the whole text was read as prompts. */
export type Command = {
  count: number | null;
  note: boolean;
  model: CatalogModel | null;
  effort: string | null;
  tasks: string[];
  unknown: string[];
  prompted: boolean;
};
/** What Elpis designs from a goal (POST /api/canvas/plan, bridge/canvas-plan.mts): the whole team, each agent keyed
 * (an existing agent keeps its id as its key) and wired by `waitsFor`. */
/** `mode` and `why`: the planner's own decision, one agent doing the whole goal ("direct") or a team, and its reason. */
export type Plan = {
  name: string;
  mode?: "direct" | "team";
  why?: string;
  agents: {
    key: string;
    title: string;
    prompt: string;
    folders: string[];
    doneWhen: string[];
    waitsFor: string[];
    model?: string;
    provider?: string;
    effort?: string;
  }[];
};
export type TextPart = {
  file: string;
  from: number;
  to: number;
};
/** A target language: its writing rules and the models that write it best. `worker` comes first (Farsi: the Gemini login
 * of the pilot Masih accepted); otherwise the OpenRouter model that writes the language best, among the ones offered
 * (28 Oct, Masih: "the agent would pick, if the user doesn't, the proper model from the OpenRouter"). */
export type Language = {
  id: string;
  name: string;
  rules?: string;
  worker?: RegExp[];
  best: RegExp[];
};
/** The ready-made workflows: whole teams for one job, built from a chosen folder, with no planner. `sources` picks the
 * files the job works on; a job that `reads` them gets their text; `worker` is its agents' model. */
export type ReadyMade = {
  id: string;
  name: string;
  description: string;
  what: string;
  workers: string; /** The workers' model, the first one the catalogue has (Translate: by the target language). */
  worker: RegExp[] | ((language: Language) => RegExp[]);
  workerName: string;
  reads: boolean;
  /** A folder that is plainly this job's: the open project is used at once, with no folder dialog. */
  here: (files: string[]) => boolean;
  sources: (files: string[]) => string[];
  goal: (where: string, language: Language) => string;
  team: (
    folder: string,
    sources: {
      name: string;
      text: string;
    }[],
    worker: Partial<AgentData>,
    language: Language,
    subject: string,
  ) => CanvasGraph;
  shape: () => CanvasGraph;
  /** The job is about what the request box says (a brand), or else the folder's name, not the folder's files: the brief and the team name it. */
  subject?: boolean;
  /** Said instead of building the team when the workers' model is missing: the job needs that model's tool. */
  noWorker?: string;
};
