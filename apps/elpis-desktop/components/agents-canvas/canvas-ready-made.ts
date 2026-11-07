import { useReactFlow } from "@xyflow/react";
import { api } from "@/lib/api";
import { modelCatalogSnapshot, refreshModelCatalog } from "@/lib/model-catalog";
import { WORKFLOWS, languageOf, type Language, type ReadyMade, type CanvasGraph, type CatalogModel, type TaskStatus } from "@/lib/canvas";
import { errorText } from "@/lib/error-text.mts";
import type * as React from "react";
import { Run, Props } from "./types";
import { over } from "./run-state";
import { FIT, MOTHER_FIRST } from "./constants";
import { useProjectFolders } from "./folders";

export function canvasReadyMade({ graph, project, cwd, run, setNotice, onUseFolder, requestText, models, catalog, checkpoint, setSelection, setRun, setStates, setGraph, flow }: {
  graph: CanvasGraph;
  project: ReturnType<typeof useProjectFolders>;
  cwd: Props["cwd"];
  run: Run | null;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  onUseFolder: Props["onUseFolder"];
  requestText: string;
  models: Props["models"];
  catalog: CatalogModel[];
  checkpoint: () => void;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  setRun: React.Dispatch<React.SetStateAction<Run | null>>;
  setStates: React.Dispatch<React.SetStateAction<Record<string, { status: TaskStatus; chat: string | null; activity?: string | undefined; }>>>;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  flow: ReturnType<typeof useReactFlow>
}) {
  // `forRun`: Run graph's own fill of what agents lack, made while that run is starting.
  /** A ready-made workflow (Transcribe images, Translate to Farsi) works on a folder named in the request (one of the
   * project's), or else the one chosen. A chosen folder becomes the project, so everything the team writes stays inside it. */
  const readyMade = (id?: string) => WORKFLOWS.find(workflow => workflow.id === id);
  const chosenWorkflow = readyMade(graph.planningPattern);
  async function buildReadyMade(workflow: ReadyMade, goal: string): Promise<CanvasGraph | null> {
    const named = [...(project.folders ?? [])].sort((a, b) => b.length - a.length).find(name => goal.includes(name));
    return named && cwd ? readyMadeAt(workflow, cwd, named, goal) : chooseFolderFor(workflow, goal);
  }
  // `goal`: what was typed with New workflow. Chosen from the menu, its button or the library, the goal is the job itself:
  // old request text never rides along (28 Oct: a leftover "Create elpis-check.txt" became every reader's goal).
  async function chooseFolderFor(workflow: ReadyMade, goal?: string, language = languageOf(graph.language)): Promise<CanvasGraph | null> {
    if (run && !over(run)) { setNotice("Wait for this run to finish before changing its pattern."); return null; }
    const choose = window.elpisDesktop?.chooseFolder;
    if (!choose) { setNotice(`Choose the folder of ${workflow.what} in the desktop app.`); return null; }
    let picked: string | null = null;
    try { picked = (await choose())?.replace(/\/+$/, "") || null; } catch (cause) { setNotice(errorText(cause)); return null; }
    if (!picked) return null;
    if (picked !== cwd?.replace(/\/+$/, "")) await onUseFolder?.(picked);
    return readyMadeAt(workflow, picked, ".", goal || workflow.goal(picked.split("/").at(-1) ?? picked, language), language);
  }
  /** Picked from the menu or the library: the open project, when it plainly holds the job's files, or else the folder chosen. */
  // A ready-made team writes in folders of its own, so it runs in the project itself: in git worktrees its files reached
  // the project only after a final review (28 Oct: Logo's three candidates stayed in the run's worktrees).
  async function pickReadyMade(workflow: ReadyMade, language = languageOf(graph.language)): Promise<CanvasGraph | null> {
    if (run && !over(run)) { setNotice("Wait for this run to finish before changing its pattern."); return null; }
    const base = cwd?.replace(/\/+$/, "");
    const files = base ? await listFolder(base, ".").catch(() => [] as string[]) : [];
    return base && workflow.here(files) ? readyMadeAt(workflow, base, ".", workflow.goal(base.split("/").at(-1) ?? base, language), language) : chooseFolderFor(workflow, undefined, language);
  }
  const listFolder = async (base: string, folder: string) => (await api<{ data: { name: string; dir: boolean }[] }>(`/files/dir?cwd=${encodeURIComponent(base)}&dir=${encodeURIComponent(folder)}&hidden=0`)).data.filter(entry => !entry.dir).map(entry => entry.name);
  async function readyMadeAt(workflow: ReadyMade, base: string, folder: string, goal: string, language = languageOf(graph.language)): Promise<CanvasGraph | null> {
    const at = (name: string) => folder === "." ? name : `${folder}/${name}`;
    let sources: { name: string; text: string }[] = [];
    try {
      const files = await listFolder(base, folder);
      sources = await Promise.all(workflow.sources(files).map(async name => {
        if (!workflow.reads) return { name, text: "" };
        const file = await api<{ content?: string; tooLarge?: boolean }>(`/file?cwd=${encodeURIComponent(base)}&path=${encodeURIComponent(at(name))}`);
        if (typeof file.content !== "string") throw new Error(file.tooLarge ? `${name} is too large to read here.` : `${name} is not text.`);
        return { name, text: file.content };
      }));
    } catch (cause) { setNotice(errorText(cause)); return null; }
    const where = folder === "." ? base.split("/").at(-1) ?? base : folder;
    if (!workflow.subject && !sources.some(source => !workflow.reads || source.text.trim())) { setNotice(`No ${workflow.what} in ${where}.`); return null; }
    // A job about a subject (Logo's brand): what the request box says, or else the folder's name; the brief names it.
    const subject = workflow.subject && requestText.trim() || where, brief = workflow.subject ? workflow.goal(subject, language) : goal;
    // The subscriptions (Antigravity's Gemini, Claude) are in the engine's own list; a run routes them by their prefix.
    // The live list as the run starts, so a model added since the board opened can be chosen.
    await refreshModelCatalog();
    const listed = modelCatalogSnapshot().models.length ? modelCatalogSnapshot().models : models;
    const offered = [...listed.map(item => ({ model: item.model, provider: null as string | null })), ...catalog];
    const pick = (test: RegExp) => offered.find(item => test.test(item.model));
    const byLanguage = typeof workflow.worker === "function", worker = (byLanguage ? (workflow.worker as (language: Language) => RegExp[])(language) : workflow.worker as RegExp[]).map(pick).find(Boolean), boss = MOTHER_FIRST.map(pick).find(Boolean);
    if (!worker && workflow.noWorker) { setNotice(workflow.noWorker); return null; }
    const team = workflow.team(folder, sources, worker ? { model: worker.model, provider: worker.provider } : {}, language, subject);
    const agents = team.nodes.filter(node => node.type === "agent").length;
    checkpoint(); setSelection([]); setRun(null); setStates({});
    setGraph(current => ({ ...team, request: workflow.subject ? subject : brief, maxAgents: Math.max(current.maxAgents ?? 10, agents), mother: { brief, model: boss?.model ?? null, provider: boss?.provider ?? null } }));
    // A model chosen by the language is named, so the person sees what writes it (28 Oct: "the agent ... says which").
    const named = worker && (catalog.find(item => item.model === worker.model && item.provider === worker.provider)?.label ?? listed.find(item => item.model === worker.model)?.displayName ?? worker.model);
    setNotice(!worker ? `${workflow.workerName} is not available here, so the ${workflow.workers} use the default model.`
      : byLanguage ? `The ${workflow.workers} use ${named}${worker.provider === "openrouter" ? " on OpenRouter" : ""}, the best writer of ${language.name} among your models.` : "");
    setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60);
    return team;
  }
  /** The document a ready-made workflow writes, opened in the system's own app for it. */
  const openResult = () => { if (cwd && graph.result) window.elpisDesktop?.openFile?.(`${cwd.replace(/\/+$/, "")}/${graph.result}`).catch((cause: unknown) => setNotice(errorText(cause))); };
  return { readyMade, buildReadyMade, pickReadyMade, chosenWorkflow, chooseFolderFor, openResult };
}