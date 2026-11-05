import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";

import { CONTEXT_EXAMPLE, ledgerMarkup, demoSnapshot } from "../assets/context-ledger.mjs";
import { admissionStateAt } from "../assets/demo-state.mjs";
const root = new URL("../", import.meta.url);
test("homepage sharing metadata points to canonical public content", async () => {
  const html=await read("index.html");
  const canonical=html.match(/<link rel="canonical" href="([^"]+)"/)[1];
  assert.equal(canonical,"https://elpis.masihmoafi.com/");
  const meta=name=>html.match(new RegExp(`<meta (?:property|name)="${name}" content="([^"]+)"`))?.[1];
  assert.equal(meta("og:url"),canonical);
  assert.equal(meta("og:type"),"website");
  assert.equal(meta("og:title"),html.match(/<title>([^<]+)<\/title>/)[1]);
  assert.equal(meta("og:description"),meta("description"));
  assert.equal(meta("twitter:card"),"summary_large_image");
  assert.equal(meta("twitter:image"),meta("og:image"));
  const image=new URL(meta("og:image"));
  assert.equal(image.origin,new URL(canonical).origin);
  assert.ok(existsSync(new URL("."+image.pathname,root)));
  assert.ok(meta("og:image:alt"));
});
test("crawler files advertise only the canonical homepage and technical guide", async () => {
  const robots=await read("robots.txt");
  assert.match(robots,/User-agent: \*\s+Allow: \//);
  assert.match(robots,/Sitemap: https:\/\/elpis\.masihmoafi\.com\/sitemap\.xml/);
  const sitemap=await read("sitemap.xml");
  assert.match(sitemap,/xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1]),["https://elpis.masihmoafi.com/","https://elpis.masihmoafi.com/technical"]);
  assert.doesNotMatch(sitemap,/<lastmod>|127\.0\.0\.1|prototypes|candidates/);
});

test("current public media and evidence links resolve locally", async () => {
  for (const page of ["index.html", "technical.html"]) {
    const html = await read(page);
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1, `${page}: one page heading`);
    for (const match of html.matchAll(/(?:src|href|data-theme-src-dark|data-theme-src-light)="(\.\/[^"#]+)(?:#[^"]*)?"/g)) {
      const path = match[1].split("?")[0];
      assert.ok(existsSync(new URL(path, root)), `${page}: missing ${path}`);
    }
    if (page === "technical.html") assert.match(html, /elpis-context-ledger-20261013\.png/);
    assert.doesNotMatch(html, /elpis-session-20261013\.png/);
    if (page === "technical.html") assert.match(html, /Context Ledger in the terminal app · 3 November 2026/);
  }
  const html = await read("index.html");
  const ledger = html.indexOf('id="context-ledger-snapshot"');
  assert.ok(ledger > html.indexOf('id="context"') && ledger < html.indexOf('id="install"'));
  assert.doesNotMatch(html, /elpis-ui-20260909\.png/);
  const article = await read("technical.md");
  assert.match(article, /docs\/assets\/demo\.gif/);
  assert.match(article, /docs\/assets\/evidence\.gif/);
  assert.doesNotMatch(html, /dashboard-(?:activity|context|tokens|smart-prune)-20261013/);
  assert.equal([...html.matchAll(/data-dashboard-panel="/g)].length, 0);
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

test("technical page was generated from the maintained article, README and template", async () => {
  const digest = createHash("sha256").update(await read("../readme.md"))
    .update(await read("technical.md"))
    .update(await read("technical-template.html")).digest("hex");
  assert.ok((await read("technical.html")).startsWith(`<!-- README/article/template SHA256: ${digest} -->`));
});

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

test("restores the founding Elpis principle and keeps the install path", async () => {
  const html = await read("index.html");
  assert.match(html, /id="hero-title"[^>]+aria-label="Be Elpis my friend\."/);
  assert.equal([...html.matchAll(/data-hero-brand/g)].length, 2);
  assert.match(html, /<em[^>]*>my friend\.<\/em>/);
  assert.match(html, /You run an agent inside Elpis/);
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
  assert.match(html, /admitted instructions, files and memory/i);
  assert.match(html, /Illustrative run/);
  assert.doesNotMatch(html, /automatic memory|production.ready|zero runtime overhead|cryptographic checkpoint/i);
});

test("shows a clearly labelled illustrated admission walkthrough", async () => {
  const [html, source, script] = await Promise.all([read("index.html"), read("source.css"), read("app.js")]);
  assert.match(html, /data-ace-demo/);
  assert.match(html, /data-shell-command/);
  assert.match(html, /data-shell-enter/);
  const ledger = ledgerMarkup(demoSnapshot(admissionStateAt(0)));
  assert.match(ledger, /CONTEXT LEDGER/);
  assert.match(ledger, /SMART PRUNE/);
  assert.match(ledger, /258\.4k/);
  assert.match(source, /\.ace-demo-stage\s*\{[^}]*position:\s*sticky/s);
  assert.match(script, /"elpis"\.slice/);
  assert.match(script, /position >= 0\.10 && position < 0\.12/);
  assert.match(script, /renderAceDemo/);
  assert.match(ledger, /≈160\.0k tokens in context/);
  assert.match(ledger, /SUBAGENTS/);
  assert.match(html, /data-native-ledger="demo"/);
  assert.doesNotMatch(script, /Total ≈0 tokens admitted|≈(?:7\.9|8\.4)k of 258\.4k|≈0 of 258\.4k used/);
  assert.doesNotMatch(html, /continuity-console|ledger-tui-preview|pruning-pipeline-grid|pruning-diff-container|workgraphs-section|specs-section/);
});

test("removes the rejected dashboard, ACE section and unrequested copy", async () => {
  const html=await read("index.html");
  assert.doesNotMatch(html,/data-context-visual|context-dashboard|id="pruning"|href="#pruning"|Current request|200\.0k|Put continuity|Read installation and source/);
  assert.doesNotMatch(html,/Local, inspectable state|User-chosen context|Provider-native exact resume|Evidence attached|A home shaped around/);
  assert.doesNotMatch(html,/>Live turn<|href="#context"/);
  assert.match(html,/>Demo<|>Demo<\/a>/);
  assert.match(html,/>Vision<|>Vision<\/p>/);
  assert.match(html,/<strong>becomes<\/strong>/);
});

test("keeps glyphs intact and explanations outside document layout", async () => {
  const source=await read("source.css");
  assert.match(source,/\[data-source-mark\]\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(source,/\.native-help-text\s*\{[^}]*position:\s*fixed/);
  assert.match(source,/\.native-help-text\s*\{[^}]*pointer-events:\s*none/);
  assert.doesNotMatch(source,/\.ace-ledger\s*\{[^}]*overflow:\s*auto/);
});

test("plays the entrance once with periodic light sweeps", async () => {
  for(const name of ['elpis-wordmark-amber-loop.svg','elpis-wordmark-amber-light-loop.svg']) {
    const svg=await read('assets/branding/'+name);
    assert.doesNotMatch(svg,/\.(?:ribbon|letter)\{[^}]*infinite/);
    assert.match(svg,/\.ribbon\{[^}]*animation:[^}]*arrive \.65s[^}]*both/);
    assert.match(svg,/\.letter\{[^}]*animation:[^}]*letter \.5s[^}]*both/);
    assert.match(svg,/\.light\{[^}]*animation:[^}]*sweep 6s 1\.05s ease-in-out infinite/);
    assert.match(svg, /-arrive\{from\{[^}]+\}to\{opacity:1;transform:none\}\}/);
    assert.match(svg, /-letter\{from\{[^}]+\}to\{opacity:1;transform:none\}\}/);
    const clip=svg.match(/<clipPath[^>]*>(.*?)<\/clipPath>/)[1];
    assert.equal([...clip.matchAll(/<use href="#[^"]+-path-\d"/g)].length, 7);
    assert.doesNotMatch(clip, /-shape/);
    assert.doesNotMatch(svg,/@media\s*\(prefers-reduced-motion:reduce\)[\s\S]*animation:none/);
  }
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
  assert.ok(targets.length >= 3);
  for (const target of targets) assert.match(html, new RegExp(`id=["']${target}["']`));
  assert.doesNotMatch(html, /googletagmanager|google-analytics|plausible|posthog|segment\.com/i);
});

test("keeps the authored effects available when desktop reduced motion is enabled", async () => {
  const [html, source, script] = await Promise.all([read("index.html"), read("source.css"), read("app.js")]);
  assert.match(html, /class="hero-flow"/);
  assert.match(source, /@media\s*\(max-width:\s*720px\)/);
  assert.match(source, /@keyframes ace-blink/);
  assert.doesNotMatch(source, /animation-duration:\s*\.01ms/);
  assert.doesNotMatch(source, /\.hero-flow circle\s*\{\s*display:\s*none/);
  assert.doesNotMatch(script, /if\s*\(reducedMotion\.matches\)/);
});

test("keeps terminal panes within the viewport and wraps their contents", async () => {
  const source = await read("source.css");
  assert.doesNotMatch(source, /\.ace-terminal\s*\{[^}]*width:\s*1160px/);
  assert.doesNotMatch(source, /minmax\(540px/);
  assert.doesNotMatch(source, /var\(--scan\)\s*\*\s*780px/);
  assert.match(source, /\.ace-raw-line\s*\{[^}]*white-space:\s*normal/);
  assert.match(source, /\.ace-terminal\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(source, /\.ace-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/);
  assert.doesNotMatch(source,/\.ace-demo-stage\s*\{[^}]*position:\s*relative/);
});

test("logo images and their home links cannot start native dragging", async () => {
  for (const page of ['index.html','technical-template.html','technical.html']) {
    const html=await read(page);
    const images=[...html.matchAll(/<img\b[^>]*\bdata-(?:brand-logo|hero-brand)[^>]*>/g)].map(match=>match[0]);
    assert.ok(images.length>=2);
    for (const image of images) assert.match(image,/draggable="false"/,`${page}: logo image must not drag`);
    const home=html.match(/<a\b[^>]*aria-label="Elpis home"[^>]*>/)?.[0];
    assert.match(home,/draggable="false"/,`${page}: logo link must not drag`);
  }
});


test("honours the annotated content removals and selective emphasis", async () => {
  const html = await read("index.html");
  for (const removed of ["continuity", "current-interface", "current-evidence", "dashboard"]) {
    assert.doesNotMatch(html, new RegExp(`(?:id|href)="(?:#)?${removed}"`));
  }
  assert.match(html, /<strong>Curate<\/strong> what/);
  assert.match(html, /<strong>Inspect<\/strong>/);
  const ledgerStart = html.indexOf('id="context-ledger-snapshot"');
  const ledger = html.slice(ledgerStart, html.indexOf("</section>", ledgerStart));
  assert.doesNotMatch(ledger, /<figcaption/);
  assert.match(ledger, /data-native-ledger="example"/);
  assert.doesNotMatch(ledger, /<img/);
  assert.doesNotMatch(html,/Your agent\. Your environment\./);
});


test("theme selection is present before logo paint and never swaps its source", async () => {
  for (const file of ["index.html", "technical-template.html"]) {
    const html=await read(file);
    const logos=[...html.matchAll(/<img data-brand-logo[^>]+>/g)].map(m=>m[0]);
    assert.equal(logos.length,2);
    assert.match(logos[0],/data-theme-image="dark"/);
    assert.match(logos[1],/data-theme-image="light"/);
    for(const logo of logos) assert.match(logo,/\?v=amber-20261020/);
  }
  const script=await read("assets/branding/brand.js");
  assert.doesNotMatch(script,/data-brand-logo|wordmark/);
  assert.match(await read("assets/branding/brand.css"),/\[data-theme-image="light"\]/);
  const html=await read("index.html");
  const heroLogos=[...html.matchAll(/<img data-hero-brand[^>]+src="([^"]+)"/g)].map(m=>m[1]);
  const headerLogos=[...html.matchAll(/<img data-brand-logo[^>]+src="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(heroLogos,headerLogos);
  assert.doesNotMatch(html, /<(?!html\b)[a-z][^>]*\sdata-theme="elpis"|same result|gpt-5\.6|ace-ledger-foot/);
  assert.doesNotMatch(await read("app.js"),/Ask a follow-up/);
  assert.match(html, /Illustrative run/);
  assert.match(html, /data-prune-flash/);
});

test("Workflows exposes flat and isometric controls for its 3D board", async () => {
  const html = await read("index.html");
  const scene = html.slice(html.indexOf('id="workflows"'), html.indexOf('id="love-spot"'));
  assert.match(scene, /data-wf-view="flat"[^>]*aria-pressed="true"[^>]*>Flat<\/button>/);
  assert.match(scene, /data-wf-view="isometric"[^>]*aria-pressed="false"[^>]*>Isometric<\/button>/);
  assert.match(scene, /class="wf-board"[^>]*data-wf-board[^>]*data-view="flat"/);
});
