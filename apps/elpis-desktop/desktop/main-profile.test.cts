const test = require("node:test");
const assert = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { configureMainProfile }: typeof import("./main-profile.cts") = require("./main-profile.cts");

function fakeApp() {
  const paths: Record<string, string> = { appData: "/config" };
  return {
    paths,
    setName() {},
    setDesktopName() {},
    getPath: (name: string) => paths[name],
    setPath: (name: string, value: string) => {
      paths[name] = value;
    },
    commandLine: { appendSwitch() {}, getSwitchValue: () => "" },
  } as unknown as import("electron").App & { paths: Record<string, string> };
}

test("standalone Love Spot keeps its data in its own home, never in Elpis's", (t: import("node:test").TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "love-spot-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { HOME: home, ELPIS_APP_BRIDGE_SOCKET: "/run/elpis.sock" };
  configureMainProfile({ app: fakeApp(), argv: ["electron", "--love-spot-app"], env });
  assert.equal(env.ELPIS_HOME, path.join(home, ".local", "share", "love-spot"));
  assert.equal(env.ELPIS_APP_BRIDGE_SOCKET, undefined, "Elpis's running bridge must not serve Love Spot");
  assert.equal(env.LOVE_SPOT_APP, "1");
  assert.equal(fs.readFileSync(path.join(env.ELPIS_HOME!, "config.toml"), "utf8"), "");
  assert.equal(fs.existsSync(path.join(home, ".elpis-next")), false);

  // Elpis itself, and Love Spot opened inside Elpis, keep the Elpis home.
  for (const argv of [["electron"], ["electron", "--love-spot"]]) {
    const elpis: NodeJS.ProcessEnv = { HOME: home, ELPIS_APP_BRIDGE_SOCKET: "/run/elpis.sock" };
    configureMainProfile({ app: fakeApp(), argv, env: elpis });
    assert.equal(elpis.ELPIS_HOME, undefined);
    assert.equal(elpis.LOVE_SPOT_APP, undefined);
    assert.equal(elpis.ELPIS_APP_BRIDGE_SOCKET, "/run/elpis.sock");
  }
});

test("an explicit ELPIS_HOME and the snap data folder are respected", (t: import("node:test").TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "love-spot-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const snap: NodeJS.ProcessEnv = { HOME: home, XDG_DATA_HOME: path.join(home, "snap-data") };
  configureMainProfile({ app: fakeApp(), argv: ["electron", "--love-spot-app"], env: snap });
  assert.equal(snap.ELPIS_HOME, path.join(home, "snap-data", "love-spot"));
  fs.writeFileSync(path.join(snap.ELPIS_HOME!, "config.toml"), 'model = "kept"\n');
  configureMainProfile({
    app: fakeApp(),
    argv: ["electron", "--love-spot-app"],
    env: { ...snap, ELPIS_HOME: undefined },
  });
  assert.equal(
    fs.readFileSync(path.join(snap.ELPIS_HOME!, "config.toml"), "utf8"),
    'model = "kept"\n',
    "a second start keeps the config",
  );
  const chosen: NodeJS.ProcessEnv = { HOME: home, ELPIS_HOME: path.join(home, "chosen") };
  configureMainProfile({ app: fakeApp(), argv: ["electron", "--love-spot-app"], env: chosen });
  assert.equal(chosen.ELPIS_HOME, path.join(home, "chosen"));
});
