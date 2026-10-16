import test from "node:test";
import assert from "node:assert/strict";
import { environmentDigest } from "../shared-runtime.mjs";

// The desktop launcher adds the loopback hosts to NO_PROXY; a terminal started from the
// user's shell has them in another order or not at all. Both must reach the same bridge.
test("NO_PROXY differing only in loopback hosts or order is the same configuration", () => {
  const terminal = environmentDigest({ HTTPS_PROXY: "http://127.0.0.1:10808/", NO_PROXY: "example.org,.lan" }, "salt");
  const app = environmentDigest({ HTTPS_PROXY: "http://127.0.0.1:10808/", NO_PROXY: ".lan, example.org,localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" }, "salt");
  assert.deepEqual(app, terminal);
});

test("a real NO_PROXY difference still counts", () => {
  assert.notDeepEqual(environmentDigest({ NO_PROXY: "example.org" }, "salt"), environmentDigest({ NO_PROXY: "example.org,internal.corp" }, "salt"));
});
