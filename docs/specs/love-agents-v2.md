# Love Spot agents v2

Masih's 19 October worker brief is the acceptance contract. Local candidate only; acceptance remains Masih's.

- Press A outside text controls, then click the board: create one Researcher at that point, open its right panel and tab. Escape cancels placement. Undo removes the card and tab.
- Choose any of six characters: create it immediately at the viewport centre, without a task form, and open its panel.
- Opening a new agent starts its ACP role interview. Ask one short question per turn in the panel. Answers support typing and existing voice dictation. A one-line task proposal enables Start or Enter; no task run before confirmation.
- Persist interview turns on the card. Reject malformed/oversized replies visibly, preserve answers on failure, serialize same-card requests, and never restore a deleted card from a late reply. Closing/reopening must not duplicate a question.
- Refine each current portrait with imagegen (multiple variants, at most four per character), select and trace through SVG Studio multicolour. Keep sources/picks in the requested cache. Embed genuine multicolour paths in the renderer so saved boards remain self-contained.
- Menu portraits ≥48px, card portraits 96px, readable portraits in tabs. Inspect menu/card/interview in light and dark at normal and narrow widths.
- Existing default preset portraits upgrade on load; retain tasks, custom image sizes and neighbouring drawings. Canonical SVGs drive menus/tabs; the board uses 512px renders of those SVGs because Excalidraw inverts SVG paint in dark mode.

Plan: failing UI tests using fake ACP → placement/interview implementation → art generation/tracing → affected suites, types, renderer build and desktop/bridge checks → report evidence and commits in the worker brief.
Boundaries: retain connected-agent execution, permission requests and ordinary drawing. No package installs, external browsing, deployments or real profile changes.
Rollback: revert only this task's focused commits after coordinator review. Existing scenes remain readable because new interview fields are optional.
