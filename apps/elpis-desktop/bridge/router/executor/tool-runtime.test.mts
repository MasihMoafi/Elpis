import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { z } from "zod";
import { ExecutorStore } from "./store.mts";
import { ToolRuntime, type McpRuntime } from "./tool-runtime.mts";
import { tool as defineTool } from "../app/tools/tool.mts";
import { key } from "../core/index.mts";

function client(config: McpRuntime, capability = config.env.ELPIS_MOTHER_CAPABILITY) {
  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env, ELPIS_MOTHER_CAPABILITY: capability },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  const lines = createInterface({ input: child.stdout });
  let sequence = 0,
    errors = "";
  child.stderr.on("data", chunk => {
    errors += String(chunk);
  });
  lines.on("line", line => {
    const value = z.record(z.string(), z.unknown()).parse(JSON.parse(line));
    if (typeof value.id === "number") {
      pending.get(value.id)?.(value);
      pending.delete(value.id);
    }
  });
  return {
    child,
    errors: () => errors,
    call(method: string, params: object = {}) {
      const id = ++sequence;
      return new Promise<Record<string, unknown>>(resolve => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = once(child, "exit");
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      await done;
      clearTimeout(timer);
    },
  };
}

test(
  "ACP stdio tools validate scope and arguments, carry images, and recover the same session capability",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mother-tools-")),
      store = new ExecutorStore(dir);
    const lifetime = new AbortController();
    let allowed = true,
      calls = 0;
    const tool = defineTool({
      name: "orchestrator_probe",
      description: "Read scoped evidence",
      schema: z.object({ value: z.string() }).strict(),
      execute: async ({ value }) => {
        calls++;
        return value === "image" ? { image_url: "data:image/png;base64,aGVsbG8=" } : { evidence: value };
      },
    });
    let runtime = new ToolRuntime(store, dir),
      connection: ReturnType<typeof client> | undefined,
      foreign: ReturnType<typeof client> | undefined;
    try {
      const config = await runtime.transport("worker-ticket", [tool]);
      runtime.bind("worker-ticket", {
        tools: () => [tool],
        instructions: () => "",
        signal: lifetime.signal,
        authorize: () => {
          if (!allowed) throw new Error("Ticket ended");
        },
      });
      connection = client(config);
      foreign = client(config, "wrong-capability");
      assert.equal((await connection.call("initialize", { protocolVersion: "2024-11-05" })).error, undefined);
      assert.match(JSON.stringify(await connection.call("tools/list")), /orchestrator_probe/);
      assert.match(JSON.stringify(await foreign.call("tools/list")), /unavailable/);
      assert.match(
        JSON.stringify(await connection.call("tools/call", { name: tool.name, arguments: { value: "read" } })),
        /evidence/,
      );
      assert.match(
        JSON.stringify(await connection.call("tools/call", { name: tool.name, arguments: { value: "image" } })),
        /"type":"image"/,
      );
      assert.match(
        JSON.stringify(await connection.call("tools/call", { name: tool.name, arguments: { value: 3 } })),
        /"isError":true/,
      );
      assert.match(JSON.stringify(await connection.call("tools/call", { name: "another-role-tool" })), /unavailable/);
      allowed = false;
      assert.match(
        JSON.stringify(await connection.call("tools/call", { name: tool.name, arguments: { value: "read" } })),
        /Ticket ended/,
      );
      assert.equal(calls, 2);
      await connection.close();
      connection = undefined;
      await foreign.close();
      foreign = undefined;
      await runtime.close();
      runtime = new ToolRuntime(store, dir);
      assert.deepEqual(await runtime.transport("worker-ticket", [tool]), config);
    } finally {
      lifetime.abort();
      await connection?.close();
      await foreign?.close();
      await runtime.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("refusing a foreign IPC file also preserves it during shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mother-tools-foreign-")),
    store = new ExecutorStore(dir);
  const directory = join(tmpdir(), `elpis-mother-${key(dir)}`),
    socket = join(directory, "tools.sock");
  const runtime = new ToolRuntime(store, dir);
  try {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(socket, "Operator-owned file");
    await assert.rejects(runtime.transport("main", []), /another file/);
    await runtime.close();
    assert.equal(await readFile(socket, "utf8"), "Operator-owned file");
  } finally {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
