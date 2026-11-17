import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "./files.mts";
import { convertDocx } from "./docx.mts";
import { makeDocx } from "../tests/fixtures/docx.mts";

async function document(t: import("node:test").TestContext, text = "# Agreement\n\nمتن فارسی — saved.\n") {
  const root = await fs.mkdtemp(path.join(os.homedir(), ".cache", "elpis-docx-"));
  t.after(() => promisify(execFile)("gio", ["trash", root]));
  const file = "قرارداد with spaces.DOCX", bytes = await makeDocx(text);
  await fs.writeFile(path.join(root, file), bytes);
  return { root, file, bytes };
}

test("Word preview extracts Unicode locally, refuses text writes and preserves the original container", async t => {
  const f = await document(t), read = await readFile(f.root, f.file);
  assert.equal(read.preview, "text"); assert.equal(read.format, "docx");
  assert.match(read.content!, /متن فارسی — saved/);
  assert.equal(read.pages, 1);
  await assert.rejects(writeFile(f.root, f.file, "replace ZIP with text", read.mtimeMs), /read-only/);
  assert.deepEqual(await fs.readFile(path.join(f.root, f.file)), f.bytes);
});

test("Word pages reconstruct exact extracted Unicode and reject stale revisions after replacement", async t => {
  const f = await document(t, "# Start\n\n" + "Text فارسی 日本語 🙂\n\n".repeat(3500) + "Last paragraph.\n");
  const first = await readFile(f.root, f.file);
  assert.ok(first.pages! > 1);
  let joined = first.content!;
  for (let page = 1; page < first.pages!; page++) {
    const next = await readFile(f.root, f.file, { page, mtimeMs: first.mtimeMs });
    assert.ok(next.firstLine! > 1); joined += next.content;
  }
  assert.equal(joined, (await convertDocx(f.bytes)).toString("utf8"));
  const line = await readFile(f.root, f.file, { line: 3000 });
  assert.ok(line.page! > 0); assert.ok(line.firstLine! <= 3000);
  await assert.rejects(readFile(f.root, f.file, { page: first.pages }), /Invalid file page/);
  const replacement = await makeDocx("# Changed\n\nA new saved revision.\n");
  await fs.writeFile(path.join(f.root, f.file), replacement);
  await assert.rejects(readFile(f.root, f.file, { page: 1, mtimeMs: first.mtimeMs }), /changed on disk/);
  assert.match((await readFile(f.root, f.file)).content!, /new saved revision/);
});

test("damaged, oversized and unavailable-converter documents fail clearly without becoming editable", async t => {
  const f = await document(t), target = path.join(f.root, f.file);
  await fs.writeFile(target, "This is not a Word ZIP");
  await assert.rejects(readFile(f.root, f.file), /Word document is invalid/);
  await fs.writeFile(target, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]));
  await assert.rejects(readFile(f.root, f.file), /could not be previewed/);
  await fs.truncate(target, 31 * 1024 * 1024);
  assert.equal((await readFile(f.root, f.file)).tooLarge, true);
  await assert.rejects(convertDocx(f.bytes, { command: path.join(f.root, "missing-converter") }), /Install Pandoc/);
});

test("a converter that hangs is killed before the preview request rejects", async t => {
  const f = await document(t), command = path.join(f.root, "stuck-converter");
  const pidFile = path.join(f.root, "pid");
  const program = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`;
  await fs.writeFile(command, program, { mode: 0o700 });
  await assert.rejects(convertDocx(f.bytes, { command, timeout: 500 }), /could not be previewed/);
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
