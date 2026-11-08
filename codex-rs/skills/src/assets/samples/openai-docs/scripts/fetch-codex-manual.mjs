#!/usr/bin/env node
// Generated from codex-rs/skills/assets-src/openai-docs/fetch-codex-manual.mts by scripts/emit-compat-js.mts; do not edit.
import { DEFAULT_MANUAL_URL, fetchCodexManual } from './manual-fetch.mjs';

import { proxyConfigured } from './manual-transport.mjs';
import { ManualFetchError } from './manual-errors.mjs';


import process from "node:process";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

const manualStatusLine = (status              ) =>
  status.cacheStatus === "hit"
    ? "Manual status: local manual was already current."
    : "Manual status: local manual was updated.";

const formatResult = ({ status, outlineText }                                               ) =>
  [
    `Manual path: ${status.manualPath}`,
    `Outline path: ${status.outlinePath}`,
    manualStatusLine(status),
    "",
    outlineText,
  ].join("\n");

const parseArgs = (argv          ) => {
  const args                                                                                                          = {
    manualUrl: DEFAULT_MANUAL_URL,
    cacheDir: undefined,
    timeoutMs: 30000,
    statusJson: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manual-url") {
      args.manualUrl = argv[++index];
    } else if (arg === "--cache-dir") {
      args.cacheDir = argv[++index];
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[++index]);
    } else if (arg === "--status-json") {
      args.statusJson = true;
    } else {
      throw new ManualFetchError(`Unknown argument: ${arg}`);
    }
  }

  if (!args.manualUrl) {
    throw new ManualFetchError("--manual-url cannot be empty.");
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new ManualFetchError("--timeout-ms must be a positive number.");
  }

  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const { outlineText, status } = await fetchCodexManual(args);

  process.stdout.write(formatResult({ status, outlineText }));

  if (args.statusJson) {
    console.error(JSON.stringify(status));
  }
};

const envProxyHint = () => {
  if (proxyConfigured()) {
    return "Hint: proxy env vars are present. This helper prefers `curl` in proxied sessions; if requests still fail, verify `curl` is installed and the proxy configuration is valid.";
  }
  if (typeof fetch !== "function") {
    return "Hint: native fetch is unavailable in this Node runtime. Install `curl` or use a newer Node version to fetch the manual.";
  }
  if (process.platform === "win32") {
    return "Hint: on Windows, pass a cache dir under `%TEMP%` or `%TMP%`.";
  }
  return null;
};

const formatErrorDetails = (error       ) => {
  const details = inspect(error, {
    breakLength: 120,
    colors: false,
    compact: false,
    depth: 8,
  });
  if (!error?.cause) {
    return details;
  }

  return `${details}\n\nCause:\n${inspect(error.cause, {
    breakLength: 120,
    colors: false,
    compact: false,
    depth: 8,
  })}`;
};

const isCliEntrypoint = () => {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return pathToFileURL(entrypoint).href === import.meta.url;
};

if (isCliEntrypoint()) {
  main().catch((error       ) => {
    console.error(`Error: ${error.message}`);
    const hint = envProxyHint();
    if (hint) {
      console.error(hint);
    }
    console.error("");
    console.error("Details:");
    console.error(formatErrorDetails(error));
    process.exitCode = 1;
  });
}

export { DEFAULT_MANUAL_URL, fetchCodexManual };
