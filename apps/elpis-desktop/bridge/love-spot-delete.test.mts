import test from "node:test";
import assert from "node:assert/strict";

test("delete all pages trashes every page but the open one and the kept ones", async t => {
  const fsp = (await import("node:fs/promises")).default,
    pathm = (await import("node:path")).default,
    osm = (await import("node:os")).default;
  const { createLoveSpot } = await import("./love-spot-store.cts");
  const { createTestTempDir, removeTestTempDir } = await import("../tests/temp-root.cts");
  const base = pathm.join(osm.homedir(), ".cache/elpis-tests");
  await fsp.mkdir(base, { recursive: true });
  const directory = createTestTempDir(pathm.join(base, "love-clear-"));
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
  for (const name of ["One", "Two", "Kept"])
    await fsp.writeFile(
      pathm.join(directory, "pages", `${name}.excalidraw`),
      JSON.stringify({ type: "excalidraw", version: 2, elements: [], files: {}, appState: {} }),
    );
  const store = createLoveSpot({ directory, screenshots: pathm.join(directory, "shots") });
  t.after(() => store.close());
  const page = (await store.read()).scene.page;
  await store.changePage({ action: "keep", name: "Kept", page });
  await store.changePage({ action: "clear", page });
  assert.deepEqual((await store.listPages()).pages.map(p => p.name).sort(), ["Kept", "Open"]);
  await assert.rejects(store.changePage({ action: "clear", name: "Kept", page }), /Invalid page action/);
});
