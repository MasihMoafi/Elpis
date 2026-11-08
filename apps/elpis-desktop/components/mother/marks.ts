// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/marks.ts.
/** Pure mappers from domain states (Tickets, Threads, Sources, Decisions) to UI status indicators. */
import type { DecisionRow, SourceStatusRow, ThreadRow, TicketStage, TicketSummary } from "./api.ts";
import type { DshSuperagentKey } from "./locales.ts";
import { valueLabel, type T } from "./text.ts";
import type { DotState, IconName, TagTone } from "./controls.tsx";

export interface Mark {
  label: string;
  tone: TagTone;
  dot: DotState;
  icon: IconName;
}

export function ticketMark(t: T, ticket: TicketStage & Pick<TicketSummary, "ended">): Mark {
  switch (ticket.stage) {
    case "ended":
      return { label: valueLabel(t, "outcome", ticket.ended?.outcome), tone: "neutral", dot: "idle", icon: "stop" };
    case "person": {
      const action = ticket.action;
      const icon: IconName =
        action === "review"
          ? "review"
          : action === "failed"
            ? "alert"
            : action === "blocked"
              ? "blocked"
              : action === "delivery"
                ? "inbox"
                : "ask";
      return {
        label: t(`stage.${action}`),
        tone: action === "failed" ? "danger" : "warning",
        dot: action === "failed" ? "error" : "warning",
        icon,
      };
    }
    case "working":
      return ticket.action === "queued"
        ? { label: t("stage.queued"), tone: "neutral", dot: "idle", icon: "queue" }
        : { label: t("stage.working"), tone: "info", dot: "ongoing", icon: "running" };
    default:
      return { label: t("stage.idle"), tone: "neutral", dot: "idle", icon: "clock" };
  }
}
export const reportDot = (report: string | undefined): DotState =>
  report === "failed"
    ? "error"
    : report === "blocked" || report === "waiting"
      ? "warning"
      : report === "ready"
        ? "done"
        : "ongoing";

const THREAD_MARKS: Record<ThreadRow["stage"], Omit<Mark, "label" | "tone"> & { label: DshSuperagentKey }> = {
  error: { dot: "error", icon: "alert", label: "threadPollFailed" },
  evaluating: { dot: "ongoing", icon: "running", label: "threadEvaluating" },
  queued: { dot: "warning", icon: "queue", label: "threadQueued" },
  subscribed: { dot: "done", icon: "inbox", label: "threadSubscribed" },
  dormant: { dot: "idle", icon: "clock", label: "threadDormantShort" },
  unsubscribed: { dot: "idle", icon: "hash", label: "threadUnsubscribed" },
};
export function threadMark(t: T, thread: Pick<ThreadRow, "stage" | "pending">): Omit<Mark, "tone"> {
  const { dot, icon, label } = THREAD_MARKS[thread.stage];
  return { dot, icon, label: t(label, { count: thread.pending }) };
}

const SOURCE_MARKS: Record<SourceStatusRow["state"], { dot: DotState; label: DshSuperagentKey }> = {
  missing: { dot: "idle", label: "sourceNotInstalled" },
  off: { dot: "idle", label: "sourceOff" },
  error: { dot: "error", label: "sourceState.error" },
  setup: { dot: "idle", label: "sourceState.setup" },
  starting: { dot: "ongoing", label: "sourceState.ongoing" },
  paused: { dot: "warning", label: "sourceState.warning" },
  ready: { dot: "done", label: "sourceState.done" },
};
export const sourceMark = (t: T, state: SourceStatusRow["state"]) => ({
  dot: SOURCE_MARKS[state].dot,
  label: t(SOURCE_MARKS[state].label),
});

type Outcome = DecisionRow["outcome"];
const DECISION_MARKS: Record<Outcome, Omit<Mark, "label">> = {
  accept: { dot: "done", icon: "decision", tone: "success" },
  reopen: { dot: "done", icon: "refresh", tone: "success" },
  stop: { dot: "idle", icon: "stop", tone: "danger" },
  ignore: { dot: "idle", icon: "dismiss", tone: "neutral" },
  unavailable: { dot: "warning", icon: "alert", tone: "warning" },
  wouldAccept: { dot: "idle", icon: "dismiss", tone: "warning" },
};
/** Maps a Decision outcome to its visual mark, distinguishing `wouldAccept` (an ignore that observe mode would have accepted). */
export function decisionMark(t: T, outcome: Outcome): Mark {
  return {
    ...DECISION_MARKS[outcome],
    label: outcome === "wouldAccept" ? t("wouldAccept") : valueLabel(t, "decision", outcome),
  };
}
