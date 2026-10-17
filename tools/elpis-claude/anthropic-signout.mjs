// Elpis's own sign-out of the Claude subscription: one small owner-only file in the bridge's state
// folder ($ELPIS_HOME/elpis-claude/anthropic.json) meaning "Elpis does not use the Claude subscription".
// It never touches Claude Code's login (~/.claude), which other programs on this computer share.
// The terminal and the desktop share the folder, and every reader asks the file at the moment it needs it.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const SIGNED_OUT_MESSAGE = "Anthropic is signed out in Elpis — sign in under Settings → Models & accounts.";
const FILE = "anthropic.json";

// No file: signed in. Otherwise signed out unless the file says `signedOut: false`; a file that cannot be
// read or understood counts as signed out, so a damaged switch never spends the subscription against the
// person's wish.
export function isSignedOut(dir) {
  let text;
  try { text = readFileSync(join(dir, FILE), "utf8"); } catch (error) { return error.code !== "ENOENT"; }
  try { return JSON.parse(text)?.signedOut !== false; } catch { return true; }
}

// Written to a private temporary file and renamed into place, so a reader never sees half a file.
export function setSignedOut(dir, signedOut) {
  if (typeof signedOut !== "boolean") throw Object.assign(new Error("signedOut must be true or false"), { code: -32602 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.${FILE}.${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ signedOut, changedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, join(dir, FILE));
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
}
