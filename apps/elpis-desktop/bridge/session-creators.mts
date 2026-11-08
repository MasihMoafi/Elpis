import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { agentParentId } from "../lib/agent-runs.mts";

type Thread = {
  id: string;
  createdAt: string | number;
  threadSource?: string | null;
  path?: string;
  model?: string;
  cwd?: string;
  parentThreadId?: string | null;
  source?: unknown;
};
type Scan = { ino: number; offset: number; size?: number; mtime?: number; refs: Record<string, number[]> };
type ClaudeSession = { session?: string; model?: string; claudeAccountId?: string };
type ThreadPage = { data: Thread[]; nextCursor?: string | null };

const IDS = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const seconds = (value: unknown) =>
  typeof value === "number" ? (value > 1e12 ? value / 1000 : value) : Date.parse(value as string) / 1000;
// Rewritten rollouts can replace createdAt. Engine UUIDv7s retain the original creation millisecond.
const createdAt = (thread: Thread) => {
  const saved = seconds(thread.createdAt);
  const original = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(thread.id)
    ? Number.parseInt(thread.id.replaceAll("-", "").slice(0, 12), 16) / 1000
    : saved;
  return Math.min(saved, original);
};
/** The rollout header's thread_source ("user" for a chat the person started), or null. Only the first line is read. */
async function headerSource(file: string) {
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
    const chunks = [],
      chunk = Buffer.alloc(65536);
    for (let size = 0; size < HEADER_LIMIT;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      const end = chunk.subarray(0, bytesRead).indexOf(10);
      chunks.push(Buffer.from(chunk.subarray(0, end === -1 ? bytesRead : end)));
      size += bytesRead;
      if (end !== -1) break;
    }
    const record = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return record.type === "session_meta" && typeof record.payload?.thread_source === "string"
      ? record.payload.thread_source
      : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
const HEADER_LIMIT = 1 << 20;
const readJson = async (file: string): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    return {};
  }
};

/** Index timestamped ID references once, then only appended bytes. No transcript content is retained or written.
 * The small desktop-owned index survives restarts, including negative lookups. */
export class SessionCreators {
  #file: string;
  #home: string;
  #appHome: string;
  #scans?: Record<string, Scan>;
  #catalog = new Map<string, Thread>();
  #store: Record<string, ClaudeSession> = {};
  #delegations: Record<string, string> = {};
  #storeKey?: string | null;
  #sources = new Map<string, string | null>();
  constructor(
    file: string,
    { home = path.dirname(file), appHome = os.homedir() }: { home?: string; appHome?: string } = {},
  ) {
    this.#file = file;
    this.#home = home;
    this.#appHome = appHome;
  }
  thread(id: string) {
    return this.#catalog.get(id);
  }
  async recover(listed: Thread[], list: (cursor?: string | null) => Promise<ThreadPage>, linked = new Set<string>()) {
    const fresh = listed.some(
      thread =>
        !this.#catalog.has(thread.id) &&
        thread.threadSource !== "user" &&
        !agentParentId(thread) &&
        Number.isFinite(seconds(thread.createdAt)),
    );
    for (const thread of listed) this.#catalog.set(thread.id, thread);
    if (fresh) {
      const cursors = new Set<string | null | undefined>();
      let cursor: string | null | undefined;
      do {
        const page = await list(cursor);
        for (const thread of page.data) this.#catalog.set(thread.id, thread);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) break;
        cursors.add(cursor);
      } while (cursor);
    }
    // The engine lists chats without their source (thread_summary.rs sets none); a listed chat's rollout header has it.
    const threads = await Promise.all(
      [...this.#catalog.values()].map(async thread => {
        if (typeof thread.threadSource === "string" || typeof thread.path !== "string" || !path.isAbsolute(thread.path))
          return thread;
        if (!this.#sources.has(thread.path)) this.#sources.set(thread.path, await headerSource(thread.path));
        const threadSource = this.#sources.get(thread.path);
        return threadSource ? { ...thread, threadSource } : thread;
      }),
    );
    const children = threads.filter(
      thread =>
        !linked.has(thread.id) &&
        thread.threadSource !== "user" &&
        !agentParentId(thread) &&
        Number.isFinite(seconds(thread.createdAt)),
    );
    if (!children.length) return [];
    const parents = threads.filter(thread => thread.threadSource === "user" && !agentParentId(thread));
    const file = path.join(this.#home, "elpis-claude/sessions.json");
    const stat = await fs.promises.stat(file).catch(() => null),
      key = stat && `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (key !== this.#storeKey) {
      const saved = key ? await readJson(file) : {};
      this.#store = saved as Record<string, ClaudeSession>;
      this.#storeKey = key;
      const helpers = saved._delegations;
      this.#delegations =
        helpers && typeof helpers === "object" && !Array.isArray(helpers)
          ? Object.fromEntries(
              Object.entries(helpers).flatMap(([id, value]: [string, unknown]) =>
                value &&
                typeof value === "object" &&
                "parentThreadId" in value &&
                typeof value.parentThreadId === "string"
                  ? [[id, value.parentThreadId]]
                  : [],
              ),
            )
          : {};
    }
    const store = this.#store;
    const found = new Map<string, { child: string; maker: string; at: number }>();
    let changed = false;
    // Provider helpers have explicit lineage even when the fallback engine list omits it. Use that registry before
    // transcript inference: a long-running tool need not print the new ID within the creation-time window.
    for (const child of children) {
      const maker = this.#delegations[child.id];
      if (maker) found.set(child.id, { child: child.id, maker, at: -Infinity });
    }
    if (children.every(child => found.has(child.id))) return [...found.values()];
    this.#scans ??= ((await readJson(this.#file)).scans as Record<string, Scan>) ?? {};
    for (const parent of parents) {
      const files: (string | undefined)[] = [parent.path];
      const saved = store[parent.id];
      if (saved?.session && /^(?:claude\/|claude$)/.test(saved.model ?? parent.model ?? "")) {
        const account = saved.claudeAccountId;
        const config =
          account && account !== "default"
            ? path.join(this.#home, "elpis-claude/claude-accounts", account)
            : (process.env.CLAUDE_CONFIG_DIR ?? path.join(this.#appHome, ".claude"));
        files.push(
          path.join(config, "projects", (parent.cwd ?? "").replace(/[^a-zA-Z0-9]/g, "-"), `${saved.session}.jsonl`),
        );
      }
      for (const file of files.filter((file): file is string => typeof file === "string" && path.isAbsolute(file))) {
        let scan;
        try {
          const stat = await fs.promises.stat(file);
          scan = this.#scans[file];
          if (
            !scan ||
            scan.ino !== stat.ino ||
            scan.offset > stat.size ||
            (scan.size === stat.size && scan.mtime !== stat.mtimeMs)
          ) {
            scan = { ino: stat.ino, offset: 0, refs: {} };
            this.#scans[file] = scan;
          }
          if (scan.offset < stat.size && (scan.size !== stat.size || scan.mtime !== stat.mtimeMs)) {
            let fragments: Buffer[] = [],
              bytes = 0;
            for await (const raw of fs.createReadStream(file, { start: scan.offset, end: stat.size - 1 })) {
              const chunk = raw as Buffer;
              let start = 0,
                end;
              while ((end = chunk.indexOf(10, start)) !== -1) {
                const part = chunk.subarray(start, end);
                // Large tool/compaction records span many chunks; join once per line, never once per chunk.
                const line = (
                  fragments.length ? Buffer.concat([...fragments, part], bytes + part.length) : part
                ).toString("utf8");
                const ids = line.match(IDS);
                if (ids)
                  try {
                    const record = JSON.parse(line),
                      at = seconds(record.timestamp);
                    // Copied/compacted history has no creation-time timestamp of its own.
                    if (Number.isFinite(at) && !["session_meta", "compacted"].includes(record.type))
                      for (const id of new Set(ids)) {
                        const times = (scan.refs[id.toLowerCase()] ??= []);
                        if (times.at(-1) !== at) times.push(at);
                      }
                  } catch {
                    /* A partial or non-JSON line supplies no evidence. */
                  }
                scan.offset += bytes + part.length + 1;
                start = end + 1;
                fragments = [];
                bytes = 0;
              }
              if (start < chunk.length) {
                const rest = chunk.subarray(start);
                fragments.push(rest);
                bytes += rest.length;
              }
            }
            changed = true;
          }
          scan.size = stat.size;
          scan.mtime = stat.mtimeMs;
        } catch {
          continue; /* An unavailable transcript must never hide a chat. */
        }
        for (const child of children) {
          const created = createdAt(child);
          if (child.id === parent.id || createdAt(parent) > created) continue;
          // Creation output can arrive a little after the engine creates a batch of chats.
          const at = scan.refs[child.id]?.find(at => at >= created - 5 && at <= created + 120);
          if (at === undefined) continue;
          const prior = found.get(child.id);
          if (!prior || at < prior.at) found.set(child.id, { child: child.id, maker: parent.id, at });
        }
      }
    }
    if (changed) {
      await fs.promises.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const temporary = `${this.#file}.${randomUUID()}.pending`;
      await fs.promises.writeFile(temporary, JSON.stringify({ scans: this.#scans }), { mode: 0o600 });
      await fs.promises.rename(temporary, this.#file);
    }
    return [...found.values()];
  }
}
