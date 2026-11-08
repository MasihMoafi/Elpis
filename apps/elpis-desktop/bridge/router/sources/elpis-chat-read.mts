// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/sources/feishu-read.ts and feishu-image.ts.
import { attachmentInput } from "../../attachments.mts";
import type { Trigger } from "../core/index.mts";
import type { ContextPartName, ThreadContext } from "./kind.mts";
import type { ElpisChatConfig, ElpisChatMessage, ElpisChatTransport } from "./elpis-chat.mts";
const metaId = (trigger: Trigger, name: "threadId" | "messageId"): string =>
  typeof trigger.meta[name] === "string" ? trigger.meta[name] : "";
const normalized = (message: ElpisChatMessage) => ({
  id: message.id,
  from: message.actorId,
  at: message.at,
  text: message.text,
  ...(message.role === "assistant" ? { bot: true as const } : {}),
  ...(message.replyTo ? { reply_to: message.replyTo } : {}),
});
async function page(
  transport: ElpisChatTransport,
  trigger: Trigger,
  part: ContextPartName,
  cursor?: string,
  signal?: AbortSignal,
) {
  const threadId = metaId(trigger, "threadId"),
    messages = await transport.read(threadId, undefined, signal);
  const messageId = metaId(trigger, "messageId");
  if (part === "root" || part === "parent") {
    const id = part === "root" ? messages[0]?.id : messages.find(message => message.id === messageId)?.replyTo;
    return {
      messages: messages.filter(message => message.id === id).map(normalized),
      body: { message_id: id ?? null },
    };
  }
  const at = cursor ? messages.findIndex(message => message.id === cursor) + 1 : 0;
  if (cursor && at === 0) throw new Error("Chat context cursor no longer exists; read the first page again");
  const items = messages.slice(at, at + 50).map(normalized),
    next = at + 50 < messages.length ? items.at(-1)?.id : undefined;
  return { messages: items, ...(next ? { next } : {}), body: { messages: items } };
}
export function chatContext(transport: ElpisChatTransport): ThreadContext<ElpisChatConfig> {
  return {
    messageId: trigger => metaId(trigger, "messageId"),
    read: (_commands, trigger, part, cursor) => page(transport, trigger, part, cursor),
    images: text => [...text.matchAll(/\[image:([^\]]+)\]/g)].map(match => match[1]!),
    image: (_agent, _commands, trigger, message, key, _stateDir, signal) =>
      readImage(transport, trigger, message.id, key, signal),
  };
}
async function readImage(
  transport: ElpisChatTransport,
  trigger: Trigger,
  messageId: string,
  key: string,
  signal?: AbortSignal,
) {
  const messages = await transport.read(metaId(trigger, "threadId"), undefined, signal);
  const image = messages.find(item => item.id === messageId)?.images?.find(item => item.id === key);
  const mimeType = image && /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(image.url)?.[1];
  if (!image || !mimeType) throw new Error("This image is unavailable");
  attachmentInput("", [{ id: "image", name: "Chat image", type: "image", mimeType, dataUrl: image.url }]);
  return { image_url: image.url };
}
export async function chatRead(
  transport: ElpisChatTransport,
  trigger: Trigger,
  resource: string,
  signal?: AbortSignal,
) {
  const section = resource.split("/")[2] ?? "message";
  if (section === "image") {
    const parts = resource.split("/");
    if (parts.length !== 4 || !parts[3]) throw new Error("An image reference is required");
    return readImage(transport, trigger, metaId(trigger, "messageId"), parts[3], signal);
  }
  if (section === "thread" || section === "root" || section === "parent")
    return page(transport, trigger, section, undefined, signal);
  if (section !== "message") throw new Error("Unknown Elpis chat resource");
  const messages = await transport.read(metaId(trigger, "threadId"), undefined, signal);
  const message = messages.find(item => item.id === trigger.meta.messageId);
  if (!message) throw new Error("The source message is unavailable");
  return {
    ...normalized(message),
    ...(message.images
      ? { images: message.images.map(image => ({ id: image.id, read: `elpis-chat/${trigger.id}/image/${image.id}` })) }
      : {}),
  };
}
