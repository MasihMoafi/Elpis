# Workflow feedback · 19 October 2026

Contract: the user supplied workflows-feedback.md and WORKER-RULES.md govern this task.

- Flat canvas: AutoCAD left-to-right window selects fully enclosed agents/notes;
  right-to-left crossing selects touched agents/notes. Solid/dashed boxes use different
  theme tints. Shift adds. Selection never moves nodes. Isometric empty-board drags
  remain panning: that view has no box selection.
- Ctrl+Delete and “Delete, keep the flow” reconnect surviving endpoints across one
  or several removed agents, including alongside, feedback and implicit Mother links.
  Preserve link semantics, prevent self-links, new cycles and duplicate endpoint pairs.
  Show the deleted names and kept-link count with Undo. Plain Delete only removes.
- Provider changes filter the Model list, keep an offered model, otherwise select
  the configured provider default (or first offered model). Never offer another
  provider's models. Shared settings cover flat/isometric inspectors and Dashboard.
  Loading/error/empty catalogs do not silently select a foreign model.

Plan: add failing mouse/keyboard UI reproductions, fix the shared canvas paths,
then check affected suites, types, renderer, bridge and desktop. Inspect light/dark
screenshots. No runtime calls, installs, real-profile changes, pushes or downloads.
Undo restores the full graph. User acceptance and coordinator integration remain open.
