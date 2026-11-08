export { readGraph, initialGraph, saveGraph } from "./canvas-storage.ts";

export { TEMPLATES, PATTERNS, PATTERN_TEAMS } from "./canvas-templates.ts";
import {
  PAGE_IMAGE,
  transcriptionTeam,
  ENGLISH_TEXT,
  textParts,
  translationTeam,
} from "./canvas-document-workflows.ts";
export {
  PAGE_IMAGE,
  transcriptionTeam,
  ENGLISH_TEXT,
  textParts,
  LANGUAGES,
  languageOf,
  translationTeam,
} from "./canvas-document-workflows.ts";
export { EFFORTS, commandParts, parseCommand } from "./canvas-commands.ts";

export {
  agentCount,
  STATUS_LABEL,
  CHECK_LABEL,
  MOTHER,
  MAX_AGENTS,
  maxAgents,
  FATHER,
  PER_PARENT,
  parents,
  TASKS_PER_AGENT,
  checkOf,
  DONE,
  WHOLE_PROJECT,
  ownFolders,
  newId,
  agent,
  AGENT_NAMES,
  agentName,
  graphOf,
  chain,
  waves,
  shapeOf,
  COLUMN,
  ROW,
  withMother,
  arrange,
  nameFrom,
  promptName,
  newAgents,
  makesLoop,
  runParts,
  runTasks,
  linkedIds,
  executionGraph,
  boardForPlan,
  applyPlan,
  applyPattern,
  agentColor,
} from "./canvas-graph.ts";
import type { ReadyMade } from "./canvas-types.ts";
export type {
  AgentData,
  NoteData,
  CanvasNode,
  CanvasEdge,
  MotherSettings,
  CanvasGraph,
  TaskStatus,
  RunTask,
  CatalogModel,
  Command,
  Plan,
  TextPart,
  Language,
  ReadyMade,
} from "./canvas-types.ts";

import { waits } from "./canvas-delete-flow";

import { logoTeam } from "./logo-team";
export { waits };
export const WORKFLOWS: ReadyMade[] = [
  {
    id: "transcribe",
    name: "Transcribe images",
    description:
      "Choose a folder of page images: Gemini 3.8 Flash readers read a page each by vision, side by side, and Elpis joins them into transcription.md in that folder.",
    what: "page images (PNG, JPG or WebP)",
    workers: "readers",
    worker: [/gemini-3\.8-flash-low/i, /gemini-3\.8-flash-medium/i, /gemini-3\.8-flash-high/i],
    workerName: "Gemini 3.8 Flash",
    reads: false,
    here: files => files.some(name => PAGE_IMAGE.test(name)),
    sources: files => files.filter(name => PAGE_IMAGE.test(name)),
    goal: where => `Transcribe the page images in ${where} into transcription.md`,
    team: (folder, sources, worker) =>
      transcriptionTeam(
        folder,
        sources.map(source => source.name),
        worker,
      ),
    shape: () =>
      transcriptionTeam(
        "pages",
        Array.from({ length: 12 }, (_, index) => `${index + 1}.png`),
      ),
  },
  {
    id: "translate",
    name: "Translate",
    description:
      "Choose a folder of English text, such as a transcription.md, and a language: one agent writes a glossary of names and terms, translators take about 1,500 words each on the model that writes that language best, and Elpis joins them into translation.md.",
    what: "English text (Markdown or plain text)",
    workers: "translators",
    worker: language => [...(language.worker ?? []), ...language.best],
    workerName: "A model for that language",
    reads: true,
    here: files => files.includes("transcription.md"),
    sources: files => {
      const text = files
        .filter(name => ENGLISH_TEXT.test(name) && name !== "translation.md")
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return text.includes("transcription.md") ? ["transcription.md"] : text;
    },
    goal: (where, language) => `Translate the English in ${where} into ${language.name} in translation.md`,
    team: (folder, sources, worker, language) => translationTeam(folder, textParts(sources), worker, language),
    shape: () =>
      translationTeam(
        "book",
        [1, 2, 3].map(index => ({ file: "transcription.md", from: index * 10 - 9, to: index * 10 - 1 })),
      ),
  },
  // The Designer needs the image generation tool, which agents on the ChatGPT route have (the engine's own models, `gpt-…`).
  {
    id: "logo",
    name: "Logo",
    description:
      "Name the brand in the request box (or else the project is the brand): one agent draws three directions with the image generation tool and traces each into SVG through SVG Studio; you pick.",
    what: "the brand's project",
    workers: "logo agents",
    worker: [/^gpt-6\.1-sol$/, /^gpt-/],
    workerName: "Sol in Fast mode",
    reads: false,
    subject: true,
    noWorker: "Logo needs a ChatGPT model, whose agents have the image generation tool, and none is available here.",
    here: () => true,
    sources: () => [],
    goal: brand => `Make the logo of ${brand}: three directions, each traced into SVG, for you to pick`,
    team: (folder, _sources, worker, _language, brand) => logoTeam(folder, brand, worker),
    shape: () => logoTeam("brand", "Brand"),
  },
];
