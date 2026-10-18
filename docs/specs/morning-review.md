# Morning installation review · 19 October 2026

Contract: the explicitly assigned night-review.md checklist governs this review.
Fresh desktop startup and ACP cards must find provider tools in both the legacy
bundle and the complete CLI package (package/bin/codex, tools at bundle root).
An explicit external socket stays external; missing tools fail with a useful error.
One shared path resolver serves runtime startup and ACP cards and is packaged.
Before the fix, the two complete-package regression cases must fail. Afterward,
legacy/packaged and missing-tool cases, package closure and the full gate must pass.
Workflow test scratch data must be trashable on this machine, under its home cache.
Install the current night adapter through the official engine installer, retaining
its checked Rust executable; verify scoped writer/read-only metadata on that adapter.
Then install the clean desktop commit and check both themes on a private display.
Keep real profiles and boards untouched except the authorized fixes-list replacement.
Rollback uses each official installer's printed previous-selection command.
No changes to context, memory, session semantics or Rust behavior are in scope.
