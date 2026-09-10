# Elpis TUI code prototypes

Three browser-based interaction studies constrained to layouts and controls that
can be implemented in Ratatui. They reuse the real Elpis live-turn, Context
Ledger, continuity, permission, and evidence concepts; they do not propose a web
rewrite of the terminal application.

| Direction | Comparison axis | Intended role |
| --- | --- | --- |
| Goal cockpit | Live-turn orientation with minimal structural change | Safest candidate for the default TUI |
| Continuity spine | Session handoff and checkpoint traceability | Dedicated continuity inspection mode |
| Ledger workbench | Context admission and provenance control | Full-screen `/context` evolution |

## Run locally

From `website/`:

```sh
node_modules/.bin/tailwindcss -i prototypes/source.css -o prototypes/styles.css --minify
node prototypes/tests/prototypes.test.mjs
python3 -m http.server 4173
```

Open <http://127.0.0.1:4173/prototypes/>. Use the tabs or number keys `1`–`3`
to switch directions.

