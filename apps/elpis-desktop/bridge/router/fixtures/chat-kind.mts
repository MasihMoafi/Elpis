/** A configurable test-only chat Source for the reference's source-independent admission matrix. No transport runs. */
import { key, type Trigger, type ChannelRef } from "../core/index.mts";
import type { ChannelLink } from "../sources/kind.mts";
import { z } from "zod";
import { AllowedSchema } from "../policy.mts";
import type { SourceKind } from "../sources/kind.mts";
const schema = z.looseObject({
  chats: z.array(z.object({ chatId: z.string(), listen: z.enum(["mentions", "all"]) })).default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(["none", "mentions"]).default("none"),
});
export const testChatKind: SourceKind<z.infer<typeof schema>> = {
  kind: "feishu",
  title: { en: "Fixture chat", zh: "Fixture chat" },
  description: { en: "Policy fixture", zh: "Policy fixture" },
  schema,
  fields: [],
  health: ["feishu", "history"],
  scope({ meta }, config) {
    if (meta.direct === true)
      return config.directMessages
        ? { listened: true, observed: false, row: "direct" }
        : { listened: false, reason: "direct_messages_not_allowed" };
    const chat = config.chats.find(item => item.chatId === meta.chatId);
    if (chat) return { listened: true, observed: chat.listen === "all", row: chat.chatId };
    return config.otherChats === "mentions"
      ? { listened: true, observed: false, row: "other" }
      : { listened: false, reason: "chat_not_allowed" };
  },
  policy: {
    schema: z.looseObject({
      allowed: z.array(AllowedSchema).default([]),
      bots: z.array(AllowedSchema).optional(),
      syncChat: z.string().optional(),
    }),
    fields: [
      {
        key: "allowed",
        type: "rows",
        label: { en: "People", zh: "People" },
        columns: [
          { key: "id", type: "text", label: { en: "ID", zh: "ID" } },
          { key: "name", type: "text", optional: true, label: { en: "Name", zh: "Name" } },
        ],
      },
    ],
    unnamed: { person: { en: "Person", zh: "Person" }, bot: { en: "Bot", zh: "Bot" } },
    explicit: { en: "Direct or mentioned", zh: "Direct or mentioned" },
  },
};

// Adapted from DeepSeek dsh-superagent-prototype (MIT), Feishu reference identities used only as stored test data.
export const feishuTriggerId = (id: string) => key("feishu", id);
export const feishuChannel = (chatId: string, messageId: string): ChannelRef => ({
  source: "feishu",
  thread: `feishu:${chatId}`,
  address: { chatId, messageId },
});
export const feishuLink = (address: Record<string, string>, _links: object): ChannelLink => ({
  url: `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(address.chatId ?? "")}`,
  label: { zh: "飞书消息", en: "Feishu message" },
  ...(address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {}),
});

export function feishuTrigger(
  event: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    sender_id: string;
    sender_type: string;
    content: string;
    create_time: string;
    mentions?: { id: string }[];
  },
  bot: string,
  _app: string,
): Trigger | undefined {
  if (event.sender_id === bot) return undefined;
  const direct = event.chat_type === "p2p";
  return {
    id: feishuTriggerId(event.message_id),
    source: "feishu",
    threads: [{ source: "feishu", id: `${event.chat_id}:${event.message_id}` }],
    actor: { source: "feishu", id: event.sender_id },
    human: event.sender_type === "user",
    ...(direct
      ? { addressed: "direct" as const }
      : event.mentions?.some(item => item.id === bot)
        ? { addressed: "mention" as const }
        : {}),
    at: new Date(Number(event.create_time)).toISOString(),
    text: event.content,
    channel: feishuChannel(event.chat_id, event.message_id),
    meta: { chatId: event.chat_id, messageId: event.message_id, direct },
  };
}
