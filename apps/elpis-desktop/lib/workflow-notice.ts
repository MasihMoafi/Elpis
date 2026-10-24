import type { Item } from "@/lib/api";

/** The end notice a workflow run sends the chat that started it (noticeText in tools/elpis-claude/workflow-runner.mjs).
 * It reaches the chat's model as a message, but the person did not write it: it shows as a step, as Claude Code shows
 * a finished task, and is not one of their prompts. */
export type WorkflowNotice = { runId: string; name: string; status: string; summary: string; result: string | null };

const TAG = "<workflow-notification>";
const field = (text: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? "";

export function workflowNotice(text: string): WorkflowNotice | null {
  if (!text.trimStart().startsWith(TAG)) return null;
  const open = text.indexOf("<result>\n"), close = text.lastIndexOf("\n</result>");
  return {
    runId: field(text, "run-id"), name: field(text, "name") || "workflow", status: field(text, "status"), summary: field(text, "summary"),
    result: open >= 0 && close > open ? text.slice(open + "<result>\n".length, close) : null,
  };
}

export function noticeOf(item: Item): WorkflowNotice | null {
  if (item.type !== "userMessage") return null;
  const parts = item.content ?? [];
  return parts.length === 1 && parts[0].type === "text" ? workflowNotice(parts[0].text ?? "") : null;
}
