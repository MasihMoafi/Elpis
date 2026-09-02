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

test("keeps memory claims honest without maturity disclaimers", async () => {
  const html = await read("index.html");
  assert.doesNotMatch(html, /automatic memory/i);
  assert.match(html, /user-maintained memory/i);
  assert.doesNotMatch(html, /experimental/i);
});

test("removes the rejected FAQ, footer copy, and low-quality landing-page diagrams", async () => {
  const html = await read("index.html");
  assert.doesNotMatch(html, /Straight answers|Does Elpis replace|<footer\b/i);
  assert.doesNotMatch(html, /context-ledger\.webp|elpis-context-control\.svg|elpis-work-graph\.svg/i);
});

test("runtime controls name distinct providers and explain their inference owner", async () => {
  const [html, script] = await Promise.all([read("index.html"), read("app.js")]);
  assert.match(html, />OpenAI<\/button>/);
  assert.match(html, />Anthropic<\/button>/);
  assert.match(html, /data-runtime-detail="OpenAI API · hosted inference"/);
  assert.doesNotMatch(html, /Cloud A|Cloud B/);
  assert.match(script, /runtimeDetail\.textContent = button\.dataset\.runtimeDetail/);
});

test("copy feedback never changes the visible button label or command layout", async () => {
  const [html, css, script] = await Promise.all([read("index.html"), read("styles.css"), read("app.js")]);
  assert.match(html, /data-copy-button[^>]*>Copy<\/button>/);
  assert.match(html, /data-copy-status[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(css, /\.copy-button\s*\{[^}]*width:\s*4\.25rem[^}]*font-size:\s*\.65rem/s);
  assert.doesNotMatch(script, /copyButton\.textContent\s*=/);
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
