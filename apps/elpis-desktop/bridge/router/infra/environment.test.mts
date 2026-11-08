// Ported from dsh-superagent (MIT), tests/environment.spec.ts
import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import type { SubprocessRuntime } from "./types.mts";
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
import {
  GIT_LOCATION,
  agentVariables,
  credentialHelper,
  runAsWorker,
  verifyDirectory,
  withoutDirectory,
  workerBin,
  workerGitConfig,
  writeEnvironment,
} from "./environment.mts";
import { CliError } from "./commands.mts";
import { testDeployment, gitEnv } from "./fixtures.mts";

const exec = promisify(execFile);
let dir: string;
const program = (path: string, body: string): string => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
/** Worker shell environment after DSH strips credential-shaped variables. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0]),
    ),
  );
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "environment-"));
  mkdirSync(join(dir, "real"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("worker shims", () => {
  it("run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller's other PATH entries", async () => {
    program(
      join(dir, "real", "gh"),
      'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"',
    );
    const wrapper = program(join(dir, "gh-agent"), `GH_CONFIG_DIR=${dir}/agent-config exec gh "$@"`);
    await writeEnvironment(
      testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: wrapper }, feishu: undefined }),
      [],
    );
    const bin = workerBin(dir);
    const path = [bin, join(dir, "venv"), join(dir, "real"), "/usr/bin", "/bin"].join(":");
    const { stdout } = await exec("gh", ["api", "user"], { env: { PATH: path }, timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual({
      login: "agent-bot",
      config: `${dir}/agent-config`,
      path: [join(dir, "venv"), join(dir, "real"), "/usr/bin", "/bin"].join(":"),
    });
  });
  it("make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent's login", async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ["personal-gh"]);
    const bin = workerBin(dir);
    await expect(exec(join(bin, "lark-cli"), ["im", "+chat-list"])).rejects.toMatchObject({
      code: 1,
      stderr: "lark-cli is unavailable: this installation has no Feishu bot.\n",
    });
    await expect(exec(join(bin, "personal-gh"), [])).rejects.toMatchObject({
      code: 1,
      stderr: "personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n",
    });
  });
  it("keep `gh` working, deny `lark-cli`, and shim no `git`, when the blocked commands name the commands workers need", async () => {
    const gh = program(join(dir, "gh-agent"), 'echo gh "$@"'),
      lark = program(join(dir, "lark-bot"), 'echo lark "$@"');
    const base = testDeployment();
    await writeEnvironment(
      testDeployment({ stateDir: dir, github: { ...base.github, cli: gh }, feishu: { ...base.feishu!, cli: lark } }),
      ["gh", "git", "lark-cli"],
    );
    const bin = workerBin(dir);
    expect((await exec(join(bin, "gh"), ["api", "user"])).stdout).toBe("gh api user\n");
    await expect(exec(join(bin, "lark-cli"), ["im"])).rejects.toThrow("no Feishu bot");
    expect(readdirSync(bin)).not.toContain("git");
  });
  it("replace only what dsh-superagent wrote and refuse anything else in its places", async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ["old-cli"]);
    await writeEnvironment(testDeployment({ stateDir: dir }), []);
    expect(readdirSync(workerBin(dir)).sort()).toEqual(["gh", "lark-cli"]);
    // A file that merely contains the marker on a later line, a symlink to a shim, and a foreign gitconfig are all rejected.
    writeFileSync(
      join(workerBin(dir), "notes"),
      `notes\nmore\n${readFileSync(join(workerBin(dir), "gh"), "utf8").split("\n")[1]}\n`,
    );
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(
      `${join(workerBin(dir), "notes")} was not written by dsh-superagent`,
    );
    rmSync(join(workerBin(dir), "notes"));
    symlinkSync(join(workerBin(dir), "gh"), join(workerBin(dir), "link"));
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(
      "link was not written by dsh-superagent",
    );
    rmSync(join(workerBin(dir), "link"));
    writeFileSync(workerGitConfig(dir), "[user]\n\tname = someone\n");
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(
      `${workerGitConfig(dir)} was not written by dsh-superagent`,
    );
    expect(readFileSync(workerGitConfig(dir), "utf8")).toBe("[user]\n\tname = someone\n");
  });
  it("replaces the files it wrote under the project's earlier names", async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ["old-cli", "older-cli"]);
    const legacy = (file: string, name: string) =>
      writeFileSync(file, readFileSync(file, "utf8").replace("Written by dsh-superagent", `Written by ${name}`));
    legacy(join(workerBin(dir), "old-cli"), "dsh-tag");
    legacy(join(workerBin(dir), "older-cli"), "dsh-freelancer");
    legacy(workerGitConfig(dir), "dsh-go");
    await writeEnvironment(testDeployment({ stateDir: dir }), []);
    expect(readdirSync(workerBin(dir)).sort()).toEqual(["gh", "lark-cli"]);
    expect(readFileSync(workerGitConfig(dir), "utf8")).toContain("Written by dsh-superagent");
  });
});

describe("agent git configuration", () => {
  it("ignores the operator's global and system git configuration, also after DSH drops credential-shaped variables", async () => {
    const home = join(dir, "home");
    mkdirSync(home);
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    writeFileSync(
      join(home, ".gitconfig"),
      '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n',
    );
    const deployment = testDeployment({
      stateDir: dir,
      github: { ...testDeployment().github, cli: "/opt/agent tools/gh" },
    });
    await writeEnvironment(deployment, []);
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.abbrev",
      GIT_CONFIG_VALUE_0: "12",
      GIT_AUTHOR_NAME: "Operator",
      GIT_COMMITTER_EMAIL: "operator@example.com",
      ...agentVariables(dir),
    });
    const git = async (...args: string[]): Promise<string> =>
      (await exec("git", args, { cwd: dir, env })).stdout.trim();
    await git("init", "-q", "repo");
    await exec("git", ["-C", "repo", "remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir, env });
    expect(await git("-C", "repo", "remote", "get-url", "--push", "origin")).toBe(
      "https://github.com/acme/widgets.git",
    );
    expect(await git("config", "--show-origin", "--get-all", "credential.https://github.com.helper")).toBe(
      `file:${workerGitConfig(dir)}\t${credentialHelper("/opt/agent tools/gh")}`,
    );
    expect(await git("config", "--get-all", "credential.helper")).toBe("");
    await expect(git("config", "commit.gpgsign")).rejects.toThrow();
    await expect(git("config", "core.abbrev")).rejects.toThrow();
    expect(env).not.toHaveProperty("GIT_AUTHOR_NAME");
    expect(env).not.toHaveProperty("GIT_COMMITTER_EMAIL");
    await expect(git("-C", "repo", "commit", "--allow-empty", "-q", "-m", "without identity")).rejects.toMatchObject({
      stderr: expect.stringContaining("no email was given"),
    });
    await git(
      "-C",
      "repo",
      "-c",
      "user.name=Alice",
      "-c",
      "user.email=alice@example.com",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "with identity",
    );
    expect(await git("-C", "repo", "log", "-1", "--format=%an <%ae> / %cn <%ce>")).toBe(
      "Alice <alice@example.com> / Alice <alice@example.com>",
    );
  });
});

it("fails instead of asking the operator's askpass helpers when the agent's credential helper has no answer", async () => {
  const log = join(dir, "asked");
  const askpass = program(join(dir, "askpass"), `echo asked >> ${log}; echo operator-secret`);
  const agent = program(join(dir, "real", "gh"), "exit 0");
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: agent } });
  await writeEnvironment(deployment, []);
  const env = workerEnv({
    PATH: process.env.PATH,
    HOME: dir,
    GIT_ASKPASS: askpass,
    SSH_ASKPASS: askpass,
    ...agentVariables(dir),
  });
  await exec("git", ["init", "-q", "repo"], { cwd: dir, env });
  await exec("git", ["-C", "repo", "config", "core.askPass", askpass], { cwd: dir, env });
  const fill = exec("git", ["-C", "repo", "credential", "fill"], { cwd: dir, env, timeout: 10_000 });
  fill.child.stdin?.end("protocol=https\nhost=github.com\n\n");
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining("terminal prompts disabled") });
  expect(() => readFileSync(log, "utf8")).toThrow();
});

it("removes every spelling of a directory from PATH and keeps the other entries", () => {
  mkdirSync(join(dir, "state", "worker-bin"), { recursive: true });
  symlinkSync(join(dir, "state"), join(dir, "link"));
  const bin = join(dir, "state", "worker-bin");
  expect(
    withoutDirectory([`${bin}/`, join(dir, "link", "worker-bin"), "/usr/bin", "node_modules/.bin"].join(":"), bin),
  ).toBe("/usr/bin:node_modules/.bin");
});

/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" }),
    });
    const output = { stdout: "", stderr: "" };
    child.stdout.on("data", chunk => {
      output.stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      output.stderr += String(chunk);
    });
    const reader = (name: "stdout" | "stderr") => ({
      readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }),
    });
    const done = new Promise<{ exitCode: number | null }>(resolve =>
      child.on("close", code => resolve({ exitCode: code })),
    );
    return { done, collected: { stdout: reader("stdout"), stderr: reader("stderr") } };
  },
});
describe("ticket directory check", () => {
  const signal = new AbortController().signal;
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, "global"), GIT_CONFIG_NOSYSTEM: "1" });
  const git = (...args: string[]) => exec("git", args, { cwd: dir, env: env() });
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, "global")), signal);
  beforeEach(() => {
    writeFileSync(join(dir, "global"), "[credential]\n\thelper = global-helper\n");
  });
  it("passes a directory whose repository adds no credentials, and one outside any repository", async () => {
    await git("init", "-q", "repo");
    await expect(check("repo")).resolves.toBeUndefined();
    // When no config key matches at all, git config --get-regexp exits with status 1.
    writeFileSync(join(dir, "global"), "");
    await expect(check("real")).resolves.toBeUndefined();
  });
  it("names the credential settings of the repository's own configuration", async () => {
    await git("init", "-q", "repo");
    await git("-C", "repo", "config", "http.https://github.com/.extraheader", "AUTHORIZATION: basic x");
    await expect(check("repo")).rejects.toThrow("sets http.https://github.com/.extraheader");
  });
  it("fails when git cannot read the repository's configuration, instead of passing it", async () => {
    await git("init", "-q", "repo");
    writeFileSync(join(dir, "repo", ".git", "config"), "[core\n");
    await expect(check("repo")).rejects.toThrow(/bad config/);
  });
  it("reports a failed command's exit status", async () => {
    const failing = ["sh", "-c", "echo nope >&2; exit 3"];
    const error = await runAsWorker(subprocess(join(dir, "global")), failing, dir, signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ message: "nope", exitCode: 3 });
  });
});

describe("the repository the host's environment names", () => {
  it("is left alone by the tests' git and named in no worker's environment, as when they run inside `git rebase --exec`", async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec("git", ["init", "-q", "scratch"], { cwd: dir, env: gitEnv() });
    const config = () => readFileSync(join(dir, "scratch", ".git", "config"), "utf8");
    const before = config();
    const previous = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
    };
    process.env.GIT_DIR = join(dir, "scratch", ".git");
    process.env.GIT_WORK_TREE = join(dir, "scratch");
    // The operator's limit on git's search for a repository names none, and stays.
    process.env.GIT_CEILING_DIRECTORIES = dir;
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      await exec("git", ["init", "-q", "repo"], {
        cwd: dir,
        env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, "global"), GIT_CONFIG_NOSYSTEM: "1" }),
      });
      writeFileSync(join(dir, "global"), "");
      await expect(
        verifyDirectory(join(dir, "repo"), subprocess(join(dir, "global")), new AbortController().signal),
      ).resolves.toBeUndefined();
      expect(readdirSync(join(dir, "repo"))).toContain(".git");
      expect(config()).toBe(before);
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) });
      for (const name of GIT_LOCATION) expect(env).not.toHaveProperty(name);
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
