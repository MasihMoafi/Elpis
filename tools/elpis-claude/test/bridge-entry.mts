import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Historical baselines can predate the TypeScript entry point. */
export function bridgeEntry(directory: string) {
  const typed = join(directory, 'acp-bridge.mts');
  return existsSync(typed) ? typed : join(directory, 'acp-bridge.mjs');
}

/** A split bridge's provenance covers every runtime module, not only its entry point. */
export function bridgeSourceDigest(directory: string) {
  const hash = createHash('sha256');
  for (const name of readdirSync(directory).filter(name => /\.(?:mjs|mts)$/.test(name) || name === 'package.json' || name === 'package-lock.json').sort()) {
    hash.update(name).update('\0').update(readFileSync(join(directory, name))).update('\0');
  }
  return hash.digest('hex');
}
