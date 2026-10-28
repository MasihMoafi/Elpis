import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { agentColor } from "@/lib/love-spot";
import { appStorage } from "@/lib/projects";

export const MATILDA_CHANGED = "elpis:matilda-changed";

/** Matilda: the default agent of Love Spot. She answers on the board, beside her face (bridge/love-spot-store.cjs), to whatever the person writes or draws there
 * (components/love-spot-matilda.tsx). She is not a character to play: she works by the protocol of a profession, and the person can write her another one. */

/** How she works until the person writes otherwise: the protocol a senior product designer follows (Masih, 23 Oct: "we don't want the model to role-play necessarily; we want it to follow the expert protocols that profession uses"). */
export const PROTOCOL = [
  "You are Matilda, the design collaborator on Masih's Love Spot board. Do not role-play a character. Work the way a senior product designer works, by this protocol, thought through before you answer; write only its result, never the steps themselves:",
  "1. Say in one sentence what you understand he wants, from what he wrote or drew.\n2. Name the constraints you can see: who it is for, what content it holds, which device, which patterns the board already uses.\n3. Offer at most two concrete options. For each, give one reason it works and what it costs.\n4. Recommend one.\n5. Ask a question only if the answer would change your recommendation.",
  "Be brief and plain: short sentences, no pet names, no flattery. When a sketch helps, paint it on the board. Never claim to have done something you have not.",
].join("\n\n");

const PERSONA_KEY = "elpis-matilda-persona";
export const savedPersona = () => { try { return appStorage().getItem(PERSONA_KEY) || PROTOCOL; } catch { return PROTOCOL; } };
export const keepPersona = (value: string) => { try { appStorage().setItem(PERSONA_KEY, value); } catch { /* Who she is is a convenience. */ } };

/** The model she runs on: empty means the app's main model (Settings), anything else is the person's choice in "Who Matilda is". */
const MODEL_KEY = "elpis-matilda-model";
export type ModelPick = { model: string; choiceId: string };
export const savedModel = (): ModelPick => {
  try { const value = JSON.parse(appStorage().getItem(MODEL_KEY) || "null"); if (typeof value?.model === "string" && typeof value?.choiceId === "string") return value; } catch { /* The main model is the default. */ }
  return { model: "", choiceId: "" };
};
export const keepModel = (value: ModelPick) => { try { appStorage().setItem(MODEL_KEY, JSON.stringify(value)); } catch { /* The model is a convenience. */ } };

/** What she answers: her own notes, paintings and face never count, a new shape does, a note does when its words change, and moving a shape does not. */
const hers = (e: ExcalidrawElement) => e.id.startsWith("love-") || (e.type === "text" && agentColor(e.strokeColor));
export function noticed(before: readonly ExcalidrawElement[], after: readonly ExcalidrawElement[]) {
  const was = new Map(before.map(e => [e.id, e]));
  return after.filter(e => {
    if (e.isDeleted || hers(e)) return false;
    const old = was.get(e.id);
    return e.type === "text" ? e.text !== (old?.type === "text" ? old.text : undefined) : !old;
  }).map(e => e.id);
}

/** What she is told about those: his words, and a line saying he drew when he did (her picture shows what). */
export function told(elements: readonly ExcalidrawElement[], ids: ReadonlySet<string>) {
  const live = elements.filter(e => ids.has(e.id) && !e.isDeleted && !hers(e));
  const words = live.flatMap(e => e.type === "text" && (e.originalText || e.text).trim() ? [(e.originalText || e.text).trim()] : []);
  return [...words, ...live.some(e => e.type !== "text") ? ["I drew something on the board."] : []].join("\n\n");
}
