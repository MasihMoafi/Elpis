# Dashboard development without Rust rebuilds

From this checkout, use the production HTML/CSS/JS with an explicit illustrative fixture:

```sh
node tools/dashboard-preview/server.mjs --fixture codex-rs/tui/src/dashboard_assets/fixtures/activity-state.json
```

Open `http://127.0.0.1:43124`. Edit dashboard JavaScript/HTML and refresh; edit
`source.css` and run the dashboard asset package's CSS build before refreshing.
The server rereads the assets. It does not invoke Cargo or modify the installed binary.
The visible preview badge distinguishes illustrative figures from actual measurements.

For actual local state, open `/dashboard` in Elpis, note its loopback port, and run:

```sh
node tools/dashboard-preview/server.mjs --live http://127.0.0.1:PORT/data.json
```

Replace `PORT` with that dashboard's port. Only explicit loopback data URLs are accepted.
Missing live data yields unavailable state; the preview never falls back to fixtures.
This developer loop leaves the installed dashboard's embedded assets unchanged until
the next verified optimized installation. It solves web styling iteration, not Rust TUI iteration.
