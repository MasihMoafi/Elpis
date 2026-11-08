import { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createCloudroomVm } from "./cloudroom-vm.mts";

export const TEST_ROOT = os.tmpdir();

export const FAKE_ACP = fileURLToPath(new URL("../../../tools/elpis-claude/test/fake-acp-agent.mts", import.meta.url));

export const TOKEN = `core-${randomBytes(24).toString("hex")}`;

export const SANDBOX = randomBytes(32).toString("hex");

export const ACCOUNT = { id: "11111111-1111-4111-8111-111111111111", email: "masih@example.com" };

export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The VM's agent CLIs. Claude: prompt on stdin, answer on stdout. Codex: `exec -o FILE -`, answer in FILE.
export const CLAUDE = `#!/bin/sh
if [ "$1" = auth ]; then exit 1; fi
prompt=$(cat)
echo "$@" > "$HOME/claude-args"
case "$prompt" in *'"passed"'*) echo '{"passed":true,"summary":"Checked on the VM"}'; exit 0;; esac
case "$prompt" in *'[fail]'*) echo 'boom on the vm' >&2; exit 3;; *'[login]'*) echo 'Invalid API key · Please run /login' >&2; exit 1;; esac
mkdir -p src && echo "made on the VM" > src/vm.txt && echo "changed on the VM" > src/seed && rm -f src/gone
echo "Claude on the VM did it"
`;

export const CODEX = `#!/bin/sh
if [ "$1" = login ]; then [ -n "$FAKE_CODEX_LOGIN" ]; exit $?; fi
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
cat > /dev/null; echo "Codex on the VM did it" > "$out"
`;

/** `asleep`: how many vm/run requests answer 503 first. `bins`: which CLIs the VM has. */
export async function fakeCloudroom(
  t: TestContext,
  {
    asleep = 0,
    bins = ["claude", "codex"],
    codexLogin = false,
    sandboxOnly = false,
    maxOutput = 16 * 1024 * 1024,
  } = {},
) {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, "cloudroom-test-"));
  const vmHome = path.join(root, "vm"),
    elpisHome = path.join(root, "elpis");
  fs.mkdirSync(path.join(vmHome, ".local/bin"), { recursive: true });
  fs.mkdirSync(elpisHome);
  for (const name of bins)
    fs.writeFileSync(path.join(vmHome, ".local/bin", name), name === "claude" ? CLAUDE : CODEX, { mode: 0o755 });
  const seen: {
    redeems: { verifier: string; code: string }[];
    runs: { command: string; cwd?: string; stdin?: string }[];
    wakes: { thread: string; action: string }[];
    sleeping: number;
    auth: (string | string[] | undefined)[][];
    signOuts: number;
    pendingChallenge?: { challenge: string | null; code: string };
  } = { redeems: [], runs: [], wakes: [], sleeping: asleep, auth: [], signOuts: 0 };
  const body = (request: http.IncomingMessage) =>
    new Promise<string>(resolve => {
      const chunks: Buffer[] = [];
      request.on("data", c => chunks.push(c));
      request.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
  const coreServer = http.createServer((request, response) => {
    void (async () => {
      const raw = await body(request);
      if (request.url !== "/v1/vm/run" || request.method !== "POST") {
        response.writeHead(404);
        return response.end("{}");
      }
      seen.auth.push([request.headers.authorization, request.headers["x-cloudroom-token"]]);
      if (request.headers.authorization !== `Bearer ${TOKEN}` || request.headers["x-cloudroom-token"] !== TOKEN) {
        response.writeHead(401);
        return response.end(JSON.stringify({ error: `bad token ${request.headers.authorization}` }));
      }
      if (seen.sleeping > 0) {
        seen.sleeping--;
        response.writeHead(503);
        return response.end("waking");
      }
      const input = JSON.parse(raw);
      seen.runs.push(input);
      // PATH without the host's own CLIs: only the VM's ~/.local/bin ones exist.
      const child = spawn("bash", ["-c", input.command], {
        cwd: path.join(vmHome, input.cwd ?? ""),
        env: {
          HOME: vmHome,
          PATH: "/usr/bin:/bin",
          CLAUDE_CODE_OAUTH_TOKEN: "vm-login",
          ...(codexLogin ? { FAKE_CODEX_LOGIN: "1" } : {}),
        },
      });
      const out: Buffer[] = [],
        err: Buffer[] = [];
      child.stdout.on("data", c => out.push(c));
      child.stderr.on("data", c => err.push(c));
      child.stdin.end(Buffer.from(input.stdin ?? "", "hex"));
      child.on("close", code => {
        const stdout = Buffer.concat(out);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            code,
            stdout: stdout.subarray(0, maxOutput).toString("hex"),
            stderr: Buffer.concat(err).toString("hex"),
            truncated: stdout.length > maxOutput,
          }),
        );
      });
    })();
  });
  const website = http.createServer((request, response) => {
    void (async () => {
      const raw = await body(request),
        json = (status: number, value: unknown) => {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(value));
        };
      if (request.url === "/api/desktop/redeem") {
        const input = JSON.parse(raw);
        seen.redeems.push(input);
        const pending = seen.pendingChallenge;
        if (
          !pending ||
          createHash("sha256").update(input.verifier).digest("hex") !== pending.challenge ||
          input.code !== pending.code
        )
          return json(401, { error: "no" });
        return json(200, {
          account: ACCOUNT,
          ...(sandboxOnly ? {} : { connection: { url: core, token: TOKEN } }),
          sandboxes: { token: SANDBOX },
        });
      }
      if (request.url === "/api/desktop/sandboxes") {
        if (request.headers.authorization !== `Basic ${Buffer.from(`${ACCOUNT.id}:${SANDBOX}`).toString("base64")}`)
          return json(401, {});
        const input = JSON.parse(raw);
        seen.wakes.push(input);
        return seen.wakes.length < 2
          ? json(200, { thread: input.thread, state: "asleep", generation: 0, issue: null })
          : json(200, { thread: input.thread, state: "awake", generation: 1, issue: null, origin: core, token: TOKEN });
      }
      if (request.url === "/api/desktop/sign-out") {
        seen.signOuts++;
        return json(200, {});
      }
      json(404, {});
    })();
  });
  const listen = (server: http.Server) =>
    new Promise<string>(resolve =>
      server.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`),
      ),
    );
  const core = await listen(coreServer);
  const site = await listen(website);
  // Everything this process prints is kept, to prove no token reaches a log.
  const printed: string[] = [];
  const originals = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    write: process.stderr.write.bind(process.stderr),
    out: process.stdout.write.bind(process.stdout),
  };
  for (const name of ["log", "error", "warn"] as const)
    console[name] = (...args) => {
      printed.push(args.join(" "));
    };
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    printed.push(String(chunk));
    return (originals.write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    printed.push(String(chunk));
    return (originals.out as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  const vm = createCloudroomVm({
    home: elpisHome,
    website: site,
    wakeWaitMs: 3000,
    retryMs: 20,
    pollMs: 20,
    pieceBytes: 64 * 1024,
    maxTransferBytes: 4 * 1024 * 1024,
    tmpDir: path.join(root, "tmp"),
  });
  t.after(async () => {
    Object.assign(console, { log: originals.log, error: originals.error, warn: originals.warn });
    process.stderr.write = originals.write;
    process.stdout.write = originals.out;
    vm.close();
    coreServer.closeAllConnections();
    website.closeAllConnections();
    coreServer.close();
    website.close();
    execFileSync("gio", ["trash", root]);
  });
  /** What his browser does: open the page CloudRoom would show, which returns to Elpis's callback with a code. */
  async function browserSignIn(started: { url: string }) {
    const url = new URL(started.url),
      callback = url.searchParams.get("callback"),
      code = randomBytes(32).toString("hex");
    seen.pendingChallenge = { challenge: url.searchParams.get("challenge"), code };
    const answer = await fetch(`${callback}?${new URLSearchParams({ state: url.searchParams.get("state")!, code })}`);
    return { status: answer.status, page: await answer.text(), url };
  }
  const signedIn = async () => {
    const back = await browserSignIn(await vm.signIn());
    assert.equal(back.status, 200, back.page);
  };
  return { root, vmHome, elpisHome, vm, seen, printed, site, browserSignIn, signedIn };
}

/** Every file under `dir` but these test folders, as text: where a token must never be. */
export const everything = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true })
    .map(name => path.join(dir, name as string))
    .filter(file => fs.statSync(file).isFile())
    .map(file => fs.readFileSync(file, "latin1"))
    .join("\n");
