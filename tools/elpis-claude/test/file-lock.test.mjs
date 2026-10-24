// Two bridges share the chat store while one hands over to the other: each read-modify-write holds a lock
// every process sees. Run: node --test tools/elpis-claude/test/file-lock.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withFileLock } from "../file-lock.mjs";

const self = fileURLToPath(import.meta.url);

if (process.argv[2] === "writer") {
  const [file, key, count] = process.argv.slice(3);
  for (let i = 0; i < Number(count); i++) await withFileLock(file, async () => {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value[key] = (value[key] ?? 0) + 1;
    await new Promise((resolve) => setTimeout(resolve, 1)); // a real save takes a moment
    fs.writeFileSync(`${file}.${key}.tmp`, JSON.stringify(value)); fs.renameSync(`${file}.${key}.tmp`, file);
  });
} else {
  test("two processes updating one store keep every update", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-lock-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "chats.json"); fs.writeFileSync(file, "{}");
    const writers = ["old", "new"].map((key) => spawn(process.execPath, [self, "writer", file, key, "40"], { stdio: "inherit" }));
    await Promise.all(writers.map((child) => once(child, "exit")));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { old: 40, new: 40 });
    assert.equal(fs.existsSync(`${file}.lock`), false, "the lock is released");
  });

  test("a lock left by a process that died is taken over; a live one is waited for", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-lock-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "chats.json");
    fs.mkdirSync(`${file}.lock`); const old = new Date(Date.now() - 60_000); fs.utimesSync(`${file}.lock`, old, old);
    assert.equal(await withFileLock(file, async () => "ran", { staleMs: 1000 }), "ran");
    fs.mkdirSync(`${file}.lock`);
    await assert.rejects(withFileLock(file, async () => "ran", { staleMs: 60_000, waitMs: 200 }), /held by another process/);
  });
}
