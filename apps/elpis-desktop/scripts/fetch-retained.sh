#!/usr/bin/env bash
# Fetch the retained UI baseline and every pinned retained test into a shallow CI checkout.
# Pins are fetched by blob id: some approval commits were never pushed (1 Nov), but each blob is on the remote.
set -euo pipefail
gate='import { retainedUpdates, baselineCommit } from "./scripts/renderer-artifact-gate.mts";'
baseline=$(node --input-type=module -e "$gate console.log(baselineCommit)")
git cat-file -e "$baseline^{commit}" 2>/dev/null || git fetch --no-tags --depth=1 origin "$baseline"
missing=$(node --input-type=module -e "$gate for (const pin of Object.values(retainedUpdates[baselineCommit] ?? {})) console.log(pin.blob)" \
  | sort -u | while read -r blob; do git cat-file -e "$blob" 2>/dev/null || echo "$blob"; done)
if [ -n "$missing" ]; then git fetch --no-tags --depth=1 --filter=blob:none origin $missing; fi
