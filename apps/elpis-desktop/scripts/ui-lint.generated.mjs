// @ts-nocheck
// Generated from skills/web-dev/ui-check/lint.mjs; node scripts/ui-lint-sync.mts --write; sha256=e09fa73bbd0b1930a27d0442d921d8657881ba8e833461448eb68f4d187072e2
// Static half of ui-check: finds UI-RULES.md violations in source text, no browser needed.
// shadcn's own components/ui source is the standard, so only R1 and R6 apply inside it.
// A line that must break a rule on purpose carries the marker `ui-check-ignore` and a reason.
import { readFile, readdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";

const EXTS = new Set([".tsx", ".jsx", ".css", ".scss", ".html"]);
const ICON_LIBS = ["lucide-react", "@phosphor-icons/react", "react-icons", "@heroicons/react", "@tabler/icons-react", "@radix-ui/react-icons"];
const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

// [rule, applies to file?, pattern, message]
const CHECKS = [
  ["R1", () => true, /\b(min-h|max-h|h)-screen\b/, "h-screen is 100vh and overflows on mobile; use h-dvh"],
  ["R1", () => true, /\b100vh\b/, "100vh overflows on mobile; use 100dvh"],
  ["R1", () => true, /\boverflow(-[xy])?-scroll\b|overflow(-[xy])?\s*:\s*scroll/, "overflow: scroll shows a scroll bar even when nothing overflows; use auto"],
  ["R3", f => !f.uiKit, /(?<![\w-])-?(p[xytblrse]?|m[xytblrse]?|gap(-[xy])?|space-[xy])-\[[^\]]+\]/, "arbitrary spacing value; use the Tailwind spacing scale"],
  ["R4", f => f.css && !f.uiKit, /(:|\s|,)#[0-9a-fA-F]{3,8}\b/, "raw hex colour; use a theme token"],
  ["R4", f => !f.css && !f.uiKit, /\[#[0-9a-fA-F]{3,8}\]|["'`]#[0-9a-fA-F]{3,8}["'`]/, "raw hex colour; use a theme token"],
  ["R4", f => !f.uiKit, /\b(rgba?|hsla?|oklch|oklab|lch|lab)\((?!\s*var\()/, "raw colour function; use a theme token"],
  ["R4", f => !f.css && !f.uiKit, new RegExp(`(?<![\\w-])(bg|text|border|ring|fill|stroke|from|via|to|outline|divide|accent|caret|decoration)-(${PALETTE})-\\d{2,3}\\b`), "raw palette colour; use a theme token such as bg-card or text-muted-foreground"],
  ["R4", f => !f.css && !f.uiKit, /(?<![\w-])(bg|text|border)-(black|white)\b/, "raw black/white; use a theme token so both themes work"],
  ["R5", f => f.markup && !f.uiKit, /<(button|input|select|textarea|dialog)\b/, "hand-written control; use the shadcn/ui component from components/ui"],
  ["R6", () => true, /[▼▶▾▸◀▲►◄▴▿]/, "disclosure triangle; Masih bans them"],
  ["R6", f => f.markup, /<details\b/, "<details> draws a disclosure triangle; use the shadcn Collapsible"],
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (EXTS.has(extname(entry.name))) yield path;
  }
}

export async function readConfig(projectDir) {
  const raw = await readFile(join(projectDir, "ui-check.json"), "utf8").catch(() => null);
  return raw ? JSON.parse(raw) : null;
}

export async function lint(projectDir, config) {
  config ??= (await readConfig(projectDir)) ?? {};
  const themeFiles = new Set(config.themeFiles ?? []);
  const ignore = (config.ignore ?? []).map(p => new RegExp(p));
  const findings = [];

  const pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8").catch(() => "{}"));
  const icons = ICON_LIBS.filter(lib => ({ ...pkg.dependencies, ...pkg.devDependencies })[lib]);
  if (icons.length > 1) findings.push({ rule: "R7", file: "package.json", line: 1, msg: `${icons.length} icon libraries (${icons.join(", ")}); keep one` });

  for (const src of config.src ?? ["src"]) {
    for await (const path of walk(join(projectDir, src))) {
      const file = relative(projectDir, path);
      if (themeFiles.has(file) || ignore.some(re => re.test(file))) continue;
      const ext = extname(file);
      const kind = { css: ext === ".css" || ext === ".scss", markup: ext !== ".css" && ext !== ".scss", uiKit: /(^|\/)components\/ui\//.test(file) };
      const lines = (await readFile(path, "utf8")).split("\n");
      lines.forEach((text, i) => {
        if (text.includes("ui-check-ignore")) return;
        for (const [rule, applies, pattern, msg] of CHECKS) {
          if (applies(kind) && pattern.test(text)) findings.push({ rule, file, line: i + 1, msg });
        }
      });
    }
  }
  return findings;
}
