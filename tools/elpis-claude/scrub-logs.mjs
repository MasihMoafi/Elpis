#!/usr/bin/env node
// Run while log writers are stopped. No backups or credential values are emitted.
// Usage: node tools/elpis-claude/scrub-logs.mjs [--log-dir /path/to/logs]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { redactSecrets } from "./log-redaction.mjs";

export function scrubLogs(directory) {
  const report = { filesChanged: 0, secrets: {}, filesSkipped: 0, filesFailed: 0 };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { report.filesSkipped++; continue; }
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile()) { report.filesSkipped++; continue; }
      let source, staged, temporary;
      try {
        source = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const before = fs.fstatSync(source, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n) { report.filesSkipped++; continue; }
        const bytes = fs.readFileSync(source);
        let original;
        try { original = decoder.decode(bytes); } catch { report.filesSkipped++; continue; }
        if (original.includes("\0")) { report.filesSkipped++; continue; }
        const counts = {};
        const clean = redactSecrets(original, counts);
        if (clean === original) continue;
        temporary = path.join(dir, `.scrub-${randomUUID()}`);
        staged = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(staged, clean, "utf8");
        fs.fchmodSync(staged, Number(before.mode & 0o777n));
        fs.fsyncSync(staged);
        fs.closeSync(staged); staged = undefined;
        const current = fs.lstatSync(file, { bigint: true });
        if (current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1n
          || current.size !== before.size || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) {
          throw new Error("log changed during scrub");
        }
        fs.renameSync(temporary, file); temporary = undefined;
        report.filesChanged++;
        for (const [kind, count] of Object.entries(counts)) report.secrets[kind] = (report.secrets[kind] ?? 0) + count;
        const parent = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      } catch {
        report.filesFailed++;
      } finally {
        if (staged !== undefined) fs.closeSync(staged);
        if (source !== undefined) fs.closeSync(source);
        if (temporary !== undefined) fs.unlinkSync(temporary);
      }
    }
  };
  try {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("logs must be a real directory");
    walk(directory);
  } catch { report.filesFailed++; }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const valid = args.length === 0 || (args.length === 2 && args[0] === "--log-dir");
  const directory = args[1] ?? path.join(process.env.ELPIS_HOME ?? path.join(os.homedir(), ".elpis-next"), "logs");
  const report = valid ? scrubLogs(directory) : { filesChanged: 0, secrets: {}, filesSkipped: 0, filesFailed: 1 };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.filesFailed ? 1 : 0;
}
