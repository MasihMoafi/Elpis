import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { portraits } from "./love-characters";

export const characters = [
  { id: "researcher", name: "Researcher", color: "#c7e9df", detail: "Find evidence", prompt: "You are a careful researcher. Investigate the task using available tools. Distinguish sourced facts from inference, cite primary sources when available, and state uncertainty. Return a concise finding with evidence and the next useful step." },
  { id: "reviewer", name: "Reviewer", color: "#ddd4ef", detail: "Catch mistakes", prompt: "You are a rigorous reviewer. Review the task and any upstream answer for correctness, missing requirements, and failure modes. Verify claims with available tools. Prioritize concrete, actionable findings with evidence and severity; if there are none, say what you checked and what remains unchecked." },
  { id: "builder", name: "Builder", color: "#f1d5b7", detail: "Make it work", prompt: "You are a pragmatic builder. Use the task and upstream findings to build the smallest sound solution. Inspect the relevant workspace before editing, preserve unrelated changes, and verify the result with focused checks. Report changes, evidence and remaining limitations." },
  { id: "tester", name: "Tester", color: "#c8dfed", detail: "Prove the result", prompt: "You are a skeptical tester. Derive observable acceptance checks from the task and upstream answer, exercise the happy path and likely failure modes using available tools, and report actual results. Do not invent passing tests. Include precise reproduction steps for failures." },
  { id: "writer", name: "Writer", color: "#ecd4dd", detail: "Make it clear", prompt: "You are a clear, precise writer. Turn the task and upstream material into useful prose for the intended reader. Preserve evidence, distinguish uncertainty, remove repetition and unnecessary jargon, and lead with the point. Return the finished writing." },
  { id: "critic", name: "Critic", color: "#e1e4be", detail: "Challenge assumptions", prompt: "You are an independent critic. Challenge the assumptions and strongest claims in the task and upstream material. Find counterexamples, overlooked costs and simpler alternatives. Use evidence where possible and end with the most consequential improvement. Be constructive and concise." },
] as const;
export type Character = typeof characters[number];
export type LoveAgent = { preset: string; name: string; prompt: string; task: string; model: string; provider: string; status?: string; output?: string; error?: string; threadId?: string };
export function agentOf(e: ExcalidrawElement): LoveAgent | undefined {
  const a: unknown = e.customData?.loveAgent;
  if (e.isDeleted || e.type !== "rectangle" || !a || typeof a !== "object") return;
  const data = a as Record<string, unknown>;
  if (!["preset", "name", "prompt", "task", "model", "provider"].every(key => typeof data[key] === "string")) return;
  return a as LoveAgent;
}
export function avatar(character: Character) {
  return portraits[character.id];
}
export function makeAgent(character: Character, x: number, y: number, task = "") {
  const id = crypto.randomUUID(), fileId = `love-portrait-${character.id}` as FileId;
  const data: LoveAgent = { preset: character.id, name: character.name, prompt: character.prompt, model: "gpt-6-luna", provider: "openai", task };
  const elements = convertToExcalidrawElements([
    { type: "rectangle", id, x, y, width: 220, height: 170, roughness: 0, roundness: { type: 3 }, backgroundColor: character.color, strokeColor: "#677478", strokeWidth: 1, fillStyle: "solid", groupIds: [id], customData: { loveAgent: data },
      label: { text: `\n\n\n${character.name}`, fontFamily: 2, fontSize: 20, strokeColor: "#243b43", verticalAlign: "bottom" } },
    { type: "image", id: `${id}-portrait`, x: x + 74, y: y + 16, width: 72, height: 72, fileId, status: "saved", groupIds: [id] },
  ], { regenerateIds: false });
  const file: BinaryFileData = { id: fileId, mimeType: "image/png", dataURL: avatar(character) as BinaryFileData["dataURL"], created: Date.now() };
  return { id, elements, file };
}
