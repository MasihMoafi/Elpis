export type QuestionReply = { questionItemId: string; question: string; answer: string };

/** Match the engine's complete async-answer envelope, never tags quoted inside an ordinary message. */
export function questionReplies(text: string): QuestionReply[] | null {
  const match = /^<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>$/.exec(text.trim());
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    const replies: unknown[] = Array.isArray(value) ? value : [value];
    const valid = (reply: unknown): reply is QuestionReply => {
      if (!reply || typeof reply !== "object" || Array.isArray(reply)) return false;
      const fields = reply as Record<string, unknown>;
      return typeof fields.questionItemId === "string" && typeof fields.question === "string" && typeof fields.answer === "string";
    };
    return replies.length && replies.every(valid) ? replies : null;
  } catch { return null; }
}

/** Plain text for copying and editing; storage and agent input keep the original envelope. */
export function questionReplyText(replies: QuestionReply[]): string {
  return replies.map(({ question, answer }) => `${question}\n${answer}`).join("\n\n");
}
