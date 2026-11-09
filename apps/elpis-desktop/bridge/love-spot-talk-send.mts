import { agentColor } from "../lib/love-spot.ts";
import { PAINTING } from "./love-spot-talk-prompt.mts";
import { object, BridgeError, text } from "./validate.mts";
import type { Client, Scene } from "./love-spot-talk-types.mts";

export type SendBody = {
  text: string;
  model?: string | undefined;
  provider?: string | undefined;
  revision?: string;
  persona?: string;
  pinned?: boolean;
  drawingOnly?: boolean;
  pageSession?: string;
};

export function validateSendBody(body: SendBody) {
  object(body, ["text", "model", "provider", "revision", "persona", "pinned", "drawingOnly", "pageSession"]);
  text(body.text, "message");
  if (body.pinned !== undefined && typeof body.pinned !== "boolean")
    throw new BridgeError("pinned must be true or false");
  if (body.drawingOnly !== undefined && typeof body.drawingOnly !== "boolean")
    throw new BridgeError("drawingOnly must be true or false");
  if (body.pageSession !== undefined) text(body.pageSession, "page session", 200);
  if (body.persona !== undefined) text(body.persona, "persona", 4000);
  if (body.model !== undefined) text(body.model, "model", 200);
  if (body.provider !== undefined) text(body.provider, "provider", 200);
}

/** Reads every model page: an unknown model never gets an unverified image attachment. */
export async function findModel(client: Client, provider: string | undefined, model: string | undefined) {
  let cursor, selected;
  const cursors = new Set();
  do {
    const catalog = (await client.models({
      ...(provider ? { provider } : {}),
      ...(cursor ? { cursor } : {}),
    })) as { data: { model: string; inputModalities?: string[] }[]; nextCursor?: string | null };
    selected = catalog.data.find(item => item.model === model);
    cursor = catalog.nextCursor;
    if (cursor && cursors.has(cursor)) throw new BridgeError("Could not read the model list.", 502);
    cursors.add(cursor);
  } while (!selected && cursor);
  return selected;
}

export type Attachment = {
  id: string;
  name: string;
  type: string;
  mimeType: string;
  text?: string;
  dataUrl?: string;
};

const textFile = (id: string, name: string, content: string): Attachment => ({
  id,
  name,
  type: "text",
  mimeType: "text/plain",
  text: content,
});

/** The text files that go with each message to her: the board's notes, any app action, her persona and how to paint. */
export function messageAttachments(scene: Scene, unchanged: boolean, action: unknown, persona: string | undefined) {
  const notes = scene.elements
    .filter(e => e.type === "text" && !e.isDeleted)
    .map(e => ({ author: agentColor(e.strokeColor, e.id) ? "agent" : "Masih", text: e.originalText || e.text || "" }));
  const seen = unchanged ? "\nThe drawing is as it was in the last picture you saw." : "";
  const attachments = [
    textFile("love-spot-notes", "Love Spot notes.txt", `Current Love Spot board notes (by colour):\n${JSON.stringify(notes)}${seen}`),
  ];
  if (action)
    attachments.push(
      textFile(
        "matilda-action",
        "Matilda action result.txt",
        `The app executed this direct request. Report the actual result briefly; do not execute it again. ${JSON.stringify(action)}`,
      ),
    );
  if (persona) attachments.push(textFile("love-spot-persona", "Who you are.txt", persona));
  attachments.push(textFile("love-spot-painting", "How to paint.txt", PAINTING));
  return attachments;
}
