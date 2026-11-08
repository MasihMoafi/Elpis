import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "./validate.mts";
export type Connection = {
  url: string;
  token: string;
  gateToken?: string;
};
export type Saved = {
  version: number;
  website?: string;
  account: {
    id: string;
    email: string;
  };
  connection?: Connection;
  sandboxToken?: string;
  thread?: string;
  signedInAt?: number;
};
export type RunOptions = {
  cwd?: string | undefined;
  stdin?: string | Buffer | undefined;
  signal?: AbortSignal | undefined;
  wait?: number | undefined;
};
export type AgentOptions = {
  localDir: string | undefined;
  key: string;
  provider: string;
  model?: string | undefined;
  effort?: string | undefined;
  prompt: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  onStatus?: ((text: string) => void) | undefined;
};
export type Options = {
  home?: string;
  website?: string;
  fetch?: typeof globalThis.fetch;
  wakeWaitMs?: number;
  retryMs?: number;
  pollMs?: number;
  pieceBytes?: number;
  maxTransferBytes?: number;
  tmpDir?: string;
};
export const CLOUDROOM_WEBSITE = "https://www.cloudroom.dev";
export const FILE_NAME = "cloudroom.json";
export const MAX_FILE_BYTES = 32768;
export const SIGN_IN_MS = 30 * 60000;
/** CloudRoom's CLI refuses one transfer over 16 MiB; every piece here stays well under it (project-copy.ts UPLOAD_PART). */
export const PIECE_BYTES = 2 * 1024 * 1024;
export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
/** CloudRoom's sandbox accounts: an Elpis thread ID in CloudRoom's own format (packages/domain raw-thread-id.ts). */
export const ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
export const PERSONAL_PROJECT = "proj_personal";
/** Where the VM's CLIs usually live; vm/run starts a plain shell. */
export const PATHS = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/bin:/usr/local/bin:$PATH"';
export const SETTINGS = "Settings → Models & accounts";
export class CloudroomError extends BridgeError {
  code: string;
  constructor(code: string, message: string, status?: number) {
    super(
      message,
      status ??
        (
          { not_signed_in: 401, too_big: 413, vm_asleep: 503, cli_missing: 424, cli_signed_out: 424 } as Record<
            string,
            number
          >
        )[code] ??
        502,
    );
    this.code = code;
  }
}
export const notSignedIn = () => new CloudroomError("not_signed_in", `Sign in to CloudRoom under ${SETTINGS} first.`);
export const expired = () =>
  new CloudroomError("not_signed_in", `CloudRoom no longer accepts this sign-in. Sign in again under ${SETTINGS}.`);
export const asleep = (seconds?: number) =>
  new CloudroomError(
    "vm_asleep",
    `The CloudRoom VM is asleep or still waking up${seconds ? ` (waited ${seconds} s)` : ""}. Try again in a minute.`,
  );
export const tooBig = (bytes: number | undefined, limit: number) =>
  new CloudroomError(
    "too_big",
    `This transfer is too big for CloudRoom${bytes ? `: ${mb(bytes)} packed` : ""}, over the ${mb(limit)} limit. Leave large files out (add them to .gitignore) and try again.`,
  );
export const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** A VM path, quoted for its shell. `~` is the VM agent's home (as `room-cli vm` does); other paths stay literal. */
export function vmPath(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\0\n]/.test(value))
    throw new BridgeError("Give a VM path.");
  const [prefix, rest] =
    value === "~" ? ['"$HOME"', ""] : value.startsWith("~/") ? ['"$HOME"/', value.slice(2)] : ["", value];
  return rest ? `${prefix}${quote(rest)}` : prefix;
}
export const quote = (value: unknown) => `'${String(value).replaceAll("'", "'\\''")}'`;
export function ownedHome(home: string | undefined) {
  if (typeof home !== "string" || !path.isAbsolute(home))
    throw new BridgeError("The Elpis home folder is unknown, so CloudRoom was not saved.", 503);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new BridgeError("The Elpis home folder must be a folder you own, not a link.", 403);
}
/** The handoff CloudRoom's website returns, checked as CloudRoom's own client checks it (account.ts handoffSchema). */
export function handoff(
  value: {
    account?: {
      id?: unknown;
      email?: unknown;
    };
    connection?: {
      url?: unknown;
      token?: unknown;
      gateToken?: string;
    };
    sandboxes?: {
      token?: string;
    };
  } | null,
) {
  const bad = () => new CloudroomError("sign_in_failed", "CloudRoom returned a sign-in Elpis cannot use. Try again.");
  if (!value || typeof value !== "object") throw bad();
  const { account, connection, sandboxes } = value;
  if (
    !account ||
    typeof account.id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(account.id) ||
    typeof account.email !== "string" ||
    !account.email.includes("@")
  )
    throw bad();
  let saved;
  if (connection) {
    if (
      typeof connection.url !== "string" ||
      typeof connection.token !== "string" ||
      connection.token.length < 32 ||
      /[^\x21-\x7e]/.test(connection.token)
    )
      throw bad();
    if (connection.gateToken !== undefined && !/^[a-zA-Z0-9._~-]{1,4096}$/.test(connection.gateToken)) throw bad();
    saved = {
      url: coreUrl(connection.url),
      token: connection.token,
      ...(connection.gateToken ? { gateToken: connection.gateToken } : {}),
    };
  }
  if (sandboxes !== undefined && !/^[a-f0-9]{64}$/.test(sandboxes?.token ?? "")) throw bad();
  if (!saved && !sandboxes) throw bad();
  return {
    account: { id: account.id, email: account.email },
    ...(saved ? { connection: saved } : {}),
    ...(sandboxes ? { sandboxToken: sandboxes.token } : {}),
  };
}
/** A core URL: HTTPS, or HTTP on this computer (tests), without credentials, query or fragment (client.ts). */
export function coreUrl(value: string) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CloudroomError("sign_in_failed", "CloudRoom returned an invalid VM address.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new CloudroomError("sign_in_failed", "CloudRoom returned an invalid VM address.");
  return url.href.replace(/\/$/, "");
}
/** The CloudRoom website: its real address, or a loopback server (tests), as CloudRoom's own client allows. */
export function websiteOrigin(value: string) {
  const url = new URL(value);
  if (url.origin !== CLOUDROOM_WEBSITE && !(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port))
    throw new BridgeError("Use the CloudRoom website.");
  return url.origin;
}
