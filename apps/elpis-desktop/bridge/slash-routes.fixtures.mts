import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopClient } from "./client.mts";

export const CHAT = "00000000-0000-0000-0000-0000000000a1";

export const AGENT = "00000000-0000-0000-0000-0000000000a2";

export type WireRequest = {
  id?: number;
  method: string;
  params: { threadId: string; turnId: string; serviceTier: string | null; [key: string]: unknown };
};

export type FixtureOptions = {
  cwd?: string;
  items?: unknown[];
  provider?: string;
  serviceTier?: string | null;
  supportsFast?: boolean;
  refuseTier?: boolean;
  active?: boolean;
  finishOnTierUpdate?: boolean;
  liveTierError?: string | null;
};

export type TestThread = {
  id: string;
  cwd?: string | undefined;
  source: string | { subAgent: { thread_spawn: { agent_path: string } } };
  canAcceptDirectInput: boolean;
  status: { type: string };
};

export function required<T>(value: T | null | undefined): T {
  assert.ok(value);
  return value;
}

export function fixture({
  cwd,
  items = [],
  provider = "openai",
  serviceTier = null,
  supportsFast = true,
  refuseTier = false,
  active = false,
  finishOnTierUpdate = false,
  liveTierError = null,
}: FixtureOptions = {}) {
  let activeTurnId = active ? "active-turn" : null,
    activeServiceTier = serviceTier;
  const threads = new Map<string, TestThread>([
    [CHAT, { id: CHAT, cwd, source: "cli", canAcceptDirectInput: true, status: { type: active ? "active" : "idle" } }],
    [
      AGENT,
      {
        id: AGENT,
        cwd,
        source: { subAgent: { thread_spawn: { agent_path: "/root/helper" } } },
        canAcceptDirectInput: false,
        status: { type: "idle" },
      },
    ],
  ]);
  const socket = new EventEmitter() as EventEmitter & {
    sent: WireRequest[];
    close: () => boolean;
    send: (raw: string) => void;
  };
  socket.sent = [];
  socket.close = () => socket.emit("close");
  socket.send = raw => {
    const request = JSON.parse(raw) as WireRequest;
    socket.sent.push(request);
    if (request.id === undefined || !request.method) return;
    let result;
    switch (request.method) {
      case "initialize":
        result = { userAgent: "slash-test" };
        break;
      case "thread/read":
        result = { thread: structuredClone(threads.get(request.params.threadId)) };
        break;
      case "thread/resume":
        result = {
          thread: structuredClone(threads.get(request.params.threadId)),
          model: "gpt-6-luna",
          modelProvider: provider,
          serviceTier,
        };
        break;
      case "model/list":
        result = {
          data: [{ model: "gpt-6-luna", serviceTiers: supportsFast ? [{ id: "priority", name: "Fast" }] : [] }],
          nextCursor: null,
        };
        break;
      case "thread/settings/update":
        if (!refuseTier) serviceTier = request.params.serviceTier;
        if (finishOnTierUpdate) {
          activeTurnId = null;
          required(threads.get(CHAT)).status = { type: "idle" };
        }
        result = {};
        break;
      case "thread/turns/list":
        result = { data: activeTurnId ? [{ id: activeTurnId, status: "inProgress" }] : [], nextCursor: null };
        break;
      case "turn/settings/update":
        if (liveTierError) {
          queueMicrotask(() =>
            socket.emit("message", JSON.stringify({ id: request.id, error: { code: -32600, message: liveTierError } })),
          );
          return;
        }
        if (request.params.turnId !== activeTurnId) result = { status: "targetUnavailable" };
        else {
          activeServiceTier = request.params.serviceTier;
          result = { status: "applied" };
        }
        break;
      case "thread/compact/start":
        result = {};
        break;
      case "thread/items/list":
        result = { data: items.map(item => ({ turnId: "turn-1", item })), nextCursor: null };
        break;
      case "review/start":
        result = {
          turn: { id: "review-turn", status: "inProgress", items: [] },
          reviewThreadId: request.params.threadId,
        };
        break;
      default:
        throw new Error(`Unexpected protocol method ${request.method}`);
    }
    queueMicrotask(() => socket.emit("message", JSON.stringify({ id: request.id, result })));
  };
  const client = new DesktopClient(socket);
  const calls = (method: string) => socket.sent.filter(message => message.method === method);
  return { client, socket, threads, calls, tiers: () => ({ saved: serviceTier, active: activeServiceTier }) };
}

export const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } },
  );

export async function repository() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-slash-git-"));
  git(dir, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first commit");
  git(dir, "switch", "-q", "-c", "feature");
  await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
  git(dir, "commit", "-q", "-am", "second commit");
  await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree-uncommitted\n");
  await fs.writeFile(path.join(dir, "b.txt"), "brand-new-untracked\n");
  return dir;
}
