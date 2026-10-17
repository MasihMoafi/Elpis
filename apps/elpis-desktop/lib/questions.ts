import type { Approval } from "./api";

/** One request_user_input question (codex-rs/app-server-protocol ToolRequestUserInputQuestion). */
export type Question = NonNullable<Approval["params"]["questions"]>[number];
/** "Other" is answered as the engine's own TUI answers it: this label, then the person's words as a note
 * (codex-rs/tui/src/bottom_pane/request_user_input). The draft holds exactly what is sent. */
export const OTHER_ANSWER = "None of the above";
const NOTE = "user_note: ";

export type QuestionState = { choice: number | "other" | null; other: string; answered: boolean; otherOffered: boolean };
/** What a draft answer means for its question: which option is chosen, the "Other" text, and whether it is answered. */
export function questionState(question: Question, answer?: string[]): QuestionState {
  const options = question.options ?? [], otherOffered = options.length > 0 && question.isOther === true;
  const index = answer?.[0] === undefined ? -1 : options.findIndex(option => option.label === answer[0]);
  if (index >= 0) return { choice: index, other: "", answered: true, otherOffered };
  if (otherOffered && answer?.[0] === OTHER_ANSWER) {
    const other = answer[1]?.startsWith(NOTE) ? answer[1].slice(NOTE.length) : "";
    return { choice: "other", other, answered: !!other.trim(), otherOffered };
  }
  return { choice: null, other: "", answered: !options.length && !!answer?.[0]?.trim(), otherOffered };
}
/** The answer the bridge sends for a question: the chosen option, "Other" with its note, or the typed answer. */
export function questionAnswer(question: Question, answer?: string[]): string[] {
  const state = questionState(question, answer);
  if (state.choice === "other") return [OTHER_ANSWER, `${NOTE}${state.other.trim()}`];
  return answer?.[0] ? [answer[0]] : [];
}
