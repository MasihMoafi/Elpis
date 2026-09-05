# Persistent identity candidate

Optional, illustrative layout for review. No existing website assets are replaced.
The ELPIS pixel logo comes from the candidate TUI's `startup_animation.rs` and stays
above the conversation. The Ledger uses one full-window bar. A source toggle changes
the pending choice; only **Next fixture request** applies it to the displayed count.

Run locally from this directory:

```sh
node preview.mjs
node --test fixture.test.mjs
```

Open `http://127.0.0.1:43127`. Replay resets the fixture; Pause also stops the logo.
Reduced-motion preferences pause autoplay initially. Resume is an explicit opt-in.

[Recorded illustrative demo](demo.webm): 7.05 seconds, 1440×1280 VP9, captured
from the actual candidate page. The desktop/mobile PNGs and replay video are new
review assets; none replaces an existing deployed image. `record-demo.mjs` records
through Chromium CDP and the system ffmpeg with one encoding thread; it refuses
to overwrite an existing recording. It requires the local Playwright module path
used by the script, not a dependency download.

All token values and optimizer results are fixtures. This is not a product recording,
cache benchmark, or evidence that the installed runtime behaves as illustrated.

`styles.css` is a checked-in, offline Tailwind 4 / daisyUI 5 bundle. Rebuild on this
workstation from the repository root, using the existing installed dependencies:

```sh
node /home/masih/Desktop/p/Elpis/website/node_modules/@tailwindcss/cli/dist/index.mjs -i website/candidates/persistent-logo/source.css -o website/candidates/persistent-logo/styles.css --minify
```

The source CSS points to those local dependencies; update the three package paths
when rebuilding on a different machine. Viewing the compiled candidate needs no install.

Local verification: two fixture tests pass. Chromium interaction verified that an
ES.md exclusion keeps the count at 51,600 until the next fixture request, which
changes it to 50,800. No page errors or mobile horizontal overflow were observed.
`desktop.png` (1440px wide) shows the pending state; `mobile.png` (390px wide) shows
the applied state. Both were rendered from this candidate and visually inspected.
