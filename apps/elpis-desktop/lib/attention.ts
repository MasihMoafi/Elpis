import { appStorage } from "./projects";

const KEY = "elpis-chat-attention-v1";

/** Which chats need you, kept on this computer: replies nobody has opened (`unread`) and plans that finished in Plan
 * mode and wait for review (`plans`: chat → the plan's turn). The sidebar draws them (app/page.tsx). */
export type Attention = { unread: string[]; plans: Record<string, string> };

export function readAttention(): Attention {
  try {
    const value = JSON.parse(appStorage().getItem(KEY) || "{}");
    const unread = Array.isArray(value.unread) ? value.unread.filter((id: unknown): id is string => typeof id === "string") : [];
    const plans = value.plans && typeof value.plans === "object" && !Array.isArray(value.plans)
      ? Object.fromEntries(Object.entries(value.plans).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
    return { unread, plans };
  } catch {
    return { unread: [], plans: {} };
  }
}

export function saveAttention(value: Attention) {
  appStorage().setItem(KEY, JSON.stringify(value));
}
