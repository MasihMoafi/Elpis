# Session Manager placement and activity review — 20 October 2026

Masih wants Session Manager above every chat and an always-on agent triggered by
three new chats within approximately twenty minutes, or chats running together.
His screenshot shows the manager below Projects. The dedicated manager currently
runs only when prompted; its existing tools list session metadata and propose or
perform approved naming, grouping, and single-session archiving.

Placement: keep one manager entry below search, above Projects and the scrolling
chat list. Searching and scrolling must leave it accessible. Reopening must retain
the existing saved manager identity and conversation.

Proposed activity behavior (clarification pending): while the desktop is open,
review priorities and suggested groups after three new chats within twenty
minutes or three concurrent chats. Reviews belong in the dedicated manager chat;
no automatic messages to other chats. Queue a single review if the manager is
busy; avoid repeated reviews of an unchanged running set. Existing approval rules
for rename, organize, and archive stay intact. Metadata is untrusted data.

Activity implementation still needs a desktop-owned monitor, serialized creation
of the same persisted manager from the UI and monitor, shutdown cleanup, visible
error handling, and tests covering threshold boundaries, duplicate events,
concurrent creation, a busy manager, reconnection, and shutdown. A failed turn
request with unknown delivery must not be blindly retried.

Checkpoint: placement source and browser regression are written; regression
fails against unchanged compiled 820425edd at the scrolling-list assertion.
New renderer build, green browser run, visual check, and activity implementation
remain pending. No activation, process restart, credential or workspace edits.
