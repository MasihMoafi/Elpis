import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(html, /pruning[\s\S]{0,500}experimental/i);
  assert.match(html, /work graphs[\s\S]{0,500}experimental/i);
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
