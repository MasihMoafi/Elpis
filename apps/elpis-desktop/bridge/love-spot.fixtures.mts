import { createTestTempDir, removeTestTempDir } from "../tests/temp-root.cts";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { startDesktopServer } from "./server.mts";
import { createLoveSpot } from "./love-spot-store.cts";

export const FAKE_ACP_AGENT = fileURLToPath(new URL("../../../tools/elpis-claude/test/fake-acp-agent.mts", import.meta.url));

export const exec = promisify(execFile);

export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=",
  "base64",
);

export type Store = ReturnType<typeof createLoveSpot>;

export type StoreEvent = Parameters<Parameters<Store["watch"]>[0]>[0];

export type SceneResult = Awaited<ReturnType<Store["read"]>>;

export type Screenshot = ReturnType<Store["screenshotsList"]>[number];

export type SentBody = { attachments: { id: string; text: string }[] };

export const element = <T extends object = object>(id: string, version = 1, extra: T = {} as T) => ({
  id,
  type: "rectangle",
  version,
  versionNonce: 100,
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  ...extra,
});

export const eventReader = (response: Response) => {
  assert.ok(response.body);
  return response.body.getReader();
};

export async function fixture(
  t: TestContext,
  {
    loveAgents,
    prepareScreenshots,
  }: { loveAgents?: Record<string, unknown>; prepareScreenshots?: (directory: string) => Promise<unknown> } = {},
) {
  const base = path.join(os.homedir(), ".cache/elpis-tests");
  await fs.mkdir(base, { recursive: true });
  const root = createTestTempDir(path.join(base, "love-spot-"));
  const directory = path.join(root, "drawing"),
    screenshots = path.join(root, "Screenshots");
  await fs.mkdir(directory);
  await fs.mkdir(screenshots);
  await fs.writeFile(
    path.join(directory, "scene.excalidraw"),
    JSON.stringify({ type: "excalidraw", version: 2, elements: [], files: {}, appState: {} }),
  );
  if (prepareScreenshots) await prepareScreenshots(screenshots);
  const client: EventEmitter & { send?: (id: string, body: SentBody) => Promise<{ turn: { id: string } }> } =
    new EventEmitter();
  Object.assign(client, { connected: true, pendingApprovals: [], close() {} });
  const app = await startDesktopServer({
    client,
    loveSpot: { directory, screenshots },
    trashFile: path.join(root, "trash.json"),
    ...(loveAgents ? { loveAgents } : {}),
  });
  t.after(async () => {
    await app.close();
    removeTestTempDir(root);
  });
  const url = new URL(app.url),
    origin = url.origin;
  const auth = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token: url.hash.slice(7) }),
  });
  const cookie = auth.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const request = (suffix = "", data?: unknown, headers = {}) =>
    fetch(`${origin}/api/love-spot${suffix}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { cookie, origin, "content-type": "application/json", ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const load = async (): Promise<SceneResult> => {
    const reply = await request();
    assert.equal(reply.status, 200);
    return reply.json();
  };
  const save = async (scene: unknown): Promise<SceneResult> => {
    const reply = await request("", scene);
    assert.equal(reply.status, 200);
    return reply.json();
  };
  return { directory, screenshots, request, load, save, origin, client };
}

export async function screenshotFixture(t: TestContext) {
  const f = await fixture(t, {
    prepareScreenshots: screenshots => fs.writeFile(path.join(screenshots, "old.png"), PNG),
  });
  const saved = await f.save({ elements: [element("existing-image", 1, { type: "image" })], files: {} });
  await f.request("/picture", { revision: saved.revision, png: PNG.toString("base64") });
  const events: StoreEvent[] = [],
    reader = eventReader(await f.request("/events"));
  t.after(() => reader.cancel());
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (event.startsWith("data: ")) events.push(JSON.parse(event.slice(6)));
      }
    }
  })().catch(() => {});
  const tray = async (): Promise<Screenshot[]> => {
    const response = await f.request("/screenshots");
    assert.equal(response.status, 200);
    return (await response.json()).screenshots;
  };
  const wait = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 60; i++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail("screenshot watcher did not settle");
  };
  return { ...f, saved, events, tray, wait };
}
