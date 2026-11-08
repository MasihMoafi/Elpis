#!/usr/bin/env node

// Keep this entrypoint CommonJS-safe when the skill is copied into a type=module repo.

const fs = require("node:fs/promises") as typeof import("node:fs/promises");
const path = require("node:path") as typeof import("node:path");

const DEFAULT_URL =
  "https://developers.openai.com/api/docs/guides/latest-model.md";
const DEFAULT_BASE_URL = "https://developers.openai.com";

function parseArgs(argv: string[]) {
  const args: { source: string | undefined; baseUrl: string | undefined } = {
    source: process.env.LATEST_MODEL_URL || DEFAULT_URL,
    baseUrl: process.env.LATEST_MODEL_BASE_URL || DEFAULT_BASE_URL,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source" || arg === "--url") {
      args.source = argv[i + 1];
      i += 1;
    } else if (arg === "--base-url") {
      args.baseUrl = argv[i + 1];
      i += 1;
    }
  }

  return args;
}

async function readSource(source: string | undefined) {
  if (source === undefined) {
    throw new TypeError("Cannot read properties of undefined (reading 'startsWith')");
  }
  if (source.startsWith("file://")) {
    return fs.readFile(new URL(source), "utf8");
  }

  if (!/^https?:\/\//.test(source)) {
    return fs.readFile(path.resolve(source), "utf8");
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(source, {
        headers: { accept: "text/markdown,text/plain,*/*" },
      });

      if (response.ok) {
        return response.text();
      }

      lastError = new Error("failed to fetch " + source + ": " + response.status);
      if (response.status < 500 && response.status !== 429) {
        break;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  throw lastError;
}

function parseIndentedInfo(lines: string[], startIndex: number) {
  const info: Record<string, string> = {};

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (!line.trim()) {
      continue;
    }

    const match = line.match(/^ {2}([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*$/);
    if (!match) {
      break;
    }

    const [, key, value] = match;
    if (key === undefined || value === undefined) break;
    info[key] = value.replace(/^["']|["']$/g, "");
  }

  return info;
}

function parseFlatInfo(block: string) {
  const info: Record<string, string> = {};

  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*$/);
    if (match) {
      const [, key, value] = match;
      if (key === undefined || value === undefined) continue;
      info[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  return info;
}

function extractLatestModelInfo(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const latestModelInfoIndex = lines.findIndex((line) =>
    /^latestModelInfo:\s*$/.test(line)
  );

  if (latestModelInfoIndex >= 0) {
    return parseIndentedInfo(lines, latestModelInfoIndex);
  }

  const commentMatch = markdown.match(
    /<!--\s*latestModelInfo\s*\n([\s\S]*?)\n\s*-->/m
  );
  if (commentMatch && commentMatch[1] !== undefined) {
    return parseFlatInfo(commentMatch[1]);
  }

  return undefined;
}

function modelToSkillSlug(model: string) {
  return model.trim().replace(/\./g, "p");
}

function absoluteUrl(baseUrl: string | undefined, value: string) {
  return new URL(value, baseUrl).toString();
}

function normalizeInfo(info: Record<string, string>, baseUrl: string | undefined) {
  const model = info?.model?.trim();
  const migrationGuide = info?.migrationGuide?.trim();
  const promptingGuide = info?.promptingGuide?.trim();

  if (!model || !migrationGuide || !promptingGuide) {
    throw new Error(
      "latestModelInfo must include model, migrationGuide, and promptingGuide"
    );
  }

  return {
    model,
    modelSlug: modelToSkillSlug(model),
    migrationGuideUrl: absoluteUrl(baseUrl, migrationGuide),
    promptingGuideUrl: absoluteUrl(baseUrl, promptingGuide),
  };
}

async function main() {
  const { source, baseUrl } = parseArgs(process.argv);
  const markdown = await readSource(source);
  const info = extractLatestModelInfo(markdown);

  if (!info) {
    throw new Error(`latestModelInfo block not found in ${source}`);
  }

  process.stdout.write(
    `${JSON.stringify(normalizeInfo(info, baseUrl), null, 2)}\n`
  );
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
