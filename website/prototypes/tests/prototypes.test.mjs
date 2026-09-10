import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("ships three distinct, switchable Elpis TUI prototypes", () => {
  const html = read("../index.html");
  const script = read("../app.js");

  assert.equal((html.match(/data-prototype=/g) ?? []).length, 3);
  for (const view of ["cockpit", "continuity", "workbench"]) {
    assert.match(html, new RegExp(`data-view="${view}"`));
    assert.match(html, new RegExp(`data-prototype="${view}"`));
  }

  assert.match(script, /location\.hash/);
  assert.match(script, /setActivePrototype/);
  assert.match(script, /keydown/);
  assert.match(script, /Live turn · minimal structural change/);
  assert.match(script, /Session handoff · dedicated inspect mode/);
  assert.match(script, /Context control · full-screen \/context/);
});

test("uses daisyUI primitives for real controls and data structures", () => {
  const html = read("../index.html");
  const css = read("../source.css");

  for (const className of ["tabs", "tab", "btn", "list", "timeline", "table", "menu", "textarea", "kbd"]) {
    assert.match(html, new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`));
  }

  assert.match(css, /@plugin "daisyui"/);
  assert.match(css, /@plugin "daisyui\/theme"/);
  assert.match(css, /--color-base-100/);
});

test("keeps the prototypes terminal-native and product-truthful", () => {
  const html = read("../index.html");
  const css = read("../source.css");
  const combined = `${html}\n${css}`;

  assert.match(combined, /Automatic pruning/);
  assert.match(combined, /Experimental/);
  assert.match(combined, /Off/);
  assert.match(combined, /provider-native exact resume/);
  assert.match(combined, /Manual memory/);
  assert.match(combined, /MEMORY\.md/);

  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(css, /url\s*\(/i);
  assert.doesNotMatch(css, /(?:linear|radial)-gradient\s*\(/i);
  assert.doesNotMatch(css, /box-shadow\s*:/i);
});

test("provides core prototype interactions", () => {
  const script = read("../app.js");

  assert.match(script, /data-admission-toggle/);
  assert.match(script, /data-continuity-event/);
  assert.match(script, /data-workbench-mode/);
  assert.match(script, /data-source-row/);
});
