/**
 * Requests the main Session must carry out itself, because a worker can neither see his chats nor change the
 * router's settings. On 11 Nov the same kind of order was done directly once and handed to a worker the next time,
 * where it could only fail. Accepting such a request as a ticket is refused once, with what to do instead; a second
 * accept of the same request goes through, so a real job that merely sounds like one is never locked out.
 */
const CHAT_ORDER =
  /\b(archive|unarchive|restore|rename|stop|start|open|tell|ask|message|write (?:in|to))\b[^.\n]*\b(chats?|conversations?)\b/i;
const SETTINGS_ORDER =
  /\b(workers?|router|orchestrator)\b[^.\n]*\b(models?|effort|gpt|claude|gemini|luna|sol|terra|opus|sonnet)\b/i;

const CHAT_HELP =
  "This reads as an order to one of his chats. A worker cannot see or control his chats: do it yourself with " +
  "chats_list and chats_send, chats_start or chats_change, then decide this candidate ignore with what you did in " +
  "answer. If it is truly work on code or files, accept it once more.";
const SETTINGS_HELP =
  "This reads as a change to your own settings. A worker cannot change them: do it yourself with " +
  "orchestrator_settings_save, then decide this candidate ignore with what you changed in answer. If it is truly " +
  "work on code or files, accept it once more.";

/** Why a request should not become a ticket, or nothing when it may. */
export function ownWork(...texts: (string | undefined)[]): string | undefined {
  const said = texts.filter(Boolean).join("\n");
  if (CHAT_ORDER.test(said)) return CHAT_HELP;
  if (SETTINGS_ORDER.test(said)) return SETTINGS_HELP;
  return undefined;
}

/** Remembers which requests were refused once, so the second accept of the same one passes. */
export class OwnWorkGate {
  private readonly refused = new Set<string>();
  /** The refusal for this request's first accept, or nothing. */
  check(triggerId: string, ...texts: (string | undefined)[]): string | undefined {
    if (this.refused.has(triggerId)) return undefined;
    const refusal = ownWork(...texts);
    if (refusal) this.refused.add(triggerId);
    return refusal;
  }
}
