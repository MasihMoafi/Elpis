# Sent-message pencil — 19 October 2026

Reproduced: an older history cursor makes the pencil unavailable even for a complete later Claude turn. A descending item page can truncate only its oldest loaded turn. Permit an otherwise eligible later turn once an earlier-turn boundary is visible; keep the oldest potentially partial turn blocked. The existing bridge independently reads every page of the selected turn before thread/revert.

The pencil and Edit and retry must open the existing editor with exact sent text. Cancel or Escape preserves history and the composer. Deliberate Send uses beforeTurnId/text through existing replacement. Failed Send keeps the revision and displays the error. Delivered follow-ups, attachments, loading, read-only and active-turn restrictions remain unchanged. No API or visual redesign.

Evidence: ~/.cache/elpis-tests/message-edit-20261019-dfdyecqh/; baseline UI1fail/1pass (recent turn refused; incomplete/follow-up controls protected); eligibility5pass and types pass. Ordinary/Claude/long complete-history baseline edits work; real X11/native browser split pencil and Cancel pass1320/1100 widths. Renderer candidate checks pending. Screenshot alone cannot identify its exact history shape.

The parent reviews/integrates; no real profiles, inference, installations, or save-worktree changes. User acceptance stays open. Rollback: revert the focused commit. Escalate a change to replacement semantics or native hit-testing.
