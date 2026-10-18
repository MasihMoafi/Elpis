import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

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
  const i = characters.indexOf(character);
  const head = i % 2 ? '<rect x="18" y="17" width="60" height="62" rx="23" fill="#fff9ef"/>' : '<circle cx="48" cy="48" r="31" fill="#fff9ef"/>';
  const accessory = [
    '<circle cx="35" cy="44" r="10" fill="none" stroke="#243b43" stroke-width="3"/><circle cx="61" cy="44" r="10" fill="none" stroke="#243b43" stroke-width="3"/><path d="M45 44h6" stroke="#243b43" stroke-width="3"/>',
    '<path d="M27 32l13-5m16 0l13 5" stroke="#243b43" stroke-width="4" stroke-linecap="round"/>',
    '<path d="M16 30h64M23 29a25 23 0 0150 0" stroke="#a15b21" stroke-width="8" fill="none"/>',
    '<path d="M21 44V30a27 23 0 0154 0v14" fill="none" stroke="#456879" stroke-width="6"/><rect x="16" y="40" width="10" height="20" rx="5" fill="#456879"/><rect x="70" y="40" width="10" height="20" rx="5" fill="#456879"/>',
    '<path d="M22 25Q45 0 75 25Z" fill="#915772"/><path d="M24 26h49" stroke="#915772" stroke-width="5"/>',
    '<path d="M27 31l15 5m12 0l15-5" stroke="#243b43" stroke-width="4" stroke-linecap="round"/>',
  ][i];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="28" fill="${character.color}"/>${head}<circle cx="35" cy="44" r="3" fill="#243b43"/><circle cx="61" cy="44" r="3" fill="#243b43"/><path d="M37 62q11 ${i === 5 ? -7 : 10} 22 0" fill="none" stroke="#243b43" stroke-width="3" stroke-linecap="round"/>${accessory}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
export function makeAgent(character: Character, x: number, y: number, task = "") {
  const id = crypto.randomUUID(), fileId = `love-avatar-${character.id}` as FileId;
  const data: LoveAgent = { preset: character.id, name: character.name, prompt: character.prompt, model: "gpt-6-luna", provider: "openai", task };
  const elements = convertToExcalidrawElements([
    { type: "rectangle", id, x, y, width: 220, height: 170, roughness: 0, roundness: { type: 3 }, backgroundColor: character.color, strokeColor: "#677478", strokeWidth: 1, fillStyle: "solid", groupIds: [id], customData: { loveAgent: data },
      label: { text: `\n\n\n${character.name}`, fontFamily: 2, fontSize: 20, strokeColor: "#243b43", verticalAlign: "bottom" } },
    { type: "image", id: `${id}-portrait`, x: x + 74, y: y + 16, width: 72, height: 72, fileId, status: "saved", groupIds: [id] },
  ], { regenerateIds: false });
  const file: BinaryFileData = { id: fileId, mimeType: "image/svg+xml", dataURL: avatar(character) as BinaryFileData["dataURL"], created: Date.now() };
  return { id, elements, file };
}
