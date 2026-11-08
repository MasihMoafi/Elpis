import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLoveSpot } from "./love-spot-store.cts";
import { exec, PNG, element, eventReader, fixture, screenshotFixture } from "./love-spot.fixtures.mts";
import type { StoreEvent, Screenshot } from "./love-spot.fixtures.mts";

test("Love Spot inbox merges durably and retains partial JSON", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.screenshots, "old.png"), PNG);
  const stream = await f.request("/events"),
    reader = eventReader(stream);
  t.after(() => reader.cancel());
  await reader.read();
  await f.save({ elements: [element("a", 3)], files: {} });
  await fs.writeFile(
    path.join(f.directory, "inbox", "add.json"),
    JSON.stringify({ elements: [element("a", 2), element("inbox")] }),
  );
  await fs.writeFile(path.join(f.directory, "inbox", "partial.json"), "{");
  let scene;
  for (let i = 0; i < 30; i++) {
    scene = (await f.load()).scene;
    if (scene.elements.some(e => e.id === "inbox")) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(scene?.elements.find(e => e.id === "a")?.version, 3);
  for (let i = 0; i < 30 && (await fs.stat(path.join(f.directory, "inbox", "add.json")).catch(() => false)); i++)
    await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(fs.access(path.join(f.directory, "inbox", "add.json")));
  assert.equal(await fs.readFile(path.join(f.directory, "inbox", "partial.json"), "utf8"), "{");
  await fs.writeFile(
    path.join(f.directory, "inbox", "partial.json"),
    JSON.stringify({ elements: [element("finished")] }),
  );
  for (let i = 0; i < 20 && !(await f.load()).scene.elements.some(e => e.id === "finished"); i++)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok((await f.load()).scene.elements.some(e => e.id === "finished"));
});

test("screenshots are captured before any event subscriber and between visits without sharing them", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.screenshots, "before-visit.png"), PNG);
  await new Promise(resolve => setTimeout(resolve, 400));
  const tray = async (): Promise<Screenshot[]> => (await (await f.request("/screenshots")).json()).screenshots;
  assert.deepEqual(
    (await tray()).map(s => s.name),
    ["before-visit.png"],
  );
  assert.equal((await f.load()).scene.elements.length, 0);
  const reader = eventReader(await f.request("/events"));
  await reader.read();
  await reader.cancel();
  await new Promise(resolve => setTimeout(resolve, 100));
  await fs.writeFile(path.join(f.screenshots, "between-visits.png"), PNG);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual((await tray()).map(s => s.name).sort(), ["before-visit.png", "between-visits.png"]);
  assert.equal((await f.load()).scene.elements.length, 0);
});

test("opening Love Spot reports a background screenshot error and clearing it resumes capture", async t => {
  const f = await fixture(t),
    store = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  t.after(() => store.close());
  await store.start();
  // A directory at the metadata file path produces a real read failure.
  const blocked = path.join(f.directory, ".screenshot-choices.json");
  await fs.mkdir(blocked, { recursive: true });
  await fs.writeFile(path.join(f.screenshots, "retry-after-error.png"), PNG);
  await new Promise(resolve => setTimeout(resolve, 400));
  const events: StoreEvent[] = [];
  await store.watch(event => events.push(event));
  assert.ok(
    events.some(e => e.type === "error" && e.message === "Love Spot could not sync the drawing."),
    "a background failure must be visible when the board opens",
  );
  await fs.rmdir(blocked);
  for (let i = 0; i < 40 && !store.screenshotsList().length; i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(
    store.screenshotsList()[0]?.name,
    "retry-after-error.png",
    "capture must retry without dropping the new screenshot",
  );
  assert.equal((await store.read()).scene.elements.length, 0);
  let recovered: StoreEvent[] = [];
  for (let i = 0; i < 40; i++) {
    recovered = [];
    const unwatch = await store.watch(event => recovered.push(event));
    unwatch();
    if (!recovered.some(e => e.type === "error")) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(
    recovered.some(e => e.type === "error"),
    false,
    "a recovered error must not follow a later subscriber",
  );
});

test("unavailable private IPC keeps local capture working, reports the failure and retries sharing", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "love-ipc-failure-"));
  const directory = path.join(root, "drawing"),
    screenshots = path.join(root, "Screenshots");
  await fs.mkdir(directory);
  await fs.mkdir(screenshots);
  await fs.writeFile(
    path.join(directory, "scene.excalidraw"),
    JSON.stringify({ type: "excalidraw", version: 2, elements: [], files: {}, appState: {} }),
  );
  const store = createLoveSpot({ directory, screenshots }),
    stores = [store];
  t.after(async () => {
    for (const item of stores) await item.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const blocked = t.mock.method(
    fs,
    "mkdir",
    new Proxy(fs.mkdir, {
      apply(target, receiver, args) {
        if (path.basename(args[0]).startsWith("elpis-shots-"))
          return Promise.reject(Object.assign(new Error("Test private IPC unavailable"), { code: "EACCES" }));
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  const events: StoreEvent[] = [];
  await store.watch(event => events.push(event));
  await fs.writeFile(path.join(screenshots, "local-during-ipc-failure.png"), PNG);
  for (let i = 0; i < 40 && !store.screenshotsList().length; i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(store.screenshotsList()[0]?.name, "local-during-ipc-failure.png");
  assert.ok(
    events.some(e => e.type === "error" && /screenshot trays/.test(e.message)),
    "the unavailable connection must be visible",
  );
  blocked.mock.restore();
  const other = createLoveSpot({ directory, screenshots });
  stores.push(other);
  await other.start();
  for (let i = 0; i < 100 && !other.screenshotsList().length; i++)
    await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(
    other.screenshotsList()[0]?.name,
    "local-during-ipc-failure.png",
    "sharing must resume without losing the pending screenshot",
  );
  assert.equal((await store.read()).scene.elements.length, 0);
});

test("independent screenshot watchers consume one choice across page switches and keep dismissals private", async t => {
  const f = await fixture(t);
  const a = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  const b = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  t.after(async () => {
    await Promise.all([a.close(), b.close()]);
  });
  await a.watch(() => {});
  await b.watch(() => {});
  const wait = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 60; i++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail("independent screenshot watchers did not settle");
  };
  await fs.writeFile(path.join(f.screenshots, "placed-once.png"), PNG);
  await wait(() => a.screenshotsList().length === 1 && b.screenshotsList().length === 1);
  const shot = a.screenshotsList()[0];
  assert.ok(shot);
  await assert.rejects(
    a.chooseScreenshot({ id: shot.id, action: "place", dataURL: "data:text/plain;base64,cHJpdmF0ZQ==" }),
    /Invalid drawing image/,
  );
  assert.equal(a.screenshotsList().length, 1, "a refused import must retain the private screenshot for retry");
  assert.equal((await a.read()).scene.elements.length, 0);
  await a.chooseScreenshot({ id: shot.id, action: "place" });
  await wait(() => b.screenshotsList().length === 0);
  await a.changePage({ action: "new", name: "Next page" });
  await assert.rejects(b.chooseScreenshot({ id: shot.id, action: "place" }), /already left/);
  assert.equal(
    (await b.read()).scene.elements.length,
    0,
    "a stale tray cannot place the same screenshot on another page",
  );
  await fs.writeFile(path.join(f.screenshots, "dismiss-everywhere.png"), PNG);
  await wait(() => a.screenshotsList().length === 1 && b.screenshotsList().length === 1);
  await b.chooseScreenshot({ id: b.screenshotsList()[0]?.id, action: "dismiss" });
  await wait(() => a.screenshotsList().length === 0);
  assert.equal((await a.read()).scene.elements.length, 0);
  assert.ok(
    JSON.parse(await fs.readFile(path.join(f.directory, ".screenshot-choices.json"), "utf8")).every((id: string) =>
      /^shot-[a-f0-9]{32}$/.test(id),
    ),
    "choice metadata contains no screenshot names or pixels",
  );
});

test("a later Love Spot process receives private pending screenshots from the already running app", async t => {
  const f = await fixture(t),
    a = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  t.after(() => a.close());
  await a.watch(() => {});
  await fs.writeFile(path.join(f.screenshots, "before-second-app.png"), PNG);
  for (let i = 0; i < 40 && !a.screenshotsList().length; i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(a.screenshotsList().length, 1);
  const script = `const {createLoveSpot}=require(process.argv[1]); (async()=>{
    const b=createLoveSpot({directory:process.argv[2],screenshots:process.argv[3]});
    try { await b.start(); for(let i=0;i<40&&!b.screenshotsList().length;i++)await new Promise(r=>setTimeout(r,30));
      console.log(JSON.stringify({shots:b.screenshotsList(),scene:(await b.read()).scene}));
    } finally { await b.close(); }
  })().catch(e=>{console.error(e);process.exitCode=1});`;
  const result = JSON.parse(
    (
      await exec(process.execPath, [
        "-e",
        script,
        fileURLToPath(new URL("./love-spot-store.cts", import.meta.url)),
        f.directory,
        f.screenshots,
      ])
    ).stdout,
  );
  assert.deepEqual(
    result.shots,
    a.screenshotsList(),
    "a new process must not classify the other app's pending screenshot as old",
  );
  assert.equal(result.scene.elements.length, 0);
});

test("a later app receives a private screenshot backlog larger than one IPC response", async t => {
  const f = await fixture(t),
    store = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  t.after(() => store.close());
  let captured = 0;
  await store.watch(e => {
    if (e.type === "screenshots") captured = e.screenshots.length;
  });
  // A valid ancillary PNG text chunk exercises transport size without huge pixel dimensions.
  const data = Buffer.concat([Buffer.from("Comment\0"), Buffer.alloc(10 * 1024 * 1024, "x")]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write("tEXt", 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE((await import("node:zlib")).crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const png = Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
  const expected = Array.from({ length: 7 }, (_, i) => `backlog-${i}.png`);
  await Promise.all(expected.map(name => fs.writeFile(path.join(f.screenshots, name), png)));
  for (let i = 0; i < 100 && captured < expected.length; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(captured, expected.length);
  const script = `const {createLoveSpot}=require(process.argv[1]); (async()=>{
    const b=createLoveSpot({directory:process.argv[2],screenshots:process.argv[3]}); let names=[];
    try { await b.watch(e=>{if(e.type==='screenshots')names=e.screenshots.map(s=>s.name)});
      for(let i=0;i<150&&names.length<7;i++)await new Promise(r=>setTimeout(r,100));
      console.log(JSON.stringify({names,shared:(await b.read()).scene.elements.length}));
    } finally { await b.close(); }
  })().catch(e=>{console.error(e);process.exitCode=1});`;
  const result = JSON.parse(
    (
      await exec(process.execPath, [
        "-e",
        script,
        fileURLToPath(new URL("./love-spot-store.cts", import.meta.url)),
        f.directory,
        f.screenshots,
      ])
    ).stdout,
  );
  assert.deepEqual(result.names.sort(), expected, "every pending screenshot must arrive in the later process");
  assert.equal(result.shared, 0);
});

test("new screenshots remain private in memory, newest first, without changing scene, inbox or picture", async t => {
  const f = await screenshotFixture(t),
    before = await fs.readFile(path.join(f.directory, "scene.excalidraw"));
  await fs.writeFile(path.join(f.screenshots, "partial.png"), PNG.subarray(0, 10));
  await fs.writeFile(path.join(f.screenshots, "first.png"), PNG);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(await fs.readFile(path.join(f.directory, "scene.excalidraw")), before);
  await fs.writeFile(path.join(f.screenshots, "latest.png"), PNG);
  await f.wait(async () => (await f.tray()).length === 2);
  const shots = await f.tray();
  assert.deepEqual(
    shots.map(s => s.name),
    ["latest.png", "first.png"],
  );
  assert.equal(shots[0]?.dataURL, `data:image/png;base64,${PNG.toString("base64")}`);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "view.png")), PNG);
  assert.deepEqual(await fs.readdir(path.join(f.directory, "inbox")), []);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), [
    ".view-revision",
    "inbox",
    "pages",
    "scene.excalidraw",
    "view.png",
  ]);
  await fs.writeFile(path.join(f.screenshots, "partial.png"), PNG);
  await f.wait(async () => (await f.tray()).length === 3);
  assert.ok(f.events.some(e => e.type === "screenshots" && e.screenshots.length));
  assert.ok(f.events.filter(e => e.type === "scene").every(e => e.scene.elements.length === 1));
});

test("placing a private screenshot uses the existing import geometry and consumes it for all windows", async t => {
  const f = await screenshotFixture(t);
  await fs.writeFile(path.join(f.screenshots, "chosen.png"), PNG);
  await f.wait(async () => (await f.tray()).length === 1);
  const [shot] = await f.tray();
  assert.ok(shot);
  const reader = eventReader(await f.request("/events"));
  t.after(() => reader.cancel());
  const decoder = new TextDecoder();
  let initial = "";
  while (!initial.includes('"type":"screenshots"'))
    initial += decoder.decode((await reader.read()).value, { stream: true });
  assert.ok(initial.includes(shot.id), "a second window receives the same private tray");
  await fs.unlink(path.join(f.screenshots, "chosen.png")); // Placement uses the captured bytes.
  assert.equal((await f.request("/screenshots", { id: shot.id, action: "place" })).status, 200);
  const { scene } = await f.load(),
    image = scene.elements.find(e => e.id === shot.id);
  assert.ok(image && image.fileId);
  assert.equal(image.type, "image");
  assert.equal(image.y, 140);
  assert.equal(image.width, 8);
  assert.equal(scene.files[image.fileId]?.dataURL, shot.dataURL);
  assert.ok(scene.elements.some(e => e.id === "existing-image"));
  assert.deepEqual(await f.tray(), []);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "view.png")), PNG);
  assert.equal((await f.request("/screenshots", { id: shot.id, action: "place" })).status, 404);
  assert.equal((await f.load()).scene.elements.length, 2);
});

test("dismissed screenshots stay dismissed and leave all shared files unchanged", async t => {
  const f = await screenshotFixture(t),
    before = await fs.readFile(path.join(f.directory, "scene.excalidraw"));
  await fs.writeFile(path.join(f.screenshots, "private.png"), PNG);
  await f.wait(async () => (await f.tray()).length === 1);
  const [shot] = await f.tray();
  assert.ok(shot);
  assert.equal((await f.request("/screenshots", null)).status, 400);
  assert.equal((await f.request("/screenshots", { id: shot.id, action: "other" })).status, 400);
  assert.equal((await f.request("/screenshots", { id: "../private.png", action: "place" })).status, 404);
  assert.equal((await f.request("/screenshots", { id: shot.id, action: "dismiss" })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.deepEqual(await f.tray(), []);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "scene.excalidraw")), before);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "view.png")), PNG);
  assert.deepEqual(await fs.readdir(path.join(f.directory, "inbox")), []);
});

test("Love Spot independent processes serialize their merges on the same drawing", async t => {
  const f = await fixture(t);
  const module = fileURLToPath(new URL("./love-spot-store.cts", import.meta.url));
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      exec(process.execPath, [
        "-e",
        `const {createLoveSpot}=require(${JSON.stringify(module)});createLoveSpot({directory:process.argv[1]}).save(JSON.parse(process.argv[2])).catch(e=>{console.error(e);process.exitCode=1});`,
        f.directory,
        JSON.stringify({ elements: [element(`process-${i}`)], files: {} }),
      ]),
    ),
  );
  assert.equal((await f.load()).scene.elements.length, 8);
});
