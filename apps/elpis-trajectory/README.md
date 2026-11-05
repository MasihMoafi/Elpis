# Elpis Trajectory

A standalone, read-only trajectory ledger. It fetches `GET /api/trajectory` once using the version 1 contract in `docs/specs/trajectory-contract.ts`. A missing or invalid API response shows an error in the built page. During Vite development only, it falls back to `fixtures/sample.json`.

Run with Node from `/usr/local/node/bin`:

```sh
npm install --no-package-lock
npm run dev
npm run typecheck
npm test
npm run build
```

The browser tests launch a temporary local Vite server and headless Google Chrome. Set `CHROME_PATH` if Chrome is installed elsewhere. The build writes the embeddable page and its third-party notices to `dist/`; its assets use relative paths. The server that provides the API and serves `dist/` is a separate Elpis task.

The ledger, timeline, toolbar, theme tokens, and virtual-row logic are adapted from DeepSeek Harness. The standalone page replaces its framework services with local props and small UI shims. It follows the system light or dark theme. Drag the timeline to filter; use the wheel to zoom and right-click to clear the selection. Fold turns, calls, or subcalls from the toolbar; double-click an eligible row to fold it individually.

The contract does not supply attachment images, original source blocks, request options, tool-catalog snapshots, previous prompts, or live tool results. Those DeepSeek inspector features are unavailable. It also has no explicit parent identifier for subtools, so nesting follows the recorded order. If several requests share a group, the contract does not identify which request owns each record; the page leaves those associations unclaimed. Markdown, JSON, icons, and tooltips use lightweight local renderers rather than DeepSeek's shared primitives. Missing values are shown as unrecorded; partial input buckets are not presented as a total.

DeepSeek Harness is Copyright (c) 2026 DeepSeek, MIT License. Full notices for the port and bundled dependencies are in `src/public/THIRD-PARTY-NOTICES.txt` and the built page's `THIRD-PARTY-NOTICES.txt`.
