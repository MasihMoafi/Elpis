import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "./files.mts";

test("large text previews read bounded UTF-8 pages and refuse a changed file", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-file-pages-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const text = "abc فارسی 😀\n".repeat(60000),
    file = path.join(root, "large.txt");
  await fs.writeFile(file, text);
  const first = await readFile(root, "large.txt");
  assert.equal(first.preview, "text");
  assert.ok(Buffer.byteLength(first.content ?? "") <= 32768);
  assert.ok(first.pages! > 1);
  const pieces = [first.content];
  for (let page = 1; page < first.pages!; page++) {
    const next = await readFile(root, "large.txt", { page, mtimeMs: first.mtimeMs });
    assert.equal(next.page, page);
    pieces.push(next.content);
  }
  assert.equal(pieces.join(""), text, "no missing, repeated or damaged Unicode at byte boundaries");
  const region = await readFile(root, "large.txt", { line: 50000 });
  assert.ok(
    region.firstLine! <= 50000 && region.firstLine! + (region.content?.split("\n").length ?? 0) > 50000,
    "a line reference reads its region first",
  );
  assert.ok(Buffer.byteLength(region.content ?? "") <= 32771);
  await fs.appendFile(file, "changed");
  await assert.rejects(readFile(root, "large.txt", { page: 1, mtimeMs: first.mtimeMs }), /changed/i);
  await assert.rejects(readFile(root, "large.txt", { page: -1 }), /page/i);
  await assert.rejects(readFile(root, "large.txt", { line: 0 }), /line/i);
  await assert.rejects(readFile(root, "large.txt", { line: 2, page: 1 }), /page or a line/i);
});

test("a 200 MiB text file opens one page with bounded process memory and latency", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-file-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const handle = await fs.open(path.join(root, "large.rs"), "w");
  const chunk = Buffer.from("// A large Rust fixture.\n".repeat(44000));
  for (let bytes = 0; bytes < 200 * 1024 * 1024; bytes += chunk.length) await handle.write(chunk);
  await handle.close();
  const script = `
    import { readFile } from ${JSON.stringify(new URL("./files.mts", import.meta.url).href)};
    const start = performance.now();
    const result = await readFile(process.argv[1], 'large.rs');
    console.log(JSON.stringify({ bytes: Buffer.byteLength(result.content ?? ''), preview: result.preview, ms: performance.now() - start, rssKiB: process.resourceUsage().maxRSS }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, root], {
    timeout: 10000,
  });
  const result: { bytes: number; preview: string; ms: number; rssKiB: number } = JSON.parse(stdout);
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.preview, "text");
  assert.ok(result.bytes > 0 && result.bytes <= 32768);
  assert.ok(result.ms < 200, `first page took ${result.ms} ms`);
  assert.ok(result.rssKiB < 120 * 1024, `peak RSS ${result.rssKiB} KiB exceeds the file-independent budget`);
});
