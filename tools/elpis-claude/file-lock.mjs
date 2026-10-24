// A lock every process on this machine sees: a directory beside the file. Two bridges share the chat store while one
// hands over to the other (handover.mjs), so each read-modify-write of it holds this lock.
import { mkdir, rmdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Runs `fn` holding the lock for `file`. A lock older than `staleMs` was left by a process that died and is taken. */
export async function withFileLock(file, fn, { staleMs = 10_000, waitMs = 15_000 } = {}) {
  const lock = `${file}.lock`, deadline = Date.now() + waitMs;
  await mkdir(dirname(file), { recursive: true });
  for (;;) {
    try { await mkdir(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) { await rmdir(lock).catch(() => {}); continue; }
      if (Date.now() > deadline) throw new Error(`${lock} is held by another process`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try { return await fn(); } finally { await rmdir(lock).catch(() => {}); }
}
