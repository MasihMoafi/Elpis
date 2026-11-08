'use strict';
import type * as NodeFs from 'node:fs';
import type * as NodePath from 'node:path';
const fs: typeof NodeFs = require('node:fs');
const path: typeof NodePath = require('node:path');

// The shared-session test needs each complete agy prompt, including queued follow-ups.
function writeSharedProviderAgyFixtureImpl(agy: string, calls: string) {
  fs.writeFileSync(agy, `#!/usr/bin/env node
const fs = require('node:fs');
const newline = String.fromCharCode(10);
let pending = '';
const logPrompt = input => {
  if (input) fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ method: 'agy/prompt', args: process.argv.slice(2), input }) + newline);
};
if (process.argv.includes('--input-format')) {
  process.stdin.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf(newline)) >= 0) { logPrompt(pending.slice(0, end)); pending = pending.slice(end + 1); }
  });
  process.stdin.on('end', () => logPrompt(pending));
}
process.argv.push('--agy-fixture');
require(${JSON.stringify(path.resolve(__dirname, '../permissions-bridge.test.cts'))});
`, { mode: 0o755 });
}

export declare const writeSharedProviderAgyFixture: typeof writeSharedProviderAgyFixtureImpl;
exports.writeSharedProviderAgyFixture = writeSharedProviderAgyFixtureImpl;
