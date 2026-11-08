import { WORKFLOWS } from "@/lib/canvas";

/** What Elpis is asked when the user ran a team without writing a goal: keep what is drawn and set, and fill the rest. */
export const DRAWN =
  "Run this team as drawn: keep every agent, its wiring and whatever is already set; give each agent the prompt and folders it lacks, from its name and its place in the team.";

/** Fit the graph inside the available board, on opening and after layout changes. */
export const FIT = { padding: 0.06, maxZoom: 1, minZoom: 0.05 };

/** A run's time limit unless the Mother agent's settings change it. */
export const RUN_MINUTES = 60;

export const OVERVIEW = { padding: 0.08, maxZoom: 1 };

// React Flow lifts a selected agent to z-index 1000; a selected wire goes just above it.
export const ABOVE_AGENTS = 1001;

// The ready-made workflow comes first (28 Oct, Masih: "move it on top").
export const ENTRY_PATTERNS = [
  ...WORKFLOWS.map(workflow => ({ id: workflow.id, label: workflow.name })),
  { id: "auto", label: "Auto · Elpis chooses" },
  { id: "split-parts", label: "Parallel" },
  { id: "sequential", label: "Sequential" },
  { id: "research", label: "Research" },
];

// Mother takes the strongest model this person has (28 Oct, Masih: "Depends on which model the user has available; for me, opus").
export const MOTHER_FIRST = [
  /^claude\/opus$/,
  /^agy\/gemini-4-argon-high$/,
  /^gpt-6\.1-sol$/,
  /^claude\/sonnet$/,
  /opus/i,
  /gemini-4-argon/i,
  /sonnet/i,
];
