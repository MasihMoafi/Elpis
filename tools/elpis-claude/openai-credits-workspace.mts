import { execFile, spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FunctionTool } from "openai/resources/responses/responses";
import type { Ceiling, PatchHunk, ToolState } from "./bridge-types.mts";

export type WorkspaceToolConfig = {
  cwd: string;
  sandbox: Ceiling;
  readOnly: boolean;
  disabled: boolean;
};

export type CreditToolPrepared = {
  title: string;
  kind: "read" | "edit" | "execute" | "other";
  toolName: string;
  rawInput: ToolState["raw"];
  requiresApproval: boolean;
  run: (signal: AbortSignal) => Promise<CreditToolExecution>;
};

export type CreditToolExecution = {
  output: string;
  failed: boolean;
  text?: string;
  toolResponse?: NonNullable<ToolState["response"]>;
};

export type RegisteredCreditTool = {
  definition: FunctionTool;
  prepare: (args: Record<string, unknown>) => CreditToolPrepared;
};

const MAX_OUTPUT_CHARS = 32_000;
const DEFAULT_READ_LIMIT = 400;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 300_000;
const MAX_GLOB_RESULTS = 200;

const clip = (value: string, max = MAX_OUTPUT_CHARS) =>
  value.length > max ? `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]` : value;

function strArg(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required parameter: ${key}`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`Invalid parameter ${key}: expected string.`);
  return value;
}

function intArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Invalid parameter ${key}: expected integer.`);
  return value;
}

function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid parameter ${key}: expected boolean.`);
  return value;
}

function resolveRealTarget(targetPath: string): string {
  const abs = resolve(targetPath);
  const missing: string[] = [];
  let cursor = abs;
  for (;;) {
    try {
      return join(realpathSync(cursor), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return abs;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

function resolvePathInWorkspace(cwd: string, rawPath: string, enforceWorkspace: boolean): string {
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
  if (!enforceWorkspace) return resolved;
  const realRoot = realpathSync(cwd);
  const realTarget = resolveRealTarget(resolved);
  const rel = relative(realRoot, realTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Sandbox blocks access outside the workspace: ${rawPath}`);
  }
  return realTarget;
}

function oneHunkPatch(oldText: string, newText: string): PatchHunk[] {
  const a = oldText.split("\n"), b = newText.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (head === a.length && head === b.length) return [];
  const ctx = 3, from = Math.max(0, head - ctx), aEnd = a.length - tail, bEnd = b.length - tail;
  const after = Math.min(tail, ctx);
  const lines = [
    ...a.slice(from, head).map(l => ` ${l}`),
    ...a.slice(head, aEnd).map(l => `-${l}`),
    ...b.slice(head, bEnd).map(l => `+${l}`),
    ...a.slice(aEnd, aEnd + after).map(l => ` ${l}`),
  ];
  return [{ oldStart: from + 1, oldLines: aEnd + after - from, newStart: from + 1, newLines: bEnd + after - from, lines }];
}

function findExecutable(candidates: (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function bwrapPath(): string | null {
  return findExecutable([
    process.env.ELPIS_BWRAP_BIN,
    new URL("../../package/codex-resources/bwrap", import.meta.url).pathname,
    "/usr/bin/bwrap",
    "/bin/bwrap",
  ]);
}

function rgPath(): string {
  return findExecutable([
    new URL("../../package/codex-path/rg", import.meta.url).pathname,
    "/usr/bin/rg",
  ]) ?? "rg";
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped
    .replace(/\*\*\//g, "(?:.+/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${regex}$`);
}

async function runShellCommand(command: string, cwd: string, sandbox: Ceiling, timeoutMs: number, signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let executable = "bash";
  let argv = ["-lc", command];
  if (sandbox === "workspace-write") {
    const bwrap = bwrapPath();
    if (!bwrap) throw new Error("Workspace sandbox (bwrap) is unavailable; refusing unsandboxed shell command.");
    const realCwd = realpathSync(cwd);
    executable = bwrap;
    argv = [
      "--ro-bind", "/", "/",
      "--tmpfs", "/tmp",
      "--bind", realCwd, realCwd,
      "--dev", "/dev",
      "--proc", "/proc",
      "--chdir", realCwd,
      "--", "bash", "-lc", command,
    ];
  }
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env };
    delete env.OPENAI_CREDITS_API_KEY;
    const child = spawn(executable, argv, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const stopChild = () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch {}
      }
      try { child.kill("SIGKILL"); } catch {}
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopChild();
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopChild();
      reject(new Error("Command aborted."));
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", chunk => { if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += String(chunk); });
    child.stderr.on("data", chunk => { if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += String(chunk); });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise({ stdout: clip(stdout), stderr: clip(stderr), exitCode: code ?? 1 });
    });
  });
}

export function workspaceTools(config: WorkspaceToolConfig): RegisteredCreditTool[] {
  if (config.disabled) return [];

  const readFileTool: RegisteredCreditTool = {
    definition: {
      type: "function",
      name: "read_file",
      description: "Read a UTF-8 text file with optional 1-based line offset and line limit.",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to cwd or absolute)." },
          offset: { type: "integer", description: "1-based starting line number." },
          limit: { type: "integer", description: "Maximum number of lines to read." },
        },
        required: ["path"],
      },
    },
    prepare(args) {
      const rawPath = strArg(args, "path", true) as string;
      const offset = Math.max(1, intArg(args, "offset") ?? 1);
      const limit = Math.max(1, Math.min(2000, intArg(args, "limit") ?? DEFAULT_READ_LIMIT));
      const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(config.cwd, rawPath);
      return {
        title: `Read ${basename(target) || rawPath}`,
        kind: "read",
        toolName: "Read",
        rawInput: { file_path: target },
        requiresApproval: false,
        async run(signal) {
          signal.throwIfAborted();
          const content = await readFile(target, "utf8");
          const lines = content.split("\n");
          const slice = lines.slice(offset - 1, offset - 1 + limit);
          const numbered = slice.map((line, i) => `${offset + i}: ${line}`).join("\n");
          const text = clip(numbered);
          return { output: JSON.stringify({ path: target, totalLines: lines.length, startLine: offset, content: text }), failed: false, text };
        },
      };
    },
  };

  const listDirTool: RegisteredCreditTool = {
    definition: {
      type: "function",
      name: "list_directory",
      description: "List files and subdirectories in a directory.",
      strict: false,
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path (defaults to cwd)." } },
      },
    },
    prepare(args) {
      const rawPath = strArg(args, "path") ?? ".";
      const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(config.cwd, rawPath);
      return {
        title: `List ${target}`,
        kind: "read",
        toolName: "LS",
        rawInput: { path: target },
        requiresApproval: false,
        async run(signal) {
          signal.throwIfAborted();
          const entries = await readdir(target, { withFileTypes: true });
          const listed = entries.slice(0, 500).map(e => `${e.isDirectory() ? "dir" : "file"} ${e.name}`);
          const text = listed.join("\n");
          return { output: JSON.stringify({ path: target, entries: listed }), failed: false, text };
        },
      };
    },
  };

  const globTool: RegisteredCreditTool = {
    definition: {
      type: "function",
      name: "glob_files",
      description: "Find files matching a glob pattern (e.g. **/*.ts) within a directory.",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to match relative paths." },
          path: { type: "string", description: "Base directory (defaults to cwd)." },
        },
        required: ["pattern"],
      },
    },
    prepare(args) {
      const pattern = strArg(args, "pattern", true) as string;
      const rawPath = strArg(args, "path") ?? ".";
      const root = isAbsolute(rawPath) ? resolve(rawPath) : resolve(config.cwd, rawPath);
      return {
        title: `Find ${pattern}`,
        kind: "read",
        toolName: "Glob",
        rawInput: { pattern, path: root },
        requiresApproval: false,
        async run(signal) {
          const matcher = globToRegex(pattern);
          const matches: string[] = [];
          const walk = async (dir: string) => {
            signal.throwIfAborted();
            if (matches.length >= MAX_GLOB_RESULTS) return;
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (matches.length >= MAX_GLOB_RESULTS) break;
              if (entry.name === ".git" || entry.name === "node_modules") continue;
              const full = join(dir, entry.name);
              const rel = relative(root, full).replace(/\\/g, "/");
              if (entry.isDirectory()) await walk(full);
              else if (matcher.test(rel) || matcher.test(entry.name)) matches.push(rel);
            }
          };
          await walk(root);
          const text = matches.join("\n");
          return { output: JSON.stringify({ root, matches }), failed: false, text };
        },
      };
    },
  };

  const grepTool: RegisteredCreditTool = {
    definition: {
      type: "function",
      name: "grep_search",
      description: "Search file contents with ripgrep for a regex pattern.",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for." },
          path: { type: "string", description: "File or directory path (defaults to cwd)." },
          glob: { type: "string", description: "Optional file glob filter." },
        },
        required: ["pattern"],
      },
    },
    prepare(args) {
      const pattern = strArg(args, "pattern", true) as string;
      const rawPath = strArg(args, "path") ?? ".";
      const glob = strArg(args, "glob");
      const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(config.cwd, rawPath);
      return {
        title: `Search ${pattern}`,
        kind: "read",
        toolName: "Grep",
        rawInput: { pattern, path: target },
        requiresApproval: false,
        run(signal) {
          return new Promise((resolvePromise, reject) => {
            const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--max-count", "200", ...(glob ? ["--glob", glob] : []), pattern, target];
            execFile(rgPath(), rgArgs, { cwd: config.cwd, timeout: 30_000, maxBuffer: 1024 * 1024, signal }, (err, stdout, stderr) => {
              const code = (err as { code?: number | string } | null)?.code;
              if (err && code !== 1) {
                reject(new Error(stderr?.trim() || err.message));
                return;
              }
              const text = clip(stdout.trim());
              resolvePromise({ output: JSON.stringify({ matches: text }), failed: false, text });
            });
          });
        },
      };
    },
  };

  const readOnlyTools = [readFileTool, listDirTool, globTool, grepTool];
  if (config.readOnly) return readOnlyTools;

  const bashTool: RegisteredCreditTool = {
    definition: {
      type: "function",
      name: "bash",
      description: "Execute a shell command in the workspace.",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run with bash -lc." },
          description: { type: "string", description: "Short description of the command." },
          timeout_ms: { type: "integer", description: "Timeout in milliseconds (default 120000, max 300000)." },
        },
        required: ["command"],
      },
    },
    prepare(args) {
      const command = strArg(args, "command", true) as string;
      const description = strArg(args, "description");
      const timeoutMs = Math.max(1000, Math.min(MAX_BASH_TIMEOUT_MS, intArg(args, "timeout_ms") ?? DEFAULT_BASH_TIMEOUT_MS));
      return {
        title: command,
        kind: "execute",
        toolName: "Bash",
        rawInput: { command, ...(description ? { description } : {}) },
        requiresApproval: true,
        async run(signal) {
          const result = await runShellCommand(command, config.cwd, config.sandbox, timeoutMs, signal);
          const failed = result.exitCode !== 0;
          return {
            output: JSON.stringify(result),
            failed,
            toolResponse: { stdout: result.stdout.replace(/\r\n/g, "\n").replace(/\n$/, ""), stderr: result.stderr.replace(/\r\n/g, "\n").replace(/\n$/, "") },
          };
        },
      };
    },
  };

  const writeFileTool: RegisteredCreditTool = {
    definition: {
      type: "function",
      name: "write_file",
      description: "Create or overwrite a UTF-8 text file.",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write." },
          content: { type: "string", description: "Full file contents." },
        },
        required: ["path", "content"],
      },
    },
    prepare(args) {
      const rawPath = strArg(args, "path", true) as string;
      const content = strArg(args, "content", true) as string;
      const target = resolvePathInWorkspace(config.cwd, rawPath, config.sandbox === "workspace-write");
      return {
        title: `Write ${basename(target) || rawPath}`,
        kind: "edit",
        toolName: "Write",
        rawInput: { file_path: target },
        requiresApproval: true,
        async run(signal) {
          signal.throwIfAborted();
          const before = await readFile(target, "utf8").catch(() => null);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, "utf8");
          const toolResponse = before === null
            ? { type: "create", filePath: target, content: clip(content) }
            : { filePath: target, structuredPatch: oneHunkPatch(before, content) };
          return { output: JSON.stringify({ path: target, bytes: Buffer.byteLength(content, "utf8") }), failed: false, toolResponse };
        },
      };
    },
  };

  const editFileTool: RegisteredCreditTool = {
    definition: {
      type: "function",
      name: "edit_file",
      description: "Replace exact text inside an existing UTF-8 text file.",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit." },
          old_string: { type: "string", description: "Exact text to replace." },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace all occurrences instead of requiring a single unique match." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    prepare(args) {
      const rawPath = strArg(args, "path", true) as string;
      const oldString = strArg(args, "old_string", true) as string;
      const newString = strArg(args, "new_string", true) as string;
      const replaceAll = boolArg(args, "replace_all") ?? false;
      if (!oldString.length) throw new Error("old_string must not be empty.");
      const target = resolvePathInWorkspace(config.cwd, rawPath, config.sandbox === "workspace-write");
      return {
        title: `Edit ${basename(target) || rawPath}`,
        kind: "edit",
        toolName: "Edit",
        rawInput: { file_path: target },
        requiresApproval: true,
        async run(signal) {
          signal.throwIfAborted();
          const before = await readFile(target, "utf8");
          const occurrences = before.split(oldString).length - 1;
          if (occurrences === 0) throw new Error(`old_string not found in ${target}`);
          if (!replaceAll && occurrences > 1) throw new Error(`old_string matched ${occurrences} times in ${target}; provide more context or set replace_all.`);
          const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
          await writeFile(target, after, "utf8");
          return {
            output: JSON.stringify({ path: target, replacements: replaceAll ? occurrences : 1 }),
            failed: false,
            toolResponse: { filePath: target, structuredPatch: oneHunkPatch(before, after) },
          };
        },
      };
    },
  };

  return [...readOnlyTools, bashTool, writeFileTool, editFileTool];
}
