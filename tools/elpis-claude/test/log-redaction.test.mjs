import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { appendLog, redactSecrets, redactedLines } from "../log-redaction.mjs";

const fixtures = JSON.parse(fs.readFileSync(new URL("./fixtures/log-secrets.json", import.meta.url), "utf8"));

test("scrub command atomically rewrites a log copy, preserves JSON and skips links", t => {
  const cache = path.join(os.homedir(), ".cache/elpis-tests");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "secret-scrub-"));
  t.after(() => assert.equal(spawnSync("gio", ["trash", root]).status, 0));
  const logs = path.join(root, "logs");
  fs.mkdirSync(path.join(logs, "smart-prune/attempts"), { recursive: true });
  const file = path.join(logs, "smart-prune/attempts/attempt.json");
  const payload = '{ "integer": 900719925474099312345, "text": ' + JSON.stringify(fixtures.map(f => f.input).join("\n")) + ' }\n';
  fs.writeFileSync(file, payload, { mode: 0o640 });
  fs.writeFileSync(path.join(logs, "events.jsonl"), fixtures.map(f => JSON.stringify({ output: f.input })).join("\r\n"));
  const outside = path.join(root, "outside.log");
  fs.writeFileSync(outside, fixtures[0].input);
  fs.symlinkSync(outside, path.join(logs, "symlink.log"));
  fs.linkSync(outside, path.join(logs, "hardlink.log"));
  fs.symlinkSync(root, path.join(logs, "linked-directory"));
  fs.writeFileSync(path.join(logs, "binary"), Buffer.from([0, 255, 128]));
  const before = fs.statSync(file);
  const names = fs.readdirSync(logs, { recursive: true }).sort();
  const run = () => spawnSync(process.execPath, [new URL("../scrub-logs.mjs", import.meta.url).pathname, "--log-dir", logs], { encoding: "utf8" });
  const first = run();
  assert.ok(first.status === 0, "scrub succeeds without printing credential values");
  const report = JSON.parse(first.stdout);
  assert.equal(first.stderr, "");
  assert.equal(report.filesChanged, 2);
  assert.equal(report.filesSkipped, 4);
  assert.equal(report.filesFailed, 0);
  assert.deepEqual(Object.keys(report.secrets).sort(), ["anthropic", "aws", "bearer", "env", "github", "google", "openai", "openrouter", "x-api-key"].sort());
  assert.ok(Object.values(report.secrets).every(count => Number.isInteger(count) && count > 0));
  assert.ok(fs.statSync(file).ino !== before.ino, "replacement uses a new inode");
  assert.equal(fs.statSync(file).mode & 0o777, before.mode & 0o777);
  assert.ok(fs.readFileSync(file, "utf8").includes('"integer": 900719925474099312345'), "integer bytes survive");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).text, fixtures.map(f => f.expected).join("\n"));
  const lines = fs.readFileSync(path.join(logs, "events.jsonl"), "utf8").split("\r\n");
  lines.forEach((line, index) => assert.ok(JSON.parse(line).output === fixtures[index].expected, `JSONL fixture ${index}`));
  assert.ok(fs.readFileSync(outside, "utf8") === fixtures[0].input, "outside file untouched");
  assert.deepEqual(fs.readdirSync(logs, { recursive: true }).sort(), names, "names retained; no temporary files");
  const after = fs.statSync(file);
  const second = run();
  assert.equal(second.status, 0);
  assert.equal(JSON.parse(second.stdout).filesChanged, 0);
  assert.deepEqual(JSON.parse(second.stdout).secrets, {});
  assert.equal(fs.statSync(file).mtimeMs, after.mtimeMs);
});

test("redaction policy covers credentials and preserves ordinary text", () => {
  for (const [index, { input, expected }] of fixtures.entries()) {
    assert.ok(redactSecrets(input) === expected, `fixture ${index}`);
    const counts = {};
    assert.ok(redactSecrets(expected, counts) === expected, `fixture ${index} is idempotent`);
    assert.deepEqual(counts, {});
  }
});

test("stderr redaction handles split UTF-8, split keys, EOF and oversized lines", async () => {
  const stream = new PassThrough(), lines = [];
  redactedLines(stream, line => lines.push(line));
  const complete = once(stream, "end");
  const body = Buffer.from(`سلام ${fixtures[0].input}\r\nKEY=${"x".repeat(70_000)}\nordinary last line`);
  for (const byte of body) stream.write(Buffer.from([byte]));
  stream.end();
  await complete;
  assert.deepEqual(lines, [`سلام ${fixtures[0].expected}`, "[redacted:oversize]", "ordinary last line"]);
});

test("real log append stores only redacted text without changing its input", t => {
  const cache = path.join(os.homedir(), ".cache/elpis-tests");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "secret-writer-"));
  t.after(() => assert.equal(spawnSync("gio", ["trash", root]).status, 0));
  const file = path.join(root, "bridge.log");
  for (const [index, { input, expected }] of fixtures.entries()) {
    fs.writeFileSync(file, "");
    appendLog(file, input);
    assert.ok(fs.readFileSync(file, "utf8").slice(13) === `${expected}\n`, `stored fixture ${index}`);
    assert.ok(input === fixtures[index].input, "caller text is unchanged");
  }
});
