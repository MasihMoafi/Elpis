import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractZip } from "./attachment-zip.mts";

const workspace = () => fs.mkdtempSync(path.join(os.homedir(), ".cache/elpis-tests/zip-"));
const upload = (file: string, name = "project.zip") => ({
  name,
  mimeType: "application/zip",
  dataUrl: `data:application/zip;base64,${fs.readFileSync(file).toString("base64")}`,
});

test("a zip is unpacked into its own folder and the message names the path and files", async () => {
  const dir = workspace();
  fs.mkdirSync(path.join(dir, "src/deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/deep/a.txt"), "hello");
  execFileSync("zip", ["-qr", "p.zip", "src"], { cwd: dir });
  const { attachment } = await extractZip(upload(path.join(dir, "p.zip")), { root: path.join(dir, "out") });
  const folder = attachment.text.match(/unpacked to: (.+)/)?.[1] as string;
  assert.equal(fs.readFileSync(path.join(folder, "src/deep/a.txt"), "utf8"), "hello");
  assert.match(attachment.text, /1 files:\nsrc\/deep\/a\.txt/);
  assert.equal(attachment.name, "project.zip");
  fs.rmSync(dir, { recursive: true });
});

test("a zip with a symbolic link is refused and leaves nothing behind", async () => {
  const dir = workspace();
  fs.symlinkSync("/etc/passwd", path.join(dir, "link"));
  execFileSync("zip", ["-qy", "p.zip", "link"], { cwd: dir });
  const root = path.join(dir, "out");
  await assert.rejects(extractZip(upload(path.join(dir, "p.zip")), { root }), /symbolic links/);
  assert.deepEqual(fs.readdirSync(root), []);
  fs.rmSync(dir, { recursive: true });
});

test("something that is not a zip is refused", async () => {
  const dir = workspace();
  fs.writeFileSync(path.join(dir, "p.zip"), "not a zip at all");
  await assert.rejects(extractZip(upload(path.join(dir, "p.zip")), { root: path.join(dir, "out") }), /not a zip/);
  fs.rmSync(dir, { recursive: true });
});
