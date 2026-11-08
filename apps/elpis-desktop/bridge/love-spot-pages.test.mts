import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLoveSpot } from "./love-spot-store.cts";
import { PNG, element, fixture } from "./love-spot.fixtures.mts";
import type { StoreEvent } from "./love-spot.fixtures.mts";

for (const barrier of ["owner-read", "owner-unlink", "empty-claim"])
  test(`a stale lock waiter cannot reap its live successor after ${barrier}`, { timeout: 15000 }, async t => {
    const f = await fixture(t),
      module = fileURLToPath(new URL("./love-spot-store.cts", import.meta.url));
    const script = `
    const fs = require('node:fs/promises'), [directory, role, barrier] = process.argv.slice(1);
    const { createLoveSpot } = require(${JSON.stringify(module)});
    const proceed = new Promise(resolve => process.once('message', resolve));
    const read = fs.readFile, write = fs.writeFile, unlink = fs.unlink, open = fs.open, kill = process.kill;
    let held = false;
    fs.open = async (...args) => {
      if (barrier === 'empty-claim' && args[1] === 'wx' && String(args[0]).endsWith('/owner') && role === 'waiter' && !held) {
        held = true; process.send('before-claim'); await proceed;
      }
      const handle = await open(...args);
      if (barrier === 'empty-claim' && args[1] === 'wx' && String(args[0]).endsWith('/owner') && role === 'successor' && !held) {
        held = true; process.send('owns'); await proceed;
      }
      return handle;
    };
    fs.readFile = async (...args) => {
      const value = await read(...args);
      if (role === 'waiter' && barrier === 'owner-read' && String(args[0]).endsWith('/owner') && !held) {
        held = true; process.send('read-old'); await proceed;
      }
      return value;
    };
    fs.writeFile = async (...args) => {
      const result = await write(...args);
      if (String(args[0]).endsWith('/.scene-lock/owner')) {
        process.send('owns');
        if (['first', 'successor'].includes(role) && !held) { held = true; await proceed; }
      }
      return result;
    };
    fs.unlink = async (...args) => {
      if (role === 'waiter' && barrier === 'owner-unlink' && String(args[0]).endsWith('/owner') && !held) {
        held = true; process.send('before-unlink'); await proceed;
      }
      return unlink(...args);
    };
    process.kill = (...args) => { const result = kill(...args); process.send('probed-live'); return result; };
    createLoveSpot({ directory }).save({ elements: [{ id: role, type: 'rectangle', version: 1, versionNonce: 0, x: 0, y: 0, width: 10, height: 10 }], files: {} })
      .then(() => process.disconnect()).catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
  `;
    const worker = (role: string) => {
      const child = spawn(process.execPath, ["-e", script, f.directory, role, barrier], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const messages: string[] = [];
      let stderr = "";
      child.on("message", value => {
        if (typeof value === "string") messages.push(value);
      });
      assert.ok(child.stderr);
      child.stderr.on("data", data => {
        stderr += data;
      });
      const exit = new Promise<{ code: number | null; stderr: string }>(resolve =>
        child.once("exit", code => resolve({ code, stderr })),
      );
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      const wait = async (choices: string[]) => {
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          const message = messages.find(value => choices.includes(value));
          if (message) return message;
          if (child.exitCode !== null) throw Error(`Lock worker ${role} exited: ${stderr}`);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw Error(`Lock worker ${role} did not report ${choices}`);
      };
      return { child, exit, wait };
    };
    const first = worker("first");
    await first.wait(["owns"]);
    let waiter;
    if (barrier === "owner-read") {
      waiter = worker("waiter");
      await waiter.wait(["read-old"]);
      first.child.send("continue");
      assert.equal((await first.exit).code, 0);
    } else {
      first.child.send("continue");
      assert.equal((await first.exit).code, 0);
      const lock = path.join(f.directory, ".scene-lock");
      await fs.mkdir(lock);
      if (barrier === "owner-unlink") await fs.writeFile(path.join(lock, "owner"), String(first.child.pid));
      else {
        const old = new Date(Date.now() - 31000);
        await fs.utimes(lock, old, old);
      }
      waiter = worker("waiter");
      await waiter.wait([barrier === "owner-unlink" ? "before-unlink" : "before-claim"]);
      if (barrier === "owner-unlink") {
        const cleaner = worker("cleaner");
        assert.equal((await cleaner.exit).code, 0);
      }
    }
    const successor = worker("successor");
    await successor.wait(["owns"]);
    waiter.child.send("continue");
    assert.equal(
      await waiter.wait(["owns", "probed-live"]),
      "probed-live",
      "a stale PID observation must not steal a live successor lock",
    );
    if (barrier === "empty-claim")
      assert.equal(
        await fs.readFile(path.join(f.directory, ".scene-lock/owner"), "utf8"),
        "",
        "a failed claimant must leave the winning claim intact",
      );
    successor.child.send("continue");
    for (const result of await Promise.all([successor.exit, waiter.exit])) assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      (await f.load()).scene.elements.map(e => e.id).sort(),
      barrier === "owner-unlink" ? ["cleaner", "first", "successor", "waiter"] : ["first", "successor", "waiter"],
    );
  });

test(
  "empty locks retain their grace and busy timeout, then recover without losing saved elements",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t),
      lock = path.join(f.directory, ".scene-lock");
    await f.save({ elements: [element("kept")], files: {} });
    await fs.mkdir(lock);
    const store = createLoveSpot({ directory: f.directory, screenshots: f.screenshots }),
      started = Date.now();
    await assert.rejects(
      store.save({ elements: [element("pending")], files: {} }),
      error =>
        error instanceof Error && "status" in error && error.status === 503 && /drawing is busy/.test(error.message),
    );
    assert.ok(Date.now() - started >= 5000, "a fresh empty lock keeps the existing five-second timeout");
    assert.deepEqual(
      (await f.load()).scene.elements.map(e => e.id),
      ["kept"],
    );
    const old = new Date(Date.now() - 31000);
    await fs.utimes(lock, old, old);
    await store.save({ elements: [element("pending")], files: {} });
    assert.deepEqual((await f.load()).scene.elements.map(e => e.id).sort(), ["kept", "pending"]);
    await assert.rejects(fs.access(lock), { code: "ENOENT" });
  },
);

// 19 Oct 17:11: a crash between creating the owner file and writing its pid left it empty. Number('') is 0, and
// process.kill(0, 0) succeeds, so the lock looked owned forever and every save said "The drawing is busy".
test("a lock whose owner file is empty is recovered after the same grace", { timeout: 15000 }, async t => {
  const f = await fixture(t),
    lock = path.join(f.directory, ".scene-lock");
  await f.save({ elements: [element("kept")], files: {} });
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, "owner"), "");
  const old = new Date(Date.now() - 31000);
  await fs.utimes(path.join(lock, "owner"), old, old);
  await fs.utimes(lock, old, old);
  const store = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  await store.save({ elements: [element("pending")], files: {} });
  assert.deepEqual((await f.load()).scene.elements.map(e => e.id).sort(), ["kept", "pending"]);
  await assert.rejects(fs.access(lock), { code: "ENOENT" });
});

test("Love Spot watcher does not reread an unchanged drawing and delivers external replacements", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "love-watcher-"));
  const directory = path.join(root, "drawing"),
    screenshots = path.join(root, "Screenshots");
  await fs.mkdir(screenshots);
  const store = createLoveSpot({ directory, screenshots }),
    events: StoreEvent[] = [];
  t.after(async () => {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await store.save({ elements: [element("large", 1, { text: "x".repeat(2_000_000) })], files: {} });
  const file = path.join(directory, "scene.excalidraw");
  let reads = 0;
  t.mock.method(
    fs,
    "readFile",
    new Proxy(fs.readFile, {
      apply(target, receiver, args) {
        if (args[0] === file) reads++;
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  await store.watch(event => events.push(event));
  await new Promise(resolve => setTimeout(resolve, 350));
  const settled = reads;
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(reads, settled, "idle ticks must stat without reading or hashing the drawing");
  await fs.writeFile(`${file}.replacement`, JSON.stringify({ elements: [element("external")], files: {} }));
  await fs.rename(`${file}.replacement`, file);
  for (
    let i = 0;
    i < 30 && !events.some(e => e.type === "scene" && e.scene.elements.some(e => e.id === "external"));
    i++
  )
    await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(events.some(e => e.type === "scene" && e.scene.elements.some(e => e.id === "external")));
  assert.equal(reads, settled + 1, "one changed file needs one read");
});

test("the page list is in one stable order, newest number first, whatever was edited last", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.directory, "pages"), { recursive: true });
  for (const [index, name] of ["Page 8", "Page 12", "Page 9", "Page 11", "Page 10"].entries()) {
    const file = path.join(f.directory, "pages", `${name}.excalidraw`);
    await fs.writeFile(file, JSON.stringify({ elements: [], files: {} }));
    await fs.utimes(file, new Date(2026, 9, 22, 8, index), new Date(2026, 9, 22, 8, index)); // touched in an order unlike their numbers
  }
  const names = (await (await f.request("/pages")).json()).pages
    .map((page: { name: string }) => page.name)
    .filter((name: string) => name.startsWith("Page "));
  assert.deepEqual(names, ["Page 12", "Page 11", "Page 10", "Page 9", "Page 8"]);
});

test("Love Spot pages discover archives, preserve drawings, rename, and reject delayed saves across switches", async t => {
  const f = await fixture(t),
    first = await f.save({ elements: [element("original")], files: {} });
  await fs.mkdir(path.join(f.directory, "pages"), { recursive: true });
  await fs.writeFile(
    path.join(f.directory, "pages", "2026-10-18-morning.excalidraw"),
    JSON.stringify({ elements: [element("archived")], files: {} }),
  );
  const listing = await f.request("/pages");
  assert.equal(listing.status, 200);
  assert.ok(
    (await listing.json()).pages.some(
      (p: { name: string; modified: number }) => p.name === "2026-10-18-morning" && Number.isFinite(p.modified),
    ),
  );
  const store = createLoveSpot({ directory: f.directory, screenshots: f.screenshots }),
    events: StoreEvent[] = [];
  t.after(() => store.close());
  await store.watch(e => events.push(e));
  const created = await f.request("/pages", { action: "new", name: "Ideas", page: first.scene.page });
  assert.equal(created.status, 200);
  const fresh = await created.json();
  assert.deepEqual(fresh.scene.elements, []);
  assert.equal(fresh.scene.page.name, "Ideas");
  assert.equal((await f.request("", first.scene)).status, 409, "a delayed old-window save must never mix pages");
  await f.save({ ...fresh.scene, elements: [element("new-page")] });
  assert.equal(
    (await f.request("/pages", { action: "rename", name: "Ideas renamed", page: fresh.scene.page })).status,
    200,
  );
  assert.ok((await fs.readdir(path.join(f.directory, "pages"))).includes("Ideas renamed.excalidraw"));
  assert.ok(!(await fs.readdir(path.join(f.directory, "pages"))).includes("Ideas.excalidraw"));
  const archive = await f.request("/pages", { action: "switch", name: "2026-10-18-morning" });
  assert.equal(archive.status, 200);
  assert.equal((await archive.json()).scene.elements[0].id, "archived");
  for (let i = 0; i < 30 && !events.some(e => e.type === "scene" && e.scene.page?.name === "2026-10-18-morning"); i++)
    await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(
    events.some(e => e.type === "scene" && e.scene.page?.name === "2026-10-18-morning"),
    "another store process sees the page switch",
  );
  const original = await f.request("/pages", { action: "switch", name: first.scene.page.name });
  assert.equal((await original.json()).scene.elements[0].id, "original");
  assert.equal(
    (await f.request("", first.scene)).status,
    409,
    "returning to the same page still rejects an earlier visit",
  );
  const renamed = await f.request("/pages", { action: "switch", name: "Ideas renamed" });
  assert.equal((await renamed.json()).scene.elements[0].id, "new-page");
});

test("Love Spot pages reject unsafe names, collisions, and corrupt archives without changing the drawing", async t => {
  const f = await fixture(t);
  const saved = await f.save({ elements: [element("safe")], files: {} });
  for (const name of ["../escape", "/tmp/escape", "", "a/b", "a\\b", ".", "x".repeat(101)]) {
    assert.equal((await f.request("/pages", { action: "new", name })).status, 400, name);
  }
  assert.equal((await f.request("/pages", { action: "new", name: saved.scene.page.name })).status, 409);
  assert.equal((await f.request("/pages", { action: "switch", name: "missing" })).status, 404);
  await fs.writeFile(path.join(f.directory, "pages", "broken.excalidraw"), "{");
  assert.equal((await f.request("/pages", { action: "switch", name: "broken" })).status, 409);
  assert.equal((await f.load()).revision, saved.revision);
});

test("Love Spot saves prune unused image files, keep live references, and accept undo with retained editor files", async t => {
  const f = await fixture(t);
  const image = element("image", 1, { type: "image", fileId: "pixels" });
  const pixels = { id: "pixels", mimeType: "image/png", dataURL: `data:image/png;base64,${PNG.toString("base64")}` };
  await f.save({ elements: [image], files: { pixels, unused: { ...pixels, id: "unused" } } });
  assert.deepEqual(Object.keys((await f.load()).scene.files), ["pixels"]);
  await f.save({ elements: [{ ...image, version: 2, isDeleted: true }], files: { pixels } });
  assert.deepEqual((await f.load()).scene.files, {});
  await f.save({ elements: [image], files: { pixels } });
  assert.deepEqual((await f.load()).scene.files, {}, "a stale live version cannot retain deleted image bytes");
  await f.save({ elements: [{ ...image, version: 3 }], files: { pixels } });
  assert.equal((await f.load()).scene.files.pixels?.dataURL, pixels.dataURL);
  await fs.writeFile(
    path.join(f.directory, "pages", "Unused archive.excalidraw"),
    JSON.stringify({ elements: [], files: { pixels } }),
  );
  const selected = await f.request("/pages", { action: "switch", name: "Unused archive" });
  assert.deepEqual(
    (await selected.json()).scene.files,
    {},
    "switching an archive also saves only live image references",
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(f.directory, "pages", "Unused archive.excalidraw"), "utf8")).files,
    {},
  );
});

// 29 Oct, Masih on the dark board: "This is matilda in dark mode!" Her saved SVG face showed as a negative there.
test("opening a board replaces her older faces with the raster one and keeps a custom portrait", async t => {
  const { BOARD_FACE, FACE_DATA_URL, PORTRAIT_DATA_URL } = (await import("./matilda-face.cts")).default;
  for (const [saved, mimeType, wanted] of [
    [FACE_DATA_URL, "image/svg+xml", BOARD_FACE],
    [PORTRAIT_DATA_URL, "image/webp", BOARD_FACE],
    [`data:image/png;base64,${PNG.toString("base64")}`, "image/png", null],
  ] as [string, string, typeof BOARD_FACE | null][]) {
    const f = await fixture(t);
    await fs.mkdir(f.directory, { recursive: true });
    const face = {
      id: "love-face-turn-1",
      type: "image",
      fileId: "matilda-face",
      version: 1,
      versionNonce: 1,
      x: 0,
      y: 0,
      width: 96,
      height: 96,
    };
    await fs.writeFile(
      path.join(f.directory, "scene.excalidraw"),
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [face],
        appState: {},
        files: { "matilda-face": { id: "matilda-face", dataURL: saved, mimeType, created: 1 } },
      }),
    );
    const file = (await f.load()).scene.files["matilda-face"];
    assert.ok(file);
    assert.deepEqual(
      { dataURL: file.dataURL, mimeType: file.mimeType },
      wanted ?? { dataURL: saved, mimeType },
      mimeType,
    );
  }
});

test("pages not kept go to the trash after a week untouched; kept pages and the open page stay", async t => {
  const fsp = (await import("node:fs/promises")).default,
    pathm = (await import("node:path")).default,
    osm = (await import("node:os")).default;
  const { createLoveSpot } = await import("./love-spot-store.cts");
  const { createTestTempDir, removeTestTempDir } = await import("../tests/temp-root.cts");
  const base = pathm.join(osm.homedir(), ".cache/elpis-tests");
  await fsp.mkdir(base, { recursive: true });
  const directory = createTestTempDir(pathm.join(base, "love-pages-"));
  t.after(() => removeTestTempDir(directory));
  await fsp.writeFile(
    pathm.join(directory, "scene.excalidraw"),
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      files: {},
      appState: {},
      page: { name: "Open", session: "s" },
    }),
  );
  await fsp.mkdir(pathm.join(directory, "pages"));
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const name of ["Old note", "Old kept", "Fresh"])
    await fsp.writeFile(
      pathm.join(directory, "pages", `${name}.excalidraw`),
      JSON.stringify({ type: "excalidraw", version: 2, elements: [], files: {}, appState: {} }),
    );
  for (const name of ["Old note", "Old kept"])
    await fsp.utimes(pathm.join(directory, "pages", `${name}.excalidraw`), old / 1000, old / 1000);
  const store = createLoveSpot({ directory, screenshots: pathm.join(directory, "shots") });
  t.after(() => store.close());
  // The rule's first run: old pages get their week from today, not at once.
  let listed = await store.listPages();
  assert.deepEqual(listed.pages.map(p => p.name).sort(), ["Fresh", "Old kept", "Old note", "Open"]);
  const page = (await store.read()).scene.page;
  await store.changePage({ action: "keep", name: "Old kept", page });
  listed = await store.listPages();
  assert.equal(listed.pages.find(p => p.name === "Old kept").kept, true);
  assert.ok(
    listed.pages.find(p => p.name === "Old note").expires > Date.now(),
    "an unkept page shows when it will leave",
  );
  // A week after the rule began.
  const life = JSON.parse(await fsp.readFile(pathm.join(directory, ".page-lifecycle.json"), "utf8"));
  await fsp.writeFile(pathm.join(directory, ".page-lifecycle.json"), JSON.stringify({ ...life, since: old }));
  listed = await store.listPages();
  assert.deepEqual(
    listed.pages.map(p => p.name).sort(),
    ["Fresh", "Old kept", "Open"],
    "only the old page nobody kept left",
  );
});
