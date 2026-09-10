import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("current public media and evidence links resolve locally", async () => {
  for (const page of ["index.html", "technical.html"]) {
    const html = await read(page);
    for (const match of html.matchAll(/(?:src|href)="(\.\/[^"#]+)(?:#[^"]*)?"/g)) {
      const path = match[1].split("?")[0];
      assert.ok(existsSync(new URL(path, root)), `${page}: missing ${path}`);
    }
    assert.match(html, /40838f83/);
    assert.match(html, /illustrative/i);
    assert.match(html, /historical/i);
  }
  const html = await read("index.html");
  assert.equal([...html.matchAll(/data-dashboard-panel="/g)].length, 4);
  assert.equal([...html.matchAll(/data-dashboard-panel="[^"]+" hidden/g)].length, 3);
});

test("public chart provenance matches the frozen source and copied evidence", async () => {
  const manifest = JSON.parse(await read("assets/technical/current-evidence-20260909.json"));
  const data = await read("evidence/COST_EFFICIENCY_METRICS.json");
  assert.equal(createHash("sha256").update(data).digest("hex"), manifest.source_sha256);
  const source = JSON.parse(data);
  assert.equal(source.batches.length, manifest.verified_batches);
  assert.equal(source.batches.reduce((n, b) => n + b.pairs.length, 0), manifest.verified_pairs);
  for (const chart of ["elpis-current-effort-20260909.svg", "elpis-current-horizon-20260909.svg"]) {
    assert.equal(await read(`assets/technical/${chart}`), await read(`../docs/assets/${chart}`));
  }
});

test("technical page was generated from the current README and template", async () => {
  const digest = createHash("sha256").update(await read("../readme.md"))
    .update(await read("technical-template.html")).digest("hex");
  assert.ok((await read("technical.html")).startsWith(`<!-- README/template SHA256: ${digest} -->`));
});

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

test("publishes the continuity promise and install path", async () => {
  const html = await read("index.html");
  assert.match(html, /Change the runtime\.\s*<br \/>\s*<em[^>]*>Keep the thread\.<\/em>/i);
  assert.match(html, /install-elpis\.sh/);
});

test("builds the page from local daisyUI components and semantic theme colors", async () => {
  const [html, source, packageJson] = await Promise.all([
    read("index.html"),
    read("source.css"),
    read("package.json").then(JSON.parse),
  ]);

  assert.match(packageJson.devDependencies.daisyui, /^\^5\./);
  assert.match(packageJson.devDependencies.tailwindcss, /^\^4\./);
  assert.match(source, /@import\s+"tailwindcss"/);
  assert.match(source, /@plugin\s+"daisyui"/);
  assert.match(source, /@plugin\s+"daisyui\/theme"/);
  assert.match(html, /<html[^>]+data-theme="elpis"/);
  for (const component of ["navbar", "hero", "btn", "card", "mockup-code", "footer"]) {
    assert.match(html, new RegExp(`class="[^"]*\\b${component}\\b`));
  }
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/(npm\/)?daisyui|@tailwindcss\/browser/);
});

test("keeps context and pruning claims inside the proven boundary", async () => {
  const html = await read("index.html");
  assert.match(html, /user-maintained memory/i);
  assert.match(html, /experimental and user-enabled/i);
  assert.doesNotMatch(html, /automatic memory|production.ready|zero runtime overhead|cryptographic checkpoint/i);
});

test("replaces the fabricated product mocks with one terminal-native run", async () => {
  const [html, source, script] = await Promise.all([read("index.html"), read("source.css"), read("app.js")]);
  assert.match(html, /data-ace-demo/);
  assert.match(html, /data-shell-command/);
  assert.match(html, /data-shell-enter/);
  assert.match(html, /CONTEXT LEDGER/);
  assert.match(html, /SMART PRUNE/);
  assert.match(html, /258\.4k/);
  assert.match(source, /\.ace-demo-stage\s*\{[^}]*position:\s*sticky/s);
  assert.match(script, /"elpis"\.slice/);
  assert.match(script, /position >= 0\.10 && position < 0\.12/);
  assert.match(script, /renderAceDemo/);
  assert.match(html, /Total ≈5\.6k tokens admitted/);
  assert.match(html, /≈33\.3k of 258\.4k used \(13%\)/);
  assert.match(html, /Conversation \+ built-in context<\/span><span[^>]*>≈27\.7k tokens/);
  assert.doesNotMatch(script, /Total ≈0 tokens admitted|≈(?:7\.9|8\.4)k of 258\.4k|≈0 of 258\.4k used/);
  assert.doesNotMatch(html, /continuity-console|ledger-tui-preview|pruning-pipeline-grid|pruning-diff-container|workgraphs-section|specs-section/);
});

test("shows a correctly calculated slash-context visualization", async () => {
  const [html, script] = await Promise.all([read("index.html"), read("app.js")]);
  assert.match(html, /Illustrative request snapshot · measured total/);
  assert.match(html, /<div class="stat-value">33\.3k<\/div>/);
  assert.match(html, /<div class="stat-value">258\.4k<\/div>/);
  assert.match(html, /<div class="stat-value">225\.1k<\/div>/);
  for (const view of ["context-capacity-ring", "context-attribution-stack", "context-category-bars", "context-source-table", "context-checkpoint-line"]) {
    assert.match(html, new RegExp(`\\b${view}\\b`));
  }
  for (const category of ["User messages", "Agent responses", "Tool calls", "System prompt", "Development rules"]) {
    assert.match(html, new RegExp(category));
  }
  assert.match(html, /Category values are estimated attribution anchored to the measured request total/);
  assert.match(html, /Session continuity/);
  assert.doesNotMatch(html, />Skills</);
  assert.doesNotMatch(html, /data-context-grid/);
  assert.doesNotMatch(script, /CONTEXT_GRID_CELLS|data-context-grid|contextVisual/);
});

test("embeds the Ace lifecycle diagram with its retired-configuration disclosure", async () => {
  const html = await read("index.html");
  assert.match(html, /assets\/diagram_ace_lifecycle\.svg/);
  assert.match(html, /retired automatic threshold-triggered configuration/i);
});

test("copy feedback never changes the visible button label", async () => {
  const [html, script] = await Promise.all([read("index.html"), read("app.js")]);
  assert.match(html, /data-copy-button[^>]*>Copy<\/button>/);
  assert.match(html, /data-copy-status[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(script, /copyButton\.textContent\s*=/);
});

test("has valid anchor navigation and no analytics", async () => {
  const html = await read("index.html");
  const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  assert.ok(targets.length >= 4);
  for (const target of targets) assert.match(html, new RegExp(`id=["']${target}["']`));
  assert.doesNotMatch(html, /googletagmanager|google-analytics|plausible|posthog|segment\.com/i);
});

test("ships responsive motion with an accessible reduced-motion fallback", async () => {
  const [html, source, script] = await Promise.all([read("index.html"), read("source.css"), read("app.js")]);
  assert.match(html, /class="hero-flow"/);
  assert.match(source, /@media\s*\(max-width:\s*720px\)/);
  assert.match(source, /prefers-reduced-motion:\s*reduce/);
  assert.match(script, /prefers-reduced-motion/);
});

test("keeps terminal panes within the viewport and wraps their contents", async () => {
  const source = await read("source.css");
  assert.doesNotMatch(source, /\.ace-terminal\s*\{[^}]*width:\s*1160px/);
  assert.doesNotMatch(source, /minmax\(540px/);
  assert.doesNotMatch(source, /var\(--scan\)\s*\*\s*780px/);
  assert.match(source, /\.ace-raw-line\s*\{[^}]*white-space:\s*normal/);
  assert.match(source, /\.ace-terminal\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(source, /\.ace-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/);
});
