/** Workflow agents answer the run in JSON (bridge/workflow-acp.mjs): a check's verdict, or Mother's decision. Chats show it
 * as a card and the run's progress as a sentence, never the JSON (27-28 Oct: "showing this way is wrong"). */
export type RunCard = { label: string; heading: string; failed: boolean; mother: boolean; text: string; summary: string };
const MOTHER: Record<string, string> = { continue: "Mother lets the agent continue", steer: "Mother steers the agent", retry: "Mother retries the agent", stop: "Mother stops the run" };
export function runCard(value: string): RunCard | null {
  if (!/^\s*(```(?:json)?\s*)?\{/.test(value)) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(value.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed), words = (key: string) => typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "";
  if (typeof parsed.passed === "boolean" && typeof parsed.summary === "string" && keys.length === 2)
    return { label: "Check result", heading: parsed.passed ? "Check passed" : "Check failed", failed: !parsed.passed, mother: false, text: words("summary"), summary: words("summary") };
  const action = words("action");
  if (MOTHER[action] && keys.every(key => ["action", "taskId", "message", "instruction", "summary", "reason"].includes(key) && typeof parsed[key] === "string")) {
    const guidance = words("message") || words("instruction");
    return { label: "Mother's decision", heading: MOTHER[action], failed: action === "stop", mother: true, summary: words("summary"),
      text: [words("summary"), guidance && `**Guidance:** ${guidance}`, words("reason") && `**Why:** ${words("reason")}`].filter(Boolean).join("\n\n") };
  }
  return null;
}
