import { createTestTempDir, removeTestTempDir } from "../tests/temp-root.cts";
import { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as exec } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { createImprovements } from "./improve.mts";
import { verifyImprovement } from "./improve-check.mts";

export const execFile = promisify(exec);

export const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=";

export const target = { id: "button", label: "Send", image: PNG };

export const map = { button: { component: "Composer", file: "button.txt" } };

export async function setup(t: TestContext, checks: boolean | typeof verifyImprovement = true) {
  const cache = path.join(os.homedir(), ".cache/elpis-tests");
  await fs.mkdir(cache, { recursive: true });
  const root = createTestTempDir(path.join(cache, "improve-"));
  t.after(async () => {
    removeTestTempDir(root);
  });
  const sourceRoot = path.join(root, "source");
  await fs.mkdir(sourceRoot);
  const git = (...args: string[]) => execFile("git", args, { cwd: sourceRoot });
  await git("init", "-q");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@invalid");
  await git("commit", "--allow-empty", "-qm", "before desktop");
  await fs.mkdir(path.join(sourceRoot, "apps/elpis-desktop"), { recursive: true });
  await fs.writeFile(
    path.join(sourceRoot, "apps/elpis-desktop/package.json"),
    JSON.stringify({ name: "elpis-desktop" }),
  );
  await fs.writeFile(path.join(sourceRoot, "button.txt"), "Send\n");
  await git("add", "button.txt", "apps/elpis-desktop/package.json");
  await git("commit", "-qm", "baseline");
  type Client = NonNullable<Parameters<typeof createImprovements>[0]>["client"];
  type CreateBody = Parameters<Client["createThread"]>[0];
  type SendBody = Parameters<Client["send"]>[1];
  let created: CreateBody | undefined, sent: { id: string; body: SendBody } | undefined;
  const client = Object.assign(new EventEmitter(), {
    models: async () => ({ data: [{ model: "gpt-6-luna" }] }),
    createThread: async (body: CreateBody) => {
      created = body;
      return { thread: { id: "fake-thread", cwd: body.cwd, status: { type: "idle" } } };
    },
    send: async (id: string, body: SendBody): Promise<unknown> => {
      sent = { id, body };
      return { turn: { id: "turn" } };
    },
  });
  const store = path.join(root, "state");
  const manager = await createImprovements({
    client,
    sourceRoot,
    stateDir: store,
    sourceMap: map,
    verify:
      typeof checks === "function"
        ? checks
        : async () => ({
            passed: checks,
            commands: [{ command: "fixture tests", code: checks ? 0 : 1, output: "fixture result" }],
          }),
  });
  t.after(() => manager.close());
  return {
    manager,
    client,
    git,
    sourceRoot,
    store,
    created: () => {
      assert.ok(created);
      return created;
    },
    createdOptional: () => created,
    sent: () => {
      assert.ok(sent);
      return sent;
    },
  };
}

export async function checkFixture(t: TestContext, scenario: { fail?: string; hang?: string } = {}) {
  const root = createTestTempDir(path.join(os.tmpdir(), "improve-check-"));
  t.after(() => removeTestTempDir(root));
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  const script = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
process.chdir(process.env.IMPROVE_CHECK_FIXTURE);
const step = path.basename(process.argv[1]) === 'npx' ? 'typecheck' : process.argv.at(-1);
const scenario = JSON.parse(fs.readFileSync('scenario.json'));
fs.appendFileSync('ran.txt', step + '\\n');
console.log('running ' + step);
if (step === scenario.fail) { console.error('planted assertion failed'); process.exit(7); }
if (step === scenario.hang) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 1600)'], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.writeFileSync('child.pid', String(child.pid));
  process.exit(0);
}
`;
  for (const name of ["npx", "npm"]) await fs.writeFile(path.join(bin, name), script, { mode: 0o755 });
  await fs.writeFile(path.join(root, "scenario.json"), JSON.stringify(scenario));
  return { root, env: { ...process.env, IMPROVE_CHECK_FIXTURE: root, PATH: `${bin}:${process.env.PATH}` } };
}
