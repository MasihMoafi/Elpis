import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, open, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, sessionSettings } from "./discovery.mts";

for (const held of [false, true]) it(`reports a resumed chat once and preserves ${held ? "live process evidence" : "the newest transcript"}`, async t => {
  const home = await mkdtemp(join(tmpdir(), "router-discovery-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const folder = join(home, "sessions", "2026", "01", "01");
  await mkdir(folder, { recursive: true });
  const id = "00000000-0000-0000-0000-000000000001";
  const older = join(folder, `rollout-a-${id}.jsonl`), newer = join(folder, `rollout-b-${id}.jsonl`);
  for (const [file, cwd] of [[older, "/old"], [newer, "/new"]])
    await writeFile(file!, JSON.stringify({ type: "session_meta", payload: { id, cwd, originator: "elpis" } }) + "\n");
  await utimes(older, 1, 1);
  const handle = held ? await open(older, "r") : null;
  try {
    const rows = await listSessions({ home, elpisHome: home, claudeHome: join(home, "claude"), settings: { runtimes: ["elpis"], idleMs: 600_000 } });
    assert.equal(rows.length, 1, "one conversation is not one row per rollout file");
    assert.equal(rows[0]?.cwd, held ? "/old" : "/new");
    if (held) assert.equal(rows[0]?.state, "idle", "a held transcript is not replaced by an uncertain archived copy");
  } finally { await handle?.close(); }
});

it("keeps equal IDs in different runtimes separate and replaces all mirrored Gemini rollouts", async t => {
  const home = await mkdtemp(join(tmpdir(), "router-discovery-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const id = "00000000-0000-0000-0000-000000000001";
  for (const root of [home, join(home, ".codex")]) {
    const folder = join(root, "sessions", "2026", "01", "01");
    await mkdir(folder, { recursive: true });
    for (const suffix of ["a", "b"]) await writeFile(join(folder, `rollout-${suffix}-${id}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id, cwd: "/project", originator: "cli" } }) + "\n");
  }
  const options = { home, elpisHome: home, claudeHome: join(home, "claude"), settings: { runtimes: ["elpis", "codex"] as const, idleMs: 600_000 } };
  const first = await listSessions({ ...options, settings: { ...options.settings, runtimes: [...options.settings.runtimes] } });
  assert.deepEqual(first.map(row => row.runtime).sort(), ["codex", "elpis"]);
  await mkdir(join(home, "elpis-claude"));
  await writeFile(join(home, "elpis-claude", "sessions.json"), JSON.stringify({ [id]: { agent: "agy", model: "agy/gemini" } }));
  const next = await listSessions({ ...options, settings: { ...options.settings, runtimes: ["elpis", "codex", "gemini"] } });
  assert.deepEqual(next.map(row => row.runtime).sort(), ["codex", "gemini"]);
});

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
