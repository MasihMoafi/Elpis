import { createVmTransfers } from "./cloudroom-transfers.mts";
import { createCloudroomAuth } from "./cloudroom-auth.mts";
import {
  CLOUDROOM_WEBSITE,
  PIECE_BYTES,
  MAX_TRANSFER_BYTES,
  PERSONAL_PROJECT,
  PATHS,
  CloudroomError,
  notSignedIn,
  expired,
  asleep,
  tooBig,
  mb,
  pause,
  quote,
  coreUrl,
  websiteOrigin,
} from "./cloudroom-contract.mts";
import type { Connection, Saved, RunOptions, AgentOptions, Options } from "./cloudroom-contract.mts";
export { CLOUDROOM_WEBSITE, PIECE_BYTES, MAX_TRANSFER_BYTES, CloudroomError, vmPath } from "./cloudroom-contract.mts";
// CloudRoom VM (1 Nov, Masih: "I asked if we can use cloud room's vms for our agents. that's it. I have a sub there.").
// Elpis talks to CloudRoom's web API itself; the CloudRoom app and its daemons are never installed (27 Oct security review,
// cloudroom-feedback/reports/security-review-2026-10-27.md). The flow follows CloudRoom's own published client
// (cloudroom-gui b5efb8d9): apps/server/src/services/cloudroom/account.ts signIn, client.ts runOnVm, sandboxes.ts wake,
// apps/cli/src/commands/cloudroom.ts vm push/pull.
//
// Sign-in: the browser opens `${website}/desktop?callback&state&challenge`, CloudRoom sends it back to a one-use loopback
// page here with `state` and `code`, and `{ code, verifier }` is redeemed at `${website}/api/desktop/redeem` for the
// account and its connection: a VM's core URL and token, or a token for per-thread sandboxes, or both.
// The connection is kept as provider keys are (provider-keys.mts): one owner-only file in the Elpis home, written to a
// private temporary file and renamed. Tokens are never returned, logged or put in an error message.

import fsp from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import { BridgeError } from "./validate.mts";

/**
 * @param home the Elpis home, where `cloudroom.json` is kept.
 * @param website CloudRoom's website (tests: a loopback fake).
 * @param wakeWaitMs how long a run waits for a sleeping VM or sandbox; `retryMs` the first pause between tries.
 * @param pollMs how often a running agent on the VM is checked.
 */
export function createCloudroomVm({
  home,
  website = CLOUDROOM_WEBSITE,
  fetch: fetcher = globalThis.fetch,
  wakeWaitMs = 180_000,
  retryMs = 2000,
  pollMs = 5000,
  pieceBytes = PIECE_BYTES,
  maxTransferBytes = MAX_TRANSFER_BYTES,
  tmpDir = os.tmpdir(),
}: Options = {}) {
  const origin = websiteOrigin(website);
  let sandbox: Connection | null = null;
  const auth = createCloudroomAuth({
    home,
    origin,
    fetcher,
    getSandbox: () => sandbox,
    clearSandbox: () => {
      sandbox = null;
    },
  });
  const { load, redact, fail, signIn, signOut, cancelSignIn } = auth;
  const saved = () => {
    const value = load();
    if (!value?.account || (!value.connection && !value.sandboxToken)) throw notSignedIn();
    return value;
  };
  const basic = (value: Saved) =>
    `Basic ${Buffer.from(`${value.account.id}:${value.sandboxToken}`).toString("base64")}`;
  /** A sandbox account has no one VM: Elpis keeps one CloudRoom thread, and its sandbox is woken for work (sandboxes.ts). */
  async function wakeSandbox(value: Saved, wake: boolean) {
    let response;
    try {
      response = await fetcher(`${value.website ?? origin}/api/desktop/sandboxes`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
        headers: { "Content-Type": "application/json", Authorization: basic(value) },
        body: JSON.stringify({ action: wake ? "wake" : "register", thread: value.thread, project: PERSONAL_PROJECT }),
      });
    } catch {
      throw Object.assign(asleep(), { retry: true });
    }
    const view = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) throw expired();
    if (!response.ok)
      throw Object.assign(
        fail(
          "vm_asleep",
          typeof view.error === "string"
            ? `CloudRoom could not start the sandbox: ${view.error}`
            : `CloudRoom could not start the sandbox (HTTP ${response.status}).`,
        ),
        { retry: response.status >= 500 || response.status === 409 },
      );
    if (view.state === "awake" && typeof view.origin === "string" && typeof view.token === "string")
      return { url: coreUrl(view.origin), token: view.token };
    if (view.state === "failed")
      throw fail("vm_asleep", `The CloudRoom sandbox did not start${view.issue ? `: ${view.issue}` : ""}.`);
    throw Object.assign(asleep(), { retry: true, state: view.state });
  }
  async function connection(wake = true) {
    const value = saved();
    if (value.connection) return value.connection;
    if (!sandbox) sandbox = await wakeSandbox(value, wake);
    return sandbox;
  }
  /** One vm/run request (client.ts runOnVm): JSON with hex stdin, hex stdout and stderr. */
  async function runOnce(command: string, { cwd, stdin, signal }: RunOptions = {}) {
    const core = await connection(true);
    let response;
    try {
      response = await fetcher(`${core.url}/v1/vm/run`, {
        method: "POST",
        redirect: "error",
        signal: signal as AbortSignal,
        headers: {
          Authorization: `Bearer ${core.token}`,
          "X-Cloudroom-Token": core.token,
          ...(core.gateToken ? { Cookie: `_port_auth=${core.gateToken}` } : {}),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          command,
          stdin: stdin === undefined ? "" : Buffer.from(stdin).toString("hex"),
          ...(cwd ? { cwd } : {}),
        }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      sandbox = null;
      throw Object.assign(asleep(), { retry: true });
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      sandbox = null;
      if (saved().connection) throw expired();
      throw Object.assign(asleep(), { retry: true });
    }
    if (response.status === 413) {
      await response.body?.cancel().catch(() => {});
      throw tooBig(stdin?.length, pieceBytes);
    }
    // A sleeping VM answers through CloudRoom's gateway while it starts.
    if ([502, 503, 504].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      sandbox = null;
      throw Object.assign(asleep(), { retry: true });
    }
    const value = await response.json().catch(() => null);
    if (!response.ok || !value)
      throw fail(
        "vm_error",
        typeof value?.error === "string"
          ? `CloudRoom refused the command: ${value.error}`
          : `CloudRoom refused the command (HTTP ${response.status}).`,
      );
    return {
      code: value.code ?? null,
      stdout: Buffer.from(String(value.stdout ?? ""), "hex"),
      stderr: Buffer.from(String(value.stderr ?? ""), "hex"),
      truncated: value.truncated === true,
    };
  }
  /** Runs a shell command on the VM as its agent account. A sleeping VM is waited for, up to `wakeWaitMs`. */
  async function run(command: string, { cwd, stdin, signal, wait = wakeWaitMs }: RunOptions = {}) {
    if (typeof command !== "string" || !command.trim()) throw new BridgeError("Give a command to run on the VM.");
    const started = Date.now();
    for (let tries = 0; ; tries++) {
      try {
        return await runOnce(command, { cwd, stdin, signal });
      } catch (error) {
        if (!(error as { retry?: boolean }).retry || signal?.aborted) throw error;
        const left = started + wait - Date.now();
        if (left <= 0) throw asleep(Math.round((Date.now() - started) / 1000));
        await pause(Math.min(retryMs * 2 ** Math.min(tries, 4), 15_000, left));
      }
    }
  }
  /** Fails with the command's error output unless it succeeded. */
  async function must(command: string, options?: RunOptions) {
    const result = await run(command, options);
    if (result.truncated) throw tooBig(0, pieceBytes);
    if (result.code !== 0)
      throw fail(
        "vm_error",
        `The VM command failed: ${result.stderr.toString().trim().slice(-600) || `exit ${result.code}`}`,
      );
    return result.stdout;
  }

  // ---- Copying files -------------------------------------------------------------------------------------------------
  const { push, pull, fetchArchive } = createVmTransfers({
    saved,
    must,
    run,
    fail,
    tmpDir,
    pieceBytes,
    maxTransferBytes,
  });
  // ---- What the VM can run -------------------------------------------------------------------------------------------
  /** Which agent CLIs the VM has and whether each is signed in, as its shell sees them. */
  async function probe(options: RunOptions = {}) {
    const script = [
      PATHS,
      'for c in claude codex; do p=$(command -v "$c" 2>/dev/null) && echo "$c=$p"; done',
      '{ [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] || [ -s "$HOME/.claude/.credentials.json" ] || { command -v claude >/dev/null 2>&1 && claude auth status >/dev/null 2>&1; }; } && echo claude_login=1',
      "command -v codex >/dev/null 2>&1 && codex login status >/dev/null 2>&1 && echo codex_login=1",
      "true",
    ].join("\n");
    const out = (await must(script, options)).toString();
    const has = (name: string) => new RegExp(`^${name}=`, "m").test(out);
    return {
      claude: { installed: has("claude"), signedIn: has("claude_login") },
      codex: { installed: has("codex"), signedIn: has("codex_login") },
    };
  }
  async function status({ check = false } = {}) {
    let value;
    try {
      value = load();
    } catch (error) {
      return { signedIn: false, signingIn: auth.signingIn, error: (error as Error).message };
    }
    const base = {
      signedIn: Boolean(value?.account && (value.connection || value.sandboxToken)),
      signingIn: auth.signingIn,
      error: auth.error,
      ...(value?.account ? { email: value.account.email, kind: value.connection ? "vm" : "sandbox" } : {}),
    };
    if (!check || !base.signedIn) return base;
    try {
      return { ...base, vm: { state: "awake", ...(await probe({ wait: Math.min(wakeWaitMs, 20_000) })) } };
    } catch (error) {
      return {
        ...base,
        vm: {
          state:
            (error as CloudroomError).code === "vm_asleep"
              ? "asleep"
              : (error as CloudroomError).code === "not_signed_in"
                ? "signed_out"
                : "error",
          message: redact((error as Error).message),
        },
      };
    }
  }

  // ---- Running a workflow agent there --------------------------------------------------------------------------------
  /** The CLI an agent's provider needs: Claude Code for Claude models, Codex for ChatGPT models. */
  function agentCommand(
    { provider, model, effort }: Pick<AgentOptions, "provider" | "model" | "effort">,
    meta: string,
  ) {
    if (!["claude", "openai"].includes(provider))
      throw new CloudroomError(
        "cli_missing",
        `The CloudRoom VM runs Claude Code and Codex agents only. Give this agent a Claude or ChatGPT model, or run the workflow on this computer.`,
      );
    const bare = String(model ?? "").replace(/^(claude|openai)\//, "");
    if (bare && !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/.test(bare))
      throw new BridgeError("Invalid model for the CloudRoom VM.");
    if (provider === "claude")
      return {
        cli: "claude" as const,
        name: "Claude Code",
        answer: `${meta}/out`,
        line: `claude -p --dangerously-skip-permissions --output-format text${bare ? ` --model ${quote(bare)}` : ""}`,
      };
    return {
      cli: "codex" as const,
      name: "Codex",
      answer: `${meta}/answer`,
      // `$M`: the run's folder, set by its script (the agent runs inside the copied worktree).
      line: `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --color never -o "$M/answer"${bare ? ` -m ${quote(bare)}` : ""}${/^(minimal|low|medium|high|xhigh)$/.test(effort ?? "") ? ` -c model_reasoning_effort=${quote(effort)}` : ""} -`,
    };
  }
  /**
   * One workflow agent on the VM: copy `localDir` there, run the provider's CLI on `prompt` in it, then bring its
   * changes (new, changed and deleted files) back into `localDir`. `onStatus(text)` hears each step.
   */
  async function runAgent({
    localDir,
    key,
    provider,
    model,
    effort,
    prompt,
    signal,
    timeoutMs = 30 * 60_000,
    onStatus = () => {},
  }: AgentOptions) {
    saved();
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(key ?? "")) throw new BridgeError("Invalid CloudRoom run name.");
    const work = `elpis-runs/${key}`,
      meta = `.cache/elpis/runs/${key}`;
    const agent = agentCommand({ provider, model, effort }, meta);
    const clis = await probe({ signal });
    if (!clis[agent.cli].installed)
      throw new CloudroomError(
        "cli_missing",
        `${agent.name} is not installed on the CloudRoom VM. Install it there (\`${agent.cli === "claude" ? "npm i -g @anthropic-ai/claude-code" : "npm i -g @openai/codex"}\`) or run the workflow on this computer.`,
      );
    if (!clis[agent.cli].signedIn)
      throw new CloudroomError(
        "cli_signed_out",
        `${agent.name} on the CloudRoom VM is not signed in. Sign it in on your CloudRoom account (or run \`${agent.cli === "claude" ? "claude" : "codex login"}\` on the VM), then try again.`,
      );
    onStatus("Copying the worktree to the CloudRoom VM…");
    await must(`rm -rf -- ${quote(work)} ${quote(meta)} && mkdir -p -- ${quote(work)} ${quote(meta)}`, { signal });
    const sent = await push(localDir, work, { signal });
    // What was there before the agent ran: deletions are what is missing afterwards, changes what is newer than `start`.
    await must(
      `cd -- ${quote(work)} && find . -type f ! -path './.git/*' -print0 > "$HOME"/${quote(`${meta}/manifest`)} && touch -- "$HOME"/${quote(`${meta}/start`)}`,
      { signal },
    );
    await must(`cat > ${quote(`${meta}/prompt`)}`, { stdin: Buffer.from(prompt), signal });
    const script = [
      "#!/bin/sh",
      PATHS,
      `M="$HOME"/${quote(meta)}`,
      'echo $$ > "$M/pid"',
      `cd -- "$HOME"/${quote(work)} || { echo 1 > "$M/code"; exit 1; }`,
      `${agent.line} < "$M/prompt" > "$M/out" 2> "$M/err"`,
      'echo $? > "$M/code.part" && mv "$M/code.part" "$M/code"',
    ].join("\n");
    await must(`cat > ${quote(`${meta}/run.sh`)}`, { stdin: Buffer.from(script), signal });
    onStatus(`Running ${agent.name} on the CloudRoom VM (${mb(sent.bytes)} copied)…`);
    // Detached, so a long agent outlives one request; its exit code is polled.
    await must(
      `if command -v setsid >/dev/null 2>&1; then setsid -f sh ${quote(`${meta}/run.sh`)} >/dev/null 2>&1 </dev/null; else nohup sh ${quote(`${meta}/run.sh`)} >/dev/null 2>&1 </dev/null & fi`,
      { signal },
    );
    const stop = () =>
      run(
        `p=$(cat ${quote(`${meta}/pid`)} 2>/dev/null) && { kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p"; }; true`,
        { wait: 0 },
      ).catch(() => {});
    const ends = Date.now() + timeoutMs;
    let code;
    try {
      for (;;) {
        if (signal?.aborted) throw new BridgeError("Workflow cancelled", 409);
        if (Date.now() > ends)
          throw new BridgeError(`${agent.name} on the CloudRoom VM ran past its time limit and was stopped.`, 408);
        const read = (await must(`cat ${quote(`${meta}/code`)} 2>/dev/null; true`, { signal })).toString().trim();
        if (/^\d+$/.test(read)) {
          code = Number(read);
          break;
        }
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, pollMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    } catch (error) {
      await stop();
      throw error;
    }
    const answer = (await must(`head -c 1048576 -- ${quote(agent.answer)} 2>/dev/null; true`, { signal })).toString();
    if (code !== 0) {
      const err = (
        await must(
          `tail -c 4000 -- ${quote(`${meta}/err`)} 2>/dev/null; tail -c 2000 -- ${quote(`${meta}/out`)} 2>/dev/null; true`,
          { signal },
        )
      )
        .toString()
        .trim();
      if (code === 127) throw new CloudroomError("cli_missing", `${agent.name} is not installed on the CloudRoom VM.`);
      if (/please run \/login|not logged in|invalid api key|login required|unauthori[sz]ed/i.test(err))
        throw new CloudroomError(
          "cli_signed_out",
          `${agent.name} on the CloudRoom VM is not signed in. Sign it in on your CloudRoom account, then try again.`,
        );
      throw fail(
        "agent_failed",
        `${agent.name} on the CloudRoom VM failed (exit ${code}): ${err.slice(-1500) || "no output"}`,
        409,
      );
    }
    onStatus("Copying the changes back from the CloudRoom VM…");
    const remote = `${meta}/changes.tgz`;
    const back = await fetchArchive(
      `cd -- "$HOME"/${quote(work)} && find . -type f ! -path './.git/*' -newer "$HOME"/${quote(`${meta}/start`)} -print0 > "$HOME"/${quote(`${meta}/changed`)}` +
        ` && xargs -0 -r sh -c 'for f; do [ -e "$f" ] || [ -L "$f" ] || printf "%s\\0" "$f"; done' sh < "$HOME"/${quote(`${meta}/manifest`)} > "$HOME"/${quote(`${meta}/deleted`)}` +
        ` && tar -czf "$HOME"/${quote(remote)} --null -T "$HOME"/${quote(`${meta}/changed`)} && cd "$HOME"`,
      remote,
      localDir as string,
      signal,
    );
    const changed = (await must(`cat -- ${quote(`${meta}/changed`)}`, { signal }))
      .toString()
      .split("\0")
      .filter(Boolean);
    const deleted = (await must(`cat -- ${quote(`${meta}/deleted`)}`, { signal }))
      .toString()
      .split("\0")
      .filter(Boolean);
    const root = path.resolve(localDir as string);
    for (const name of deleted) {
      const relative = path.posix.normalize(name.replace(/^\.\//, ""));
      if (
        !relative ||
        relative.startsWith("../") ||
        relative === ".." ||
        path.posix.isAbsolute(relative) ||
        relative.split("/")[0] === ".git"
      )
        continue;
      const target = path.resolve(root, relative);
      if (!target.startsWith(`${root}${path.sep}`)) continue;
      await fsp.rm(target, { force: true });
    }
    await run(`rm -rf -- ${quote(work)} ${quote(meta)}`, { wait: 0 }).catch(() => {});
    return { answer, changed: changed.length, deleted: deleted.length, sent, received: back };
  }

  return {
    signIn,
    signOut,
    status,
    run,
    push,
    pull,
    probe,
    runAgent,
    redact,
    close: cancelSignIn,
    /** Whether a run may target the VM now: signed in, without waking it. */
    ready() {
      saved();
      return true;
    },
  };
}
