import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, sessionSettings } from "./discovery.mts";

it("discovers Gemini ACP sessions and keeps missing process evidence distinct from idle", async t => {
  const home = await mkdtemp(join(tmpdir(), "router-discovery-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "elpis-claude"));
  await writeFile(
    join(home, "elpis-claude", "sessions.json"),
    JSON.stringify({
      active: {
        agent: "agy",
        model: "agy/gemini",
        active: { pid: process.pid, startedAt: Math.floor(Date.now() / 1000), cwd: "/project" },
      },
      saved: { agent: "agy", model: "agy/gemini", turns: [{ completedAt: 1 }] },
      ignored: { agent: "claude", model: "claude/sonnet" },
      _default: { model: "agy/gemini" },
    }),
  );
  const rows = await listSessions({
    home,
    elpisHome: home,
    claudeHome: join(home, "claude"),
    settings: { runtimes: ["gemini"], idleMs: 600_000 },
  });
  assert.deepEqual(
    rows.map(row => row.id),
    ["active", "saved"],
  );
  assert.equal(rows[0]?.state, "live");
  assert.equal(rows[0]?.cwd, "/project");
  assert.equal(rows[1]?.state, "unreachable");
  assert.ok((await sessionSettings(home)).runtimes.includes("gemini"));
});
