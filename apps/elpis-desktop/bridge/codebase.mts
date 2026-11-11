/**
 * What a project's code holds, how it changes and how ready it is for coding agents: the data of the Codebase page
 * (docs/specs/codebase-dashboard.md). It works for any project that has Git. It reads the project and writes nothing
 * in it; each report's readiness checks are kept under the Elpis home, so the next report can say what changed.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MEDIA = new Set(
  ".png .gif .webp .jpg .jpeg .mp4 .webm .svg .ico .woff .woff2 .ttf .pdf .zip .gz .mp3 .wav".split(" "),
);
const LOCKS = ["package-lock.json", "Cargo.lock", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock"];
/** The settings file of a linter or formatter, wherever it sits in the project. */
const LINT_SETTINGS = new RegExp(
  `(^|/)(${[
    "\\.eslintrc[^/]*",
    "eslint\\.config\\.[a-z]+",
    "biome\\.json",
    "\\.prettierrc[^/]*",
    "prettier\\.config\\.[a-z]+",
    "ruff\\.toml",
    "rustfmt\\.toml",
    "clippy\\.toml",
    "\\.golangci\\.ya?ml",
    "\\.oxlintrc\\.json",
  ].join("|")})$`,
);
/** A file this large is data, not code someone reads. */
const MAX_BYTES = 5_000_000;
const LARGE_FILE = 1500;

/** One readiness check: what it asks, 1 met or 0 not met, and the evidence for the answer. */
export type Check = [check: string, met: 0 | 1, evidence: string];
export type CodebaseReport = {
  name: string;
  commit: string;
  date: string;
  /** Lines of code and data in each top-level folder; `d` says how many files. */
  code: { k: string; v: number; d: string }[];
  /** Markdown by folder: folder, files, lines. */
  docs: [folder: string, files: number, lines: number][];
  /** Files that changed, with their size today; the log names them by their place in this list. */
  churnFiles: [file: string, lines: number][];
  churnLog: [date: string, changes: [file: number, lines: number][]][];
  dups: { files: string[]; bytes: number; kind: "media" | "docs" | "other" }[];
  /** Every checkout: folder, megabytes on disk (-1 when it could not be measured), branch, last commit, unsaved files. */
  worktrees: [folder: string, megabytes: number, branch: string, lastCommit: string, unsaved: number][];
  pillars: [pillar: string, checks: Check[]][];
  /** Checks whose answer differs from the report before this one, and when that report was made. */
  changed: { check: string; from: number; to: number }[];
  previous: string | null;
};

const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd, maxBuffer: 512 * 1024 * 1024 })).stdout;
const ext = (file: string) => path.extname(file).toLowerCase();
const lock = (file: string) => LOCKS.some(name => file === name || file.endsWith(`/${name}`));
const built = (file: string) => /(^|\/)(dist|build|out|node_modules|target|vendor)\//.test(file);

/** Lines of each tracked text file; a binary or very large file has none. */
async function lineCounts(root: string, files: string[]): Promise<Map<string, number>> {
  const lines = new Map<string, number>();
  let next = 0;
  const worker = async () => {
    for (let file = files[next++]; file !== undefined; file = files[next++]) {
      if (MEDIA.has(ext(file))) continue;
      try {
        const info = await stat(path.join(root, file));
        if (!info.isFile() || info.size > MAX_BYTES) continue;
        const data = await readFile(path.join(root, file));
        if (data.subarray(0, 8192).includes(0)) continue;
        let count = 0;
        for (const byte of data) if (byte === 10) count++;
        lines.set(file, count);
      } catch {
        // A tracked file that is gone from disk has no lines to count.
      }
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  return lines;
}

const area = (file: string) => (file.includes("/") ? file.split("/")[0]! : "(top level)");
function codeByArea(lines: Map<string, number>): CodebaseReport["code"] {
  const sum = new Map<string, { lines: number; files: number }>();
  for (const [file, count] of lines) {
    if (ext(file) === ".md" || lock(file) || built(file)) continue;
    const entry = sum.get(area(file)) ?? { lines: 0, files: 0 };
    sum.set(area(file), { lines: entry.lines + count, files: entry.files + 1 });
  }
  const rows = [...sum].sort((a, b) => b[1].lines - a[1].lines);
  const top = rows.slice(0, 8).map(([k, entry]) => ({ k, v: entry.lines, d: `${entry.files.toLocaleString("en-US")} files` }));
  const rest = rows.slice(8);
  if (rest.length)
    top.push({
      k: "Other",
      v: rest.reduce((total, [, entry]) => total + entry.lines, 0),
      d: `${rest.length} folders: ${rest
        .slice(0, 3)
        .map(([k]) => k)
        .join(", ")}`,
    });
  return top;
}

function docsByFolder(lines: Map<string, number>): CodebaseReport["docs"] {
  const sum = new Map<string, [number, number]>();
  for (const [file, count] of lines) {
    if (ext(file) !== ".md" || built(file)) continue;
    const parts = file.split("/");
    const folder = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0]! : "(top level)";
    const [files, total] = sum.get(folder) ?? [0, 0];
    sum.set(folder, [files + 1, total + count]);
  }
  return [...sum]
    .map(([folder, [files, total]]): [string, number, number] => [folder, files, total])
    .sort((a, b) => b[2] - a[2])
    .slice(0, 12);
}

/** Lines added plus removed in each commit, by the date it was written; the page sums any two dates. */
async function churn(root: string, lines: Map<string, number>) {
  const churnFiles: CodebaseReport["churnFiles"] = [];
  const churnLog: CodebaseReport["churnLog"] = [];
  const index = new Map<string, number>();
  const log = await git(root, "log", "--numstat", "--format=@%as", "--no-renames");
  for (const block of log.split("@").slice(1)) {
    const [date = "", ...rows] = block.trim().split("\n");
    const changes: [number, number][] = [];
    for (const row of rows) {
      const [added = "", removed = "", file = ""] = row.split("\t");
      const size = lines.get(file);
      if (!/^\d+$/.test(added) || !/^\d+$/.test(removed) || !size) continue;
      if ([".md", ".json", ".html"].includes(ext(file)) || lock(file) || built(file)) continue;
      if (!index.has(file)) {
        index.set(file, churnFiles.length);
        churnFiles.push([file, size]);
      }
      changes.push([index.get(file)!, Number(added) + Number(removed)]);
    }
    if (changes.length) churnLog.push([date, changes]);
  }
  return { churnFiles, churnLog };
}

async function duplicates(root: string): Promise<CodebaseReport["dups"]> {
  const byBlob = new Map<string, string[]>();
  for (const row of (await git(root, "ls-files", "-s", "-z")).split("\0")) {
    const [meta, file] = row.split("\t");
    const blob = meta?.split(" ")[1];
    if (!blob || !file) continue;
    byBlob.set(blob, [...(byBlob.get(blob) ?? []), file]);
  }
  const dups: CodebaseReport["dups"] = [];
  for (const files of byBlob.values()) {
    if (files.length < 2) continue;
    const bytes = await stat(path.join(root, files[0]!)).then(
      info => info.size,
      () => 0,
    );
    if (!bytes) continue;
    const kind = MEDIA.has(ext(files[0]!)) ? "media" : ext(files[0]!) === ".md" ? "docs" : "other";
    dups.push({ files: [...files].sort(), bytes, kind });
  }
  return dups.sort((a, b) => b.bytes * (b.files.length - 1) - a.bytes * (a.files.length - 1)).slice(0, 200);
}

async function worktrees(root: string): Promise<CodebaseReport["worktrees"]> {
  const rows: CodebaseReport["worktrees"] = [];
  for (const block of (await git(root, "worktree", "list", "--porcelain")).trim().split("\n\n")) {
    const info = new Map(block.split("\n").map((line): [string, string] => [line.split(" ")[0]!, line.slice(line.indexOf(" ") + 1)]));
    const folder = info.get("worktree");
    if (!folder) continue;
    try {
      // du still prints the total when it could not read a folder inside (it then exits with an error).
      const megabytes = await run("du", ["-sm", folder], { timeout: 20_000 }).then(
        result => Number(result.stdout.split(/\s/)[0]) || 0,
        (failure: { stdout?: string }) => Number(failure.stdout?.split(/\s/)[0]) || -1,
      );
      const last = (await git(folder, "log", "-1", "--format=%cs")).trim();
      const unsaved = (await git(folder, "status", "--porcelain")).split("\n").filter(Boolean).length;
      rows.push([folder, megabytes, (info.get("branch") ?? "detached").replace("refs/heads/", ""), last, unsaved]);
    } catch {
      // A worktree whose folder is gone is not a copy on disk.
    }
  }
  return rows.sort((a, b) => b[1] - a[1]);
}

/** The readiness checks: each is read from the tracked files and answered yes or no with its evidence. */
async function readiness(root: string, files: string[], lines: Map<string, number>, dups: CodebaseReport["dups"]) {
  const found = (pattern: RegExp) => files.filter(file => pattern.test(file) && !built(file));
  const text = (file: string) => readFile(path.join(root, file), "utf8").catch(() => "");
  const check = (name: string, hits: string[], missing: string, say = (list: string[]) => list.slice(0, 3).join(", ")): Check =>
    hits.length ? [name, 1, say(hits)] : [name, 0, missing];
  const packages = found(/(^|\/)package\.json$/).slice(0, 12);
  const scripts = new Map<string, Record<string, string>>();
  for (const file of packages) {
    try {
      scripts.set(file, (JSON.parse(await text(file)) as { scripts?: Record<string, string> }).scripts ?? {});
    } catch {
      // A package file that does not parse has no commands to read.
    }
  }
  const withScript = (name: string) => [...scripts].filter(([, all]) => all[name]).map(([file]) => `${file}: npm run ${name}`);
  const workflows = found(/^\.github\/workflows\/[^/]+\.ya?ml$/);
  const workflowText = (await Promise.all(workflows.map(text))).join("\n");
  const strict = [];
  for (const file of found(/(^|\/)tsconfig[^/]*\.json$/).slice(0, 12)) if (/"strict"\s*:\s*true/.test(await text(file))) strict.push(file);
  const tests = found(/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/);
  const large = [...lines]
    .filter(([file, count]) => count > LARGE_FILE && !lock(file) && !built(file) && ![".md", ".json", ".html", ".svg", ".csv"].includes(ext(file)))
    .sort((a, b) => b[1] - a[1]);
  const codeCopies = dups.filter(dup => dup.kind === "other" && !dup.files.some(built));
  const pillars: CodebaseReport["pillars"] = [
    [
      "Style and validation",
      [
        check(
          "A formatter or linter is set up",
          found(LINT_SETTINGS),
          "no linter or formatter settings in Git",
        ),
        check(
          "Types are checked",
          [...strict, ...found(/(^|\/)(mypy\.ini|pyrightconfig\.json|Cargo\.toml|go\.mod)$/)],
          "no strict TypeScript, typed language or type checker settings",
        ),
        check(
          "Checks run before a commit",
          found(/^(\.githooks|\.husky)\/[^/]+$|(^|\/)(\.pre-commit-config\.yaml|lefthook\.ya?ml)$/),
          "no commit hooks in Git",
        ),
      ],
    ],
    [
      "Build",
      [
        check(
          "A build or run command is written down",
          [...withScript("build"), ...withScript("start"), ...found(/^(Makefile|justfile|Cargo\.toml|pyproject\.toml)$/)],
          "no build script, Makefile, justfile, Cargo.toml or pyproject.toml",
        ),
        check("Dependencies are locked", files.filter(lock), "no lock file in Git"),
        check(
          "The language version is pinned",
          found(/(^|\/)(\.nvmrc|\.node-version|rust-toolchain(\.toml)?|\.python-version|\.tool-versions)$/),
          "no .nvmrc, rust-toolchain, .python-version or .tool-versions",
        ),
      ],
    ],
    [
      "Testing",
      [
        check("Tests exist", tests, "no test files found", list => `${list.length.toLocaleString("en-US")} test files`),
        check(
          "A test command is written down",
          [...withScript("test"), ...found(/(^|\/)(pytest\.ini|Cargo\.toml|go\.mod)$/)],
          "no test script, pytest settings or Cargo.toml",
        ),
        check(
          "Tests run on every push",
          /\b(npm (run )?test|node --test|pytest|cargo (nextest|test)|vitest|jest|go test)\b/.test(workflowText) ? workflows : [],
          workflows.length ? "the workflows run no test command" : "no workflows in .github/workflows",
        ),
      ],
    ],
    [
      "Documentation",
      [
        check("A README", found(/^readme(\.[a-z]+)?$/i), "no README at the top level"),
        check(
          "Agent instructions are in Git",
          found(/(^|\/)(AGENTS|CLAUDE)\.md$/),
          "no AGENTS.md or CLAUDE.md in Git: a fresh clone has none",
        ),
        check("How to contribute", found(/^(\.github\/|docs\/)?contributing(\.[a-z]+)?$/i), "no CONTRIBUTING file"),
      ],
    ],
    [
      "Dev environment",
      [
        check(
          "Environment variables are documented",
          found(/(^|\/)\.env\.(example|sample|template)$/),
          "no .env.example in Git",
        ),
        check(
          "A reproducible dev environment",
          found(/^\.devcontainer\/|(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|flake\.nix)$/),
          "no dev container, Dockerfile or flake.nix",
        ),
      ],
    ],
    [
      "Code quality",
      [
        large.length
          ? [
              `Files kept small (under ${LARGE_FILE.toLocaleString("en-US")} lines)`,
              0,
              `${large.length} over the limit; the largest: ${large
                .slice(0, 3)
                .map(([file, count]) => `${file} (${count.toLocaleString("en-US")})`)
                .join(", ")}`,
            ]
          : [`Files kept small (under ${LARGE_FILE.toLocaleString("en-US")} lines)`, 1, "no code file is over the limit"],
        codeCopies.length
          ? ["No exact copies of code or data", 0, `${codeCopies.length} sets; the largest: ${codeCopies[0]!.files.slice(0, 2).join(" = ")}`]
          : ["No exact copies of code or data", 1, "no two tracked code or data files are the same"],
      ],
    ],
    [
      "Security and governance",
      [
        check("A licence", found(/^(licen[cs]e|copying)(\.[a-z]+)?$/i), "no LICENSE file"),
        check("A security policy", found(/^(\.github\/|docs\/)?security\.md$/i), "no SECURITY.md"),
        check("Code owners", found(/^(\.github\/|docs\/)?CODEOWNERS$/), "no CODEOWNERS file"),
        check(
          "Automatic dependency updates",
          found(/^\.github\/dependabot\.ya?ml$|(^|\/)renovate\.json5?$/),
          "no Dependabot or Renovate settings",
        ),
      ],
    ],
  ];
  return pillars;
}

type Stored = { at: string; commit: string; pillars: CodebaseReport["pillars"] };
/** Keeps this report's checks beside the earlier ones and says what moved since the report before it. */
async function remember(home: string, root: string, commit: string, pillars: CodebaseReport["pillars"]) {
  const folder = path.join(home, "readiness", createHash("sha256").update(root).digest("hex").slice(0, 16));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const names = (await readdir(folder)).filter(name => name.endsWith(".json")).sort();
  const load = async (name: string | undefined) =>
    name ? (JSON.parse(await readFile(path.join(folder, name), "utf8")) as Stored) : undefined;
  let latest = await load(names.at(-1)).catch(() => undefined);
  let before = await load(names.at(-2)).catch(() => undefined);
  const answers = (value: CodebaseReport["pillars"]) => JSON.stringify(value.flatMap(([, checks]) => checks.map(([name, met]) => [name, met])));
  if (!latest || answers(latest.pillars) !== answers(pillars)) {
    before = latest;
    latest = { at: new Date().toISOString(), commit, pillars };
    await writeFile(path.join(folder, `${latest.at.replace(/[:.]/g, "-")}.json`), JSON.stringify(latest), { mode: 0o600 });
  }
  const earlier = new Map((before?.pillars ?? []).flatMap(([, checks]) => checks.map(([name, met]): [string, number] => [name, met])));
  const changed = pillars
    .flatMap(([, checks]) => checks)
    .filter(([name, met]) => earlier.has(name) && earlier.get(name) !== met)
    .map(([name, met]) => ({ check: name, from: earlier.get(name)!, to: met }));
  return { changed, previous: before?.at ?? null };
}

/** A report read less than a minute ago is shown again: reading a large project takes seconds. */
const recent = new Map<string, { at: number; report: Promise<CodebaseReport> }>();
export function cachedCodebaseReport(cwd: string, home: string, now = Date.now()): Promise<CodebaseReport> {
  const kept = recent.get(cwd);
  if (kept && now - kept.at < 60_000) return kept.report;
  const report = codebaseReport(cwd, home);
  recent.set(cwd, { at: now, report });
  // A reading that failed is not kept: the next look reads again.
  report.catch(() => recent.delete(cwd));
  return report;
}

/** The report for the Git project that holds `cwd`. `home` is the Elpis home, where earlier reports are kept. */
export async function codebaseReport(cwd: string, home: string): Promise<CodebaseReport> {
  const root = (await git(cwd, "rev-parse", "--show-toplevel")).trim();
  const files = (await git(root, "ls-files", "-z")).split("\0").filter(Boolean);
  const [commit = "", date = ""] = (await git(root, "log", "-1", "--format=%h %cs").catch(() => "")).trim().split(" ");
  const lines = await lineCounts(root, files);
  const dups = await duplicates(root);
  const pillars = await readiness(root, files, lines, dups);
  return {
    name: path.basename(root),
    commit,
    date,
    code: codeByArea(lines),
    docs: docsByFolder(lines),
    ...(commit ? await churn(root, lines) : { churnFiles: [], churnLog: [] }),
    dups,
    worktrees: await worktrees(root),
    pillars,
    ...(await remember(home, root, commit, pillars)),
  };
}
