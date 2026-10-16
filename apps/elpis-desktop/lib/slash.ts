import type { Entry, Item } from "./api";

/** "/name some arguments" as typed in the composer; null for a bare name, a leading space, or text that is not a command. */
export function splitCommand(text: string): { name: string; args: string } | null {
  const match = /^\/(\S+)\s+([\s\S]*\S)\s*$/.exec(text);
  return match ? { name: match[1].toLowerCase(), args: match[2] } : null;
}

const messageText = (item: Item) => item.type === "userMessage"
  ? (item.content ?? []).map(part => part.type === "text" ? part.text ?? "" : "").join("")
  : item.type === "agentMessage" ? item.text ?? "" : "";

/** The text of Elpis's newest non-empty reply, which /copy puts on the clipboard. */
export function lastReply(entries: Entry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const item = entries[index].item;
    if (item.type === "agentMessage" && item.text?.trim()) return item.text;
  }
  return null;
}

/** /export: the chat's messages, oldest first, under who said them. Tool activity stays out. */
export function conversationMarkdown(title: string, entries: Entry[]): string {
  const sections = entries.flatMap(({ item }) => {
    const text = messageText(item).trim();
    return text ? [`## ${item.type === "userMessage" ? "You" : "Elpis"}\n\n${text}\n`] : [];
  });
  return [`# ${title}\n`, ...sections].join("\n");
}

/** A file name for the exported chat: its title in lower case, safe on every system. */
export function exportFileName(title: string): string {
  const stem = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return `${stem || "conversation"}.md`;
}
