import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type Point = { root: string; tree: string };
type Entry = { mode: string; sha: string };
type Preview =
  | { available: false; reason: string }
  | {
      available: true;
      version: string;
      files: string[];
      added: number;
      removed: number;
      diff: string;
      truncated: boolean;
    };

const key = (value: string) => createHash("sha256").update(value).digest("hex");
const safe = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "--no-optional-locks",
  "--literal-pathspecs",
];
function command(
  program: string,
  args: string[],
  options: { cwd?: string; encoding?: BufferEncoding | "buffer" } = {},
  input?: string | Buffer,
) {
  return new Promise<string | Buffer>((resolve, reject) => {
    const child = execFile(
      program,
      args,
      { timeout: 30000, maxBuffer: 64 * 1024 * 1024, ...options },
      (error, stdout, stderr) =>
        error
          ? reject(
              new Error(
                `${program} could not keep the file checkpoint: ${String(stderr || error.message).slice(0, 250)}`,
              ),
            )
          : resolve(stdout),
    );
    child.stdin!.on("error", () => {});
    child.stdin!.end(input);
  });
}
const git = (cwd: string, args: string[], input?: string | Buffer) =>
  command("git", [...safe, ...args], { cwd, encoding: "utf8" }, input) as Promise<string>;

/** A private Git object store: never writes the project's refs, index, hooks or config, and never runs its filters.
 * Checkpoints include tracked files and unignored new files, including the dirty state before a turn. */
export class RewindSnapshots {
  home: string;
  pending: Promise<void>;
  constructor(home: string) {
    this.home = home;
    this.pending = Promise.resolve();
  }
  async serial<T>(run: () => Promise<T>) {
    const before = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>(resolve => {
      release = resolve;
    });
    await before;
    try {
      return await run();
    } finally {
      release();
    }
  }
  point(thread: string, turn: string) {
    return path.join(this.home, "points", key(thread), `${key(turn)}.json`);
  }
  async record(thread: string, turn: string): Promise<Point> {
    return JSON.parse(await fs.readFile(this.point(thread, turn), "utf8"));
  }
  async inherit(from: string, to: string) {
    const directory = path.dirname(this.point(from, ""));
    if (await fs.stat(directory).catch(() => null))
      await fs.cp(directory, path.dirname(this.point(to, "")), { recursive: true });
  }
  async alias(thread: string, from: string, to: string) {
    const point = await this.record(thread, from);
    await fs.rename(this.point(thread, from), this.point(thread, to));
    await git(this.directory(point.root), ["update-ref", `refs/checkpoints/${key(thread)}/${key(to)}`, point.tree]);
    await git(this.directory(point.root), ["update-ref", "-d", `refs/checkpoints/${key(thread)}/${key(from)}`]);
  }
  async root(cwd: unknown) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("This conversation has no Git folder.");
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  }
  directory(root: string) {
    return path.join(this.home, "repos", key(root));
  }
  async repo(root: string) {
    const directory = this.directory(root);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await fs.stat(path.join(directory, "HEAD")).catch(() => null)))
      await git(directory, ["init", "--bare", "-q"]);
    return directory;
  }
  async safePath(root: string, name: string) {
    if (!name || path.isAbsolute(name) || name.split("/").some(part => part === ".." || part.toLowerCase() === ".git"))
      throw new Error("Unsafe checkpoint file name.");
    let parent = root;
    for (const part of name.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      const stat = await fs.lstat(parent).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (stat && !stat.isDirectory())
        throw new Error("A checkpoint folder was replaced by a link or file. Nothing was restored.");
    }
    return path.join(root, name);
  }
  async tree(root: string, checkpoint?: string) {
    const directory = await this.repo(root);
    const tracked = checkpoint ? await git(directory, ["ls-tree", "-r", "--name-only", "-z", checkpoint]) : "";
    const names = [
      ...new Set(
        (tracked + (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z"])))
          .split("\0")
          .filter(Boolean),
      ),
    ].sort();
    if (names.length > 10000) throw new Error("This folder is too large for file checkpoints.");
    await git(directory, ["read-tree", "--empty"]);
    let size = 0,
      index = "";
    for (const name of names) {
      const file = await this.safePath(root, name),
        stat = await fs.lstat(file).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
      if (!stat) continue;
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new Error("File checkpoints do not support nested repositories or special files.");
      size += stat.size;
      if (size > 64 * 1024 * 1024) throw new Error("This folder is too large for file checkpoints.");
      const bytes = stat.isSymbolicLink() ? Buffer.from(await fs.readlink(file)) : await fs.readFile(file);
      const sha = (await git(directory, ["hash-object", "--no-filters", "-w", "--stdin"], bytes)).trim();
      index += `${stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644"} ${sha}\t${name}\0`;
    }
    if (index) await git(directory, ["update-index", "-z", "--index-info"], index);
    return (await git(directory, ["write-tree"])).trim();
  }
  async capture(thread: string, turn: string, cwd: unknown) {
    return this.serial(async () => {
      const root = await this.root(cwd),
        tree = await this.tree(root),
        file = this.point(thread, turn);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await git(this.directory(root), ["update-ref", `refs/checkpoints/${key(thread)}/${key(turn)}`, tree]);
      await fs.writeFile(file, JSON.stringify({ root, tree }), { mode: 0o600 });
      return { root, tree };
    });
  }
  async preview(thread: string, turn: string, cwd: unknown): Promise<Preview> {
    return this.serial(async () => {
      const point = await this.record(thread, turn).catch(() => null);
      if (!point) return { available: false, reason: "No file checkpoint for this message." };
      const root = await this.root(cwd);
      if (root !== point.root) return { available: false, reason: "This conversation has changed folders." };
      // A replaced parent symlink must remain reviewable, but restoration still refuses it in its preflight.
      let current;
      try {
        current = await this.tree(root, point.tree);
      } catch (error) {
        return { available: false, reason: (error as Error).message };
      }
      const directory = this.directory(root),
        args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
      const rows = (await git(directory, [...args, "--numstat", "-z", current, point.tree]))
        .split("\0")
        .filter(Boolean);
      let added = 0,
        removed = 0;
      const files = rows.map(row => {
        const [a, d, ...name] = row.split("\t");
        added += Number(a) || 0;
        removed += Number(d) || 0;
        return name.join("\t");
      });
      const diff = await git(directory, [...args, current, point.tree]);
      return {
        available: true,
        version: current,
        files,
        added,
        removed,
        diff: diff.slice(0, 200000),
        truncated: diff.length > 200000,
      };
    });
  }
  async restore(thread: string, turn: string, cwd: unknown, version: string | undefined) {
    return this.serial(async () => {
      const point = await this.record(thread, turn).catch(() => null);
      if (!point || !version) throw new Error("No file checkpoint or checked preview for this message.");
      const root = await this.root(cwd);
      if (root !== point.root) throw new Error("The conversation changed folders.");
      const current = await this.tree(root, point.tree);
      if (current !== version) throw new Error("Files changed since the preview. Close Rewind and try again.");
      const directory = this.directory(root);
      const entries = async (tree: string): Promise<Map<string, Entry>> =>
        new Map(
          (await git(directory, ["ls-tree", "-r", "-z", tree]))
            .split("\0")
            .filter(Boolean)
            .map(row => {
              const at = row.indexOf("\t"),
                [mode, , sha] = row.slice(0, at).split(" ");
              return [row.slice(at + 1), { mode: mode!, sha: sha! }];
            }),
        );
      const [before, after] = await Promise.all([entries(current), entries(point.tree)]),
        changes: { file: string; next: Entry | undefined; bytes?: Buffer }[] = [];
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        const old = before.get(name),
          next = after.get(name);
        if (old?.sha === next?.sha && old?.mode === next?.mode) continue;
        const file = await this.safePath(root, name),
          stat = await fs.lstat(file).catch(() => null);
        if (stat?.isDirectory()) throw new Error("A checkpoint file was replaced by a folder. Nothing was restored.");
        changes.push({ file, next });
      }
      // Preflight every path and load every blob before the first write.
      for (const change of changes)
        if (change.next)
          change.bytes = (await command("git", [...safe, "cat-file", "blob", change.next.sha], {
            cwd: directory,
            encoding: "buffer",
          })) as Buffer;
      for (const { file, next, bytes } of changes) {
        if (!next) {
          await command("gio", ["trash", "--", file]);
          continue;
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.elpis-${randomUUID()}`;
        if (next.mode === "120000") await fs.symlink(bytes!.toString(), temporary);
        else await fs.writeFile(temporary, bytes!, { mode: next.mode === "100755" ? 0o755 : 0o644 });
        await fs.rename(temporary, file);
      }
      return { restored: changes.length };
    });
  }
}
