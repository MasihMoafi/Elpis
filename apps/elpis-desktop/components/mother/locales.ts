// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/locales.ts.
/**
 * Bilingual UI dictionaries (`[zh, en]`) and glossary groupings, following the domain terms in `docs/001-domain.md`.
 */
import { SHELL_TEXT } from "./locales-shell.ts";
import { TERM_TEXT } from "./locales-terms.ts";
import { WORK_TEXT } from "./locales-work.ts";

const TEXT = { ...SHELL_TEXT, ...WORK_TEXT, ...TERM_TEXT };
export type DshSuperagentKey = keyof typeof TEXT;
const language = (index: 0 | 1) =>
  Object.fromEntries(Object.entries(TEXT).map(([key, pair]) => [key, pair[index]])) as Record<DshSuperagentKey, string>;
export const zh = language(0),
  en = language(1);

/** Glossary terms grouped by stage flow after the acting roles; each key maps to `term.<key>` and `meaning.<key>`. */
export const GLOSSARY = {
  roles: ["agent", "mainSession", "executorSession"],
  source: ["source", "channel"],
  trigger: ["trigger", "thread", "correlation", "subscription", "fanout", "disposition"],
  eval: ["policy", "policyVersion", "eval", "gate", "assessment", "decision", "mandate", "scope", "strength"],
  execution: ["executor", "environment", "ticket", "assignment", "input", "report", "attention"],
} as const;
export const GLOSSARY_VALUES = {
  decision: ["decision.accept", "decision.reopen", "decision.stop", "decision.ignore", "decision.unavailable"],
  strength: ["strength.explicit", "strength.inferred"],
  ticket: [
    "stage.answer",
    "stage.review",
    "stage.blocked",
    "stage.failed",
    "stage.delivery",
    "stage.queued",
    "stage.working",
    "stage.idle",
    "ticket.ended",
  ],
  assignment: ["assignment.pending", "assignment.running", "assignment.ended"],
  report: ["report.progress", "report.waiting", "report.ready", "report.blocked", "report.failed", "report.dropped"],
} as const;
