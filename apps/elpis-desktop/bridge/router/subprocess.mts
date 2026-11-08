import { spawn } from "node:child_process";
import type { SubprocessRuntime } from "./infra/types.mts";

/** Owned prepare processes: abort terminates their whole process group, including shell descendants. */
export const subprocess: SubprocessRuntime = {
  spawn(options) {
    const [command, ...args] = options.argv;
    if (!command) throw new Error("A process command is required");
    options.signal.throwIfAborted();
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...options.env }).filter(
        ([name, value]) => value !== undefined && !/KEY|PASSWORD|SECRET|TOKEN/i.test(name),
      ),
    );
    const child = spawn(command, args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "",
      stderr = "",
      timer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        /* Already stopped. */
      }
    };
    const abort = () => {
      kill("SIGTERM");
      timer = setTimeout(() => kill("SIGKILL"), options.graceMs);
      timer.unref();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout.on("data", (data: Buffer) => {
      stdout = (stdout + data.toString()).slice(-options.stdio.stdout.maxBytes);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-options.stdio.stderr.maxBytes);
    });
    const done = new Promise<{ exitCode: number | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", exitCode => {
        kill("SIGKILL");
        clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
        resolve({ exitCode });
      });
    });
    return {
      done,
      collected: {
        stdout: { readFrom: offset => ({ text: stdout.slice(offset) }) },
        stderr: { readFrom: offset => ({ text: stderr.slice(offset) }) },
      },
    };
  },
};
