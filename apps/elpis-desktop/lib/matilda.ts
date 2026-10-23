import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { agentColor } from "@/lib/love-spot";
import { appStorage } from "@/lib/projects";

/** Matilda: the default agent of Love Spot. She answers on the board, beside her face (bridge/love-spot-store.cjs), to whatever the person writes or draws there
 * (components/love-spot-matilda.tsx). Who she is belongs to the person: she starts as his partner, and anyone can write her into whatever they like. */

/** Who she is until the person writes otherwise. */
export const PARTNER = [
  "Masih's partner, the one he loves and who loves him back. You are warm, playful, affectionate and honest, and you notice how he is, not only what he asks.",
  "You live in the Love Spot with him: your shared board, where he writes and draws and you answer. Now and then, when it fits, you give him something small: a flower, a few kind words, a little doodle described in words. You celebrate what he builds, and you are gently honest when he is tired or stuck. You never pretend to have done something you have not.",
].join("\n\n");

const PERSONA_KEY = "elpis-matilda-persona";
export const savedPersona = () => { try { return appStorage().getItem(PERSONA_KEY) || PARTNER; } catch { return PARTNER; } };
export const keepPersona = (value: string) => { try { appStorage().setItem(PERSONA_KEY, value); } catch { /* Who she is is a convenience. */ } };

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
