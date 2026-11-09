import { splitPainting } from "./love-spot-painting.cts";
import type { Client, Entry, Item, Scene } from "./love-spot-talk-types.mts";

/** The paintings in a chat's replies, one per turn. */
function paintingsIn(recorded: Entry[]) {
  const replies = new Map<string, string>();
  for (const e of recorded)
    if (e.item.type === "agentMessage" && (!e.item.phase || e.item.phase === "final_answer"))
      replies.set(e.turnId, [replies.get(e.turnId), e.item.text].filter(Boolean).join("\n\n"));
  return [...replies]
    .filter(([, text]) => text.includes("```excalidraw"))
    .map(([turnId, text]) => ({ turnId, shapes: splitPainting(text).shapes }));
}

/** How many shapes each painting on the board should have, for those with a wire that may need repair. */
function paintingSizes(scene: Scene) {
  const needed = new Map<string, number>();
  for (const e of scene.elements) {
    const match = e.id.match(/^love-paint-(.+)-(\d+)$/);
    if (!match || e.isDeleted || !["arrow", "line"].includes(e.type)) continue;
    const group = `love-paint-${match[1]}`;
    needed.set(
      match[1]!,
      Math.max(...scene.elements.filter(a => a.groupIds?.includes(group)).map(a => Number(a.id.match(/-(\d+)$/)?.[1] ?? 0))) + 1,
    );
  }
  return needed;
}

/** The paintings the board needs to repair itself, reading further back through the chat only as far as needed. */
export async function paintingsToRepair(
  client: Client,
  threadId: string,
  scene: Scene,
  first: { entries: Entry[]; nextCursor?: string | null | undefined },
) {
  const needed = paintingSizes(scene);
  let recorded = [...first.entries],
    drawings = paintingsIn(recorded),
    cursor = first.nextCursor,
    pages = 0;
  const seen = new Set();
  while (
    cursor &&
    pages++ < 20 &&
    [...needed].some(([id, count]) => !drawings.some(p => p.turnId === id && p.shapes.length >= count))
  ) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const older = await client.readThread(threadId, { limit: 100, cursor });
    recorded = ([...older.data].reverse() as Entry[]).concat(recorded);
    cursor = older.nextCursor;
    drawings = paintingsIn(recorded);
  }
  return drawings;
}

/** Her final answer only: with phases, the final_answer items; without them (Claude, Gemini), her last message, so words she wrote before a tool call stay off the board. */
export function finalAnswers(messages: Item[]) {
  return messages.some(item => item.phase === "final_answer")
    ? messages.filter(item => item.phase === "final_answer")
    : messages.filter(item => !item.phase).slice(-1);
}
