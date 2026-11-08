import { spawn } from "node:child_process";

type CheckResult = { command: string; code: number; output: string };
/** The app records process exit codes itself. Agent prose never becomes a passing test result. */
export async function verifyImprovement(
  cwd: string,
  { timeoutMs = 600000, env = process.env }: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const commands: CheckResult[] = [],
    deadline = Date.now() + timeoutMs;
  const checks: [string, string[]][] = [
    ["npx", ["--no-install", "tsc", "--noEmit", "-p", "."]],
    ["flock", ["/tmp/elpis-desktop-build.lock", "npm", "run", "-s", "build"]],
    ["npm", ["run", "-s", "test:bridge"]],
    ["npm", ["run", "-s", "test:desktop"]],
  ];
  for (const [command, args] of checks) {
    const result = await new Promise<CheckResult>(resolve => {
      let output = "",
        settled = false;
      const childEnv = { ...env };
      delete childEnv.NODE_USE_ENV_PROXY;
      const child = spawn(command, args, { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const append = (bytes: string | Buffer) => {
        output = (output + bytes).slice(-24000);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const finish = (code: number) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ command: [command, ...args].join(" "), code, output });
        }
      };
      const signal = (value: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, value);
        } catch {
          /* It already exited. */
        }
      };
      // One budget covers every command, including build-lock waits. Settle directly: a descendant can
      // inherit stdout even after its parent exits, so waiting for "close" can leave the review checking.
      const timer = setTimeout(
        () => {
          signal("SIGTERM");
          append(
            `\nTimed out: verification exceeded its ${timeoutMs} ms limit while running ${[command, ...args].join(" ")}`,
          );
          setTimeout(() => signal("SIGKILL"), 2000).unref();
          finish(-1);
        },
        Math.max(0, deadline - Date.now()),
      );
      child.on("error", error => {
        append(error.message);
        finish(-1);
      });
      child.on("close", (code, signal) => {
        if (signal) append(`\nTerminated by ${signal}`);
        finish(code ?? -1);
      });
    });
    commands.push(result);
    if (result.code !== 0) break;
  }
  return { passed: commands.every(result => result.code === 0), commands };
}
