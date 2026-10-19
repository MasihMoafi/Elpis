# A29 · preserve rejected browser comments

Continue Opus's Enter-to-send work while preserving the newer Draw/Settings/Lab/F2 integration at 36f9618cf. Native comment commands can reject; useBrowser exposes that as an undefined response. Typed text must remain until a save succeeds.

- Enter and Ctrl+Enter keep the exact draft and existing pending comments when saving fails.
- A rejected save never collects, sends or clears older comments. Keep the existing browser error visible without duplicating it in the annotation toolbar.
- Retrying succeeds once: Enter sends both comments to the existing chat; Ctrl+Enter saves without sending, then Send includes both.
- Preserve Shift+Enter, scoped browsers, Draw and existing controls. No provider calls, real profiles or unrelated worker edits.
- Evaluate with real keys in the existing browser-panel fixture: rejection cases must fail before the change and pass after it. Run the full browser-panel file, adjacent drawing checks, types and inventory; inspect light/dark captures.
