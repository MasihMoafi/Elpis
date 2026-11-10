/** A message the router received arrives wrapped for the model: an `<elpis-router-message id="…">` line (long encoded
 * IDs) and a JSON payload (bridge/router/executor/adapter-config.mts `marker`). People see only what was said, with who
 * said it (10 Nov, Masih: "these long ass with these long ids are no good"). Anything else is returned unchanged. */
import { ticketText } from "./router-worker-input.ts";

export function routerMessageText(body: string): string {
  const ticket = ticketText(body.trim());
  if (ticket) return ticket;
  const match = /^<elpis-router-message id="[^"]*"(?: includes="[^"]*")?>\n?/.exec(body);
  if (!match) return body;
  const rest = body.slice(match[0].length).trim();
  const wrapped = ticketText(rest);
  if (wrapped) return wrapped;
  try {
    const value: unknown = JSON.parse(rest);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const said = typeof record.text === "string" ? record.text.trim() : "";
      const from = typeof record.from === "string" && record.from !== "local-user" ? `${record.from}: ` : "";
      if (said) return `${from}${said}`;
      if (typeof record.kind === "string") return `(${record.kind.replace(/_/g, " ")})`;
    }
  } catch {
    /* Not JSON: show the text after the wrapper line. */
  }
  return rest;
}
