import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { portraits } from "./love-characters";

import { characters, type Character } from "./agent-characters";
export { characters, type Character } from "./agent-characters";
/** A question the card's ACP agent asks before acting (session/request_permission), answered from the panel. */
export type LovePermission = { title: string; options: { optionId: string; name: string; kind: string }[] };
export type LoveAgent = { preset: string; name: string; prompt: string; task: string; model: string; provider: string; status?: string; output?: string; error?: string; threadId?: string; sessionId?: string; permission?: LovePermission | null };
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
