import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const script = await readFile(new URL("../assets/branding/brand.js", import.meta.url), "utf8");
for (const saved of ["light", "dark", null]) {
  test(`new page starts dark despite saved ${saved ?? "default"} theme`, () => {
    let initialized, click, logoWrites = 0;
    const root = { dataset: {} };
    const icon = {};
    const button = { setAttribute() {}, addEventListener(type, callback) { if (type === "click") click = callback; } };
    const logo = { set src(value) { logoWrites++; } };
    const document = {
      documentElement: root, readyState: "loading",
      querySelector() { return icon; },
      querySelectorAll(selector) { return selector === "[data-brand-logo]" ? [logo] : selector === "[data-brand-theme]" ? [button] : []; },
      addEventListener(type, callback) { if (type === "DOMContentLoaded") initialized = callback; },
    };
    vm.runInNewContext(script, { document, localStorage: { getItem: () => saved, setItem() {} } });
    assert.equal(root.dataset.theme, "elpis");
    assert.equal(logoWrites, 0);
    initialized();
    assert.equal(logoWrites, 0);
    click();
    assert.equal(root.dataset.theme, "elpis-light");
    assert.equal(logoWrites, 0);
  });
}
