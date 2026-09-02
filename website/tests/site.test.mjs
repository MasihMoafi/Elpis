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
  assert.match(html, /data-runtime-description="OpenAI API · hosted inference"/);
  assert.match(html, /data-runtime-detail-output/);
  assert.doesNotMatch(html, /Cloud A|Cloud B/);
  assert.match(script, /runtimeDetail\.textContent = button\.dataset\.runtimeDescription/);
});

test("runtime selection keeps the three visible control labels stable", async () => {
  const [html, css] = await Promise.all([read("index.html"), read("styles.css")]);
  assert.match(html, /data-runtime="Local model"[^>]*>Local<\/button>/);
  assert.match(html, /data-runtime="OpenAI"[^>]*>OpenAI<\/button>/);
  assert.match(html, /data-runtime="Anthropic"[^>]*>Anthropic<\/button>/);
  assert.match(css, /\.runtime-switcher\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(72px, 1fr\)\)[^}]*width:\s*252px/s);
  assert.match(css, /\.runtime-detail\s*\{[^}]*white-space:\s*nowrap/s);
});

test("uses source-backed context, observability, and continuation language", async () => {
  const html = await read("index.html");
  assert.match(html, /Context admission/);
  assert.match(html, /Context observability/);
  assert.match(html, /Auditable checkpoints/);
  assert.match(html, /Exact resume or\s*<br \/>lean continuation\./);
  assert.match(html, /GOAL\.md carries the current objective and status/);
  assert.match(html, /ES\.md records the latest result, changed files, commands, and exact evidence/);
  assert.doesNotMatch(html, /Know what the agent knows|Resume the work|Goal stays current/i);
});

test("pauses the runtime marquee on hover or keyboard focus", async () => {
  const [html, css] = await Promise.all([read("index.html"), read("styles.css")]);
  assert.match(html, /class="runtime-marquee" tabindex="0"/);
  assert.match(css, /\.runtime-marquee:hover \.marquee-track, \.runtime-marquee:focus-within \.marquee-track\s*\{[^}]*animation-play-state:\s*paused/s);
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
  const [html, css] = await Promise.all([read("index.html"), read("styles.css")]);
  assert.match(html, /class="hero-flow"/);
  assert.match(css, /@keyframes\s+flow-dash/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.flow-pulse\s*\{\s*display:\s*none/);
});

test("does not include tracking or analytics", async () => {
  const html = await read("index.html");
  assert.doesNotMatch(html, /googletagmanager|google-analytics|plausible|posthog|segment\.com/i);
});
