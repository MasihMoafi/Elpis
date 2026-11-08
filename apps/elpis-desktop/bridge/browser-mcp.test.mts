import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browserMcpConfig, handleMcp, callBrowser } from "./browser-mcp.mts";
type Result = { page: string; session: string };
type Response = {
  result: { protocolVersion: string; tools: { name: string }[]; content: { text: string }[]; isError: boolean };
  error: { code: number };
};
const browserResult = async (value: Promise<unknown>) => (await value) as Result;
const response = async (value: ReturnType<typeof handleMcp>) => (await value) as Response;
const { startBrowserAgentSocket } = createRequire(import.meta.url)("../desktop/browser-agent.cts");

test("socket capabilities bind concurrent calls to their own session and reject missing or foreign scopes", async () => {
  const endpoint = await startBrowserAgentSocket();
  try {
    const agents = new Map([
      ["a", { call: async () => ({ page: "A" }) }],
      ["b", { call: async () => ({ page: "B" }) }],
    ]);
    endpoint.setResolver((id: string) => agents.get(id));
    const a = endpoint.scope("a"),
      b = endpoint.scope("b");
    assert.notEqual(a, b);
    assert.deepEqual(
      await Promise.all([
        callBrowser(endpoint.path, "browser_tabs", {}, a),
        callBrowser(endpoint.path, "browser_tabs", {}, b),
      ]),
      [{ page: "A" }, { page: "B" }],
    );
    await assert.rejects(callBrowser(endpoint.path, "browser_tabs", {}), /session|capability/i);
    await assert.rejects(callBrowser(endpoint.path, "browser_tabs", {}, "guessed-token"), /session|capability/i);
    endpoint.rebind("a", "created-thread");
    agents.set("created-thread", agents.get("a")!);
    assert.equal((await browserResult(callBrowser(endpoint.path, "browser_tabs", {}, a))).page, "A");
    endpoint.revoke("created-thread");
    await assert.rejects(callBrowser(endpoint.path, "browser_tabs", {}, a), /session|capability/i);
    assert.equal((await browserResult(callBrowser(endpoint.path, "browser_tabs", {}, b))).page, "B");
  } finally {
    await endpoint.close();
  }
});

test("private reconnect record retains capabilities and host metadata isolates inherited MCP connections", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "browser-reconnect-")),
    connectionFile = path.join(root, "connection.json");
  let endpoint = await startBrowserAgentSocket({ connectionFile });
  const capability = endpoint.scope("parent");
  endpoint.rebind("parent", "actual-parent");
  await endpoint.close();
  endpoint = await startBrowserAgentSocket({ connectionFile });
  try {
    assert.equal((await fs.stat(connectionFile)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await fs.readFile(connectionFile, "utf8")).socketPath, endpoint.path);
    assert.equal(endpoint.scope("actual-parent"), capability);
    endpoint.setResolver((id: string) => ({ call: async () => ({ session: id }) }));
    assert.equal(
      (await browserResult(callBrowser(endpoint.path, "browser_tabs", {}, capability))).session,
      "actual-parent",
    );
    assert.equal(
      (await browserResult(callBrowser(endpoint.path, "browser_tabs", {}, capability, "child"))).session,
      "child",
    );
    assert.equal(
      (
        await browserResult(
          callBrowser(endpoint.path, "browser_tabs", { sessionId: "foreign" }, capability, "actual-parent"),
        )
      ).session,
      "actual-parent",
      "tool arguments do not route the call",
    );
  } finally {
    await endpoint.close();
  }
});

test("MCP returns screenshots as images and failures as tool errors", async () => {
  assert.equal((await response(handleMcp(null, async () => {}))).error.code, -32600);
  const image = { content: [{ type: "image", mimeType: "image/jpeg", data: "anBlZw==" }] };
  const request = { id: 2, method: "tools/call", params: { name: "browser_screenshot", arguments: { tabId: "one" } } };
  assert.deepEqual((await response(handleMcp(request, async () => image))).result, image);
  assert.equal(
    (
      await response(
        handleMcp(request, async () => {
          throw Error("taken over");
        }),
      )
    ).result.isError,
    true,
  );
  assert.equal(
    (await response(handleMcp({ id: 3, method: "tools/call", params: { name: "unknown" } }, async () => {}))).result
      .isError,
    true,
  );
});

test("stdio MCP initializes, forwards tools over the socket, and fails closed when disconnected", async () => {
  const endpoint = await startBrowserAgentSocket();
  endpoint.setResolver(() => ({ call: async (name: string, args: unknown) => ({ name, args }) }));
  const capability = endpoint.scope("fixture");
  const config = browserMcpConfig(endpoint.path, process.execPath, capability)["mcp_servers.elpis_browser"];
  assert.equal(config.command, process.execPath);
  assert.equal(config.env.ELPIS_BROWSER_SOCKET, endpoint.path);
  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (value: Response) => void>();
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const value = JSON.parse(line);
    pending.get(value.id)?.(value);
    pending.delete(value.id);
  });
  const rpc = (method: string, params?: unknown) =>
    new Promise<Response>(resolve => {
      const id = ++nextId;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.ok((await rpc("tools/list")).result.tools.some(tool => tool.name === "document_read"));
    const call = await rpc("tools/call", {
      name: "browser_open",
      arguments: { url: "https://example.com" },
      _meta: { threadId: "fixture" },
    });
    assert.equal(JSON.parse(call.result.content[0]!.text).name, "browser_open");
    endpoint.setDocuments(async (id: string, name: string, args: { path: string }) => ({
      thread: id,
      name,
      path: args.path,
      ...(name === "document_read" ? { content: "Saved text — متن فارسی" } : {}),
    }));
    const document = await rpc("tools/call", {
      name: "document_open",
      arguments: { path: "/tmp/draft.md" },
      _meta: { threadId: "child" },
    });
    assert.deepEqual(JSON.parse(document.result.content[0]!.text), {
      thread: "child",
      name: "document_open",
      path: "/tmp/draft.md",
    });
    const read = await rpc("tools/call", {
      name: "document_read",
      arguments: { path: "/tmp/draft.md" },
      _meta: { threadId: "child" },
    });
    assert.equal(JSON.parse(read.result.content[0]!.text).content, "Saved text — متن فارسی");
    const image = {
      content: [{ type: "image", mimeType: "image/jpeg", data: Buffer.from("external page").toString("base64") }],
    };
    endpoint.setScreenCapture(async (id: string, name: string, args: unknown) => {
      assert.equal(id, "fixture");
      assert.equal(name, "screen_screenshot");
      assert.deepEqual(args, {});
      return image;
    });
    assert.deepEqual(
      (await rpc("tools/call", { name: "screen_screenshot", arguments: {}, _meta: { threadId: "fixture" } })).result,
      image,
    );
    await assert.rejects(
      callBrowser(endpoint.path, "screen_screenshot", {}, "foreign-screenshot-token"),
      /capability/i,
    );
    endpoint.setResolver(() => null);
    assert.equal(
      (await rpc("tools/call", { name: "browser_tabs", arguments: {}, _meta: { threadId: "fixture" } })).result.isError,
      true,
    );
  } finally {
    child.stdin.end();
    child.kill();
    lines.close();
    await endpoint.close();
  }
  await assert.rejects(callBrowser(endpoint.path, "browser_tabs", {}));
});
