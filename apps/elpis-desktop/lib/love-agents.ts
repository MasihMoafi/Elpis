import { convertToExcalidrawElements, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import { boardPortraits, portraits } from "./love-characters";

import { characters, type Character } from "./agent-characters";
export { characters, type Character } from "./agent-characters";
/** A question the card's ACP agent asks before acting (session/request_permission), answered from the panel. */
export type LovePermission = { title: string; options: { optionId: string; name: string; kind: string }[] };
export type LoveInterview = { messages: { role: "assistant" | "user"; text: string }[]; proposal?: string; busy?: boolean; error?: string; approved?: boolean };
export type LoveAgent = { preset: string; name: string; prompt: string; task: string; model: string; provider: string; interview?: LoveInterview; status?: string; output?: string; error?: string; threadId?: string; sessionId?: string; permission?: LovePermission | null };
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
function portraitFile(character: Character): BinaryFileData {
  return { id: `love-portrait-v2-${character.id}` as FileId, mimeType: "image/png", dataURL: boardPortraits[character.id] as BinaryFileData["dataURL"], created: Date.now() };
}
/** Upgrade only the old preset-owned portrait; user drawings and custom image geometry stay intact. */
export function upgradeAgentArt(elements: readonly ExcalidrawElement[], files: BinaryFiles) {
  const byId = new Map(elements.map(e => [e.id, e])), replacements = new Map<string, ExcalidrawElement>();
  const added: BinaryFiles = {};
  for (const card of elements) {
    const agent = agentOf(card), character = agent && characters.find(c => c.id === agent.preset);
    if (!character) continue;
    const image = byId.get(`${card.id}-portrait`);
    if (!image || image.isDeleted || image.type !== "image" || image.fileId !== `love-portrait-${character.id}`) continue;
    const file = portraitFile(character); added[file.id] = file;
    replacements.set(image.id, newElementWith(image, { fileId: file.id, ...(image.width === 72 && image.height === 72 ? { x: image.x - 12, width: 96, height: 96 } : {}) }));
  }
  if (replacements.size) return { elements: elements.map(e => replacements.get(e.id) ?? e), files: { ...files, ...added } };
}
export function makeAgent(character: Character, x: number, y: number, task = "") {
  const id = crypto.randomUUID(), file = portraitFile(character), fileId = file.id;
  const data: LoveAgent = { preset: character.id, name: character.name, prompt: character.prompt, model: "gpt-6-luna", provider: "openai", task, ...(!task ? { interview: { messages: [] } } : {}) };
  const elements = convertToExcalidrawElements([
    { type: "rectangle", id, x, y, width: 220, height: 190, roughness: 0, roundness: { type: 3 }, backgroundColor: character.color, strokeColor: "#677478", strokeWidth: 1, fillStyle: "solid", groupIds: [id], customData: { loveAgent: data },
      label: { text: `\n\n\n${character.name}`, fontFamily: 2, fontSize: 20, strokeColor: "#243b43", verticalAlign: "bottom" } },
    { type: "image", id: `${id}-portrait`, x: x + 62, y: y + 16, width: 96, height: 96, fileId, status: "saved", groupIds: [id] },
  ], { regenerateIds: false });
  return { id, elements, file };
}
