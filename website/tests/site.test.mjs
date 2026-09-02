import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

test("publishes the continuity promise and install path", async () => {
  const html = await read("index.html");
  assert.match(html, /Change the runtime\.\s*Keep the thread\./i);
  assert.match(html, /install-elpis\.sh/);
});

test("keeps memory and experiments honest", async () => {
  const html = await read("index.html");
  assert.doesNotMatch(html, /automatic memory/i);
  assert.match(html, /user-maintained memory/i);
  assert.match(html, /Smart Prune[\s\S]{0,500}Experimental/i);
  assert.match(html, /work graphs[\s\S]{0,500}experimental/i);
  assert.doesNotMatch(html, /(^|[^-])\/prune(?:\s|<)/m);
  assert.match(html, /one live observation, not a matched cost or quality comparison/i);
});

test("publishes the Linux v0.2.0 demo without personal data", async () => {
  const [html, script] = await Promise.all([read("index.html"), read("app.js")]);
  assert.match(html, /v0\.2\.0/);
  assert.match(html, /Linux x86_64/);
  assert.doesNotMatch(html, /macOS|Darwin/i);
  assert.doesNotMatch(html, /[\w.+-]+@[\w.-]+|\/home\/masih|session id/i);
  assert.match(html, /data-prune-button/);
  assert.match(script, /data-prune-button/);
});

test("ships the current SVG evidence set", async () => {
  for (const path of [
    "assets/elpis-context-ledger.svg",
    "assets/elpis-context-control.svg",
    "assets/elpis-normalized-overlay-highcontrast.svg",
    "assets/sankey_context_flow.svg",
  ]) {
    await access(new URL(path, root));
  }
});

test("has working anchor navigation and a sticky header", async () => {
  const [html, css] = await Promise.all([read("index.html"), read("styles.css")]);
  const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  assert.ok(targets.length >= 4);
  for (const target of targets) {
    assert.match(html, new RegExp(`id=["']${target}["']`));
  }
  assert.match(css, /position:\s*sticky/);
});

test("ships responsive motion with an accessible reduced-motion fallback", async () => {
  const css = await read("styles.css");
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("does not include tracking or analytics", async () => {
  const html = await read("index.html");
  assert.doesNotMatch(html, /googletagmanager|google-analytics|plausible|posthog|segment\.com/i);
});
