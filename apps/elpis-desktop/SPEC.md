# Elpis desktop requirements

These are the required behaviors. [ES.md](../../ES.md) records current state and open decisions; [REQUESTS.md](../../REQUESTS.md) records requests. Project rules are in [MASIH-RULES.md](../../docs/MASIH-RULES.md), the design system in [DESIGN.md](DESIGN.md), and verification in [TESTING.md](TESTING.md).

## Sidebar and chat list

- Session Manager is removed. (S18)
- Pinned, Projects, Groups and Recents show chats the person started or placed. Recents excludes project chats. Workflows and background runs have separate, collapsible sections controlled by switches that default to off; search can find matching child chats. (S13, S18, OM1, OM2, R41)
- Native subagents, workflow steps and manually arranged chats form one recursive tree. Each generation has one indentation step; only rows with children show a chevron. Branches start collapsed. Load-more controls expose further children without losing their parents. (O1, C4, A154, R23, R45, R73)
- A subtree can move under another chat, into a project or back to the main list. Moving a parent keeps its descendants. Reject cycles and self-drops; preserve the engine task and permissions. Save placement and order together, retain the selection on failure, and open a successful move's destination. (O1, O2, R73)
- “Move to project…” and “New project from these…” work on every selected chat, including a running one. Creating a project asks for a name and a folder from a menu or chooser. Cancellation and failed saves leave chats unchanged. (O2)
- Chats needing the person precede working chats. A newly finished unread chat follows the working chats, before idle chats. Status follows R8 and R44; user-assigned conversation colours follow R84 and remain distinct from status. Colours can be reset and survive reload, including for nested agents. (S22, C8, A153)
- An unnamed chat the person started receives a task name after its first completed message: a read-only side turn uses the small naming model at low effort, or the chat model if unavailable. Save a title of at most 36 characters only if still unnamed; a manual rename cancels it, and scans or timers do not trigger naming. Background and workflow runs retain their parent and identity; opening one does not send a model request. (S18)
- The person can pin, archive, rename, reorder and open chats; F2 renames the selected chat. Bookmark and ordering changes survive reload. Menus group organization and Open in actions, and singular or multi-selection labels match their targets; Show agents appears only when a chat has agents. (C8)
- The Love Spot, Projects, Pinned, Recents, Groups and Workflows sections fold. The sidebar shows complete rows above its footer and remains usable at every window height. (S25, OM2, A159–A161)
- Arrow keys open the reached chat or page and select the reached tab or radio. Search, New chat and switches receive focus without activation. Ctrl+[ and Ctrl+] move a chat to the top or bottom of its list; Ctrl+Alt+[ and Ctrl+Alt+] change split-view focus. (S22, R12)

## Chat, composer and turns

- Sent input appears at once. Drafts survive navigation, reconnect and restart. Typing stays available while disconnected; runtime actions explain when a connection is required and are not replayed automatically. Messages queued during a turn remain in order. (S34, C5, R2, R3, R4, R66, R69)
- The composer stays on one row at narrow widths. Thinking and effort remain visible; secondary controls move into the Plus menu. Fast applies at the next model request in the running turn and shows the acknowledged state. (S32, S35, C5, R85, R87)
- User and assistant messages render in full, without Collapse or Expand previews. Copy retains the complete message. Image replies identify the selected image and source message, show a thumbnail, focus the composer and preserve unrelated attachments and drafts; failed image reads show an error. (S image replies, R27)
- Hide a Reasoning disclosure when no recorded or streamed summary exists. Preserve actual summaries, history and copying. A finished turn says “Worked for …” when its timing is known; otherwise it summarizes the recorded activity by kind. (S36, R88)
- The prompt rail appears from the second prompt onward. It stays beside the transcript without squeezing the chat or moving Working. The Working placement is owned by [DESIGN.md](DESIGN.md#5-layout). (C6, R24)
- Message actions, activity rows and Load earlier messages keep the spacing in the design system. Loading earlier messages preserves the reading position and offers retry on failure. (C6)
- `/resume` opens a searchable saved-chat chooser even with the sidebar closed. Loading, empty, error and retry states are visible; opening a result does not send a turn. Escape and outside dismissal return focus. `/clear` works in the selected chat, and Select all acts on the focused editor or board. (C5)
- The skills switch updates immediately and returns to its earlier state with a reason if the write fails. A displayed label is not an action. (S27, A165)

## Context, goals and files

- `/goal <condition>`, `/goal` and `/goal clear` set, read and clear the selected chat's goal through its runtime. Refusals are visible and commands do not become user messages.
- The Context panel shows the selected chat's goal with Clear, admitted files and project `ES.md`; files use the editable Files pane. A missing `ES.md` offers Create without replacing an existing file. Switching chats cannot display or change another chat's context; a rejected write preserves the existing state and offers retry.
- `document_open` opens the requested existing text file in its own chat's Files pane, editable by default. It reports success after renderer acknowledgement; missing, binary, oversized and unavailable files return a clear error. (DOC1, DOC3)
- `document_read` returns saved text, modification time and whether the editor has unsaved edits. Drafts survive reopening. Save and Ctrl+S make changes available to the agent; stale disk writes are refused without losing the draft. Another chat, window or website cannot acknowledge the request. (DOC2–DOC4, R3)
- HTML and HTM files open in a rendered preview with bounded source access. Project-local classic CSS and JavaScript run in an opaque sandbox without changing project files. Unsupported resources are reported. (C10)
- Text above the 512 KB editable limit remains readable in bounded pages up to the 30 MB preview cap. File cards and document selections offer editable feedback for the agent; sending stays explicit. HTML selections are accepted only from their own preview frame. (C10)
- Empty Files uses a compact tree width. Opening a document restores the deliberate width or a readable default; closing the last file returns to the compact width. The divider remains resizable. (R18, R25)

## Browser and annotations

- Each chat has its own browser. Its tabs, address, history, reload and stop controls work without exposing the Elpis runtime to websites. Browser settings follow the ChatGPT desktop reference. (R10, R39)
- Tab selection supports Shift ranges and grouped, icon-led actions. Close other tabs and Close tabs to the right affect the intended tabs; unselected tabs and deliberate panel sizes are preserved. An empty pane does not reopen as a wide blank view. (C9, R76)
- Drawing uses the browser's own box over a still image; Add or Close restores the live page without moving the surrounding layout. Chat pauses drawing and focuses the composer; Resume restores the marks. (S21, M2, A151)
- Enter sends a browser annotation once and in order. The sent message shows the person's comments, not the internal note for the model. Popup and dialog elements can be annotated without activating or dismissing them. (S17, C9, A147)

## Love Spot and Matilda

- Matilda is the default board collaborator. Writing, pasting or drawing on the board can receive a dark blue handwritten reply with her face beside it; her portrait also identifies her in the Love Spot chat, not ordinary chats. There is no separate Talk panel, Matilda button or agent-card section. Do not answer her own writing, a moved shape or an edit with unchanged words. (S20, S30, M3, A150, A162, R55)
- An open text editor, IME composition, paste or pause is unfinished input. Queued work rechecks editing and page identity; cancellation keeps pending text. Incoming replies never close the editor, steal focus or overwrite a draft. (C7, R75)
- Matilda's editable professional persona and model choice persist and accompany her requests; an empty model choice uses the app default. Her reply and drawing stay together; supported fenced Excalidraw shapes are rendered rather than shown as raw data. The board shows a writing indicator while she answers. (S30)
- Opening the board or its chat clears the Love Spot unread notice. A later reply can notify again. The board retains pages and artwork; its Style control can close and reopen without changing marks. (H2, C7, R70)
- The pinned companion floats over each app page, can be moved, pinned and unpinned, and keeps its position. Its mini chat preserves drafts and never changes the main composer. It shows no earlier messages by default; one designated action reveals them. When Matilda is off, the pinned chat remains usable. (C7)
- The companion's music control only mutes or unmutes the existing player and restores the prior volume. A drag does not activate the chat or move the content underneath it. (C7)
- Love Spot keeps text working when audio is unavailable and hides unavailable audio controls. Do not show a Matilda voice-call button or start a hidden paid-provider fallback. Ordinary chat audio and dictation stay separate. (C14, R71)

## Voice and read aloud

- Dictation inserts editable text without sending it. Live voice, dictation and read aloud are distinct actions. Settings offers a saved voice from the active connected protocol and advanced transcription options; unsupported voices are refused. A call has truthful connection state, microphone mute and End; leaving or ending it releases microphone and peer resources. (V2–V4)
- Where read aloud is available, finished visible assistant replies offer Read aloud and Stop. Use the selected saved voice, show the connection, preserve the reply's words and order, and exclude hidden reasoning and painting data. Playback does not require microphone capture. (RA1–RA5)
- A shared speaker prevents overlapping playback across chats and windows. Stop, navigation, close or disconnect retires queued and late audio without stopping the text turn. Long replies are delivered in order without losing or repeating chunks. (RA6–RA8, RA18)
- Spoken requests go through the selected chat's provider and permissions. Busy requests wait in order; each handoff and answer belongs to its originating chat. A failure preserves the full text, shows the reason and never blindly retries an uncertain delivery. (RA9–RA13, RA18)
- Read aloud and live voice use the connected ChatGPT subscription; they do not use Linux speech, an API-key route or a hidden paid-provider fallback. Unavailable capability is hidden or explained as appropriate; unsupported quota and cost are not invented. (RA2, RA19, C14, R71)

## Workflows

- Workflows has its own page, navigation entry and sidebar group. A plain request and short pattern choices create or update a team without starting a run. Drafts and existing boards survive refusals and intervening edits; New checkpoints the old board for Undo. (S12, C1, R72)
- Agents have a name, role, model, character and visible state. The person can edit an existing agent without losing its work or connections. Changing provider updates the model choices; one connected agent can be added under another. (W1, W2, W4, R14)
- Connecting agents defines dependencies. Removing an agent removes its arrows; “Delete, keep the flow” is distinct from Delete. Selection follows R14. A run starts only through an explicit action and explains why it cannot start. (W3, W5, W6, R20)
- Runs use the chosen project folder or a private persistent workspace. Writers have bounded scopes and a dependent check. The Mother reviews the result before integration; conflicts and unavailable recovery are visible. See [WORK_GRAPHS.md](../../docs/WORK_GRAPHS.md) for the engine graph contract. (W7, C1–C3)
- The board and its agents survive restart. Saved workflows have distinct names and colours; each saved run appears once with its recorded step chats. History is removable with recovery and closes on Escape, outside click or navigation. New workflow remains usable during a run. (W8, WI1, WI2, C1)
- Chat, Flat and Isometric views show the same live Mother, team and recursively spawned descendants. Saved routing and failures remain historical. Resume cannot duplicate active work; opening progress does not launch inference. (C2, C4)
- On a quota failure, recovery can use another connected subscription while preserving the run, completed work and worktrees. Unrelated failures are not blindly replayed. The Mother can make bounded, visible steering or retry decisions. (C3)
- The chat `workflow` tool runs only for an explicit request by the person; helper and autonomous turns cannot start it. It returns the run ID without requiring the window to remain open. GPT and Claude chats use their own configured routes. (WR1, WR6)
- A workflow run persists its script, journal, agents and result. It resumes unfinished work after interruption, retries bounded failures, and can be stopped or resumed. Unchanged journaled work is not repeated. (WR2–WR4)
- A finished, stopped or failed run delivers one notification to its originating chat when available. An archived chat keeps the notice until restored; delivery does not unarchive it. (WR5)

## Permissions

- Full access is the initial default in desktop and TUI and means no ordinary approval with full filesystem access; Bypass is a separate explicit choice. The saved default applies to chats without an explicit choice; a chat's selection survives reload. Managed restrictions disable forbidden choices and reject them at the runtime boundary. (P1–P4, A233, A251)
- Automatically started helpers operate within their declared scope and managed restrictions without asking the person for ordinary tool approval. A helper cannot grant itself a higher permission ceiling. (P3, R59, R60)
- Changing a loaded helper's permissions or opening its live history uses its owning runtime. Unknown helpers and grants above the ceiling are refused. See [A166](specs/a166-helper-chat.md).

## Settings, models and accounts

- Settings navigation fits the available height, keeps every destination reachable and does not clip its title. Categories are plain group labels, not link-only overview pages. Shared rows keep consistent width, alignment and spacing. (C11, R21, R67)
- Known models and providers are selected from menus; custom model IDs are behind an explicit Advanced option. Provider order follows R35. The TUI and desktop use a live shared model catalogue, preserve the selection and show fetch failures. (S1, S2)
- Features are grouped On then Off and alphabetized. Skills have persistent, reversible switches. Plugins participate only after the person explicitly adds or enables them; the Claude and ChatGPT catalogues can be added deliberately. (S3, S9, S10)
- Instruction and memory files are readable and editable. A missing file offers Create, a linked file edits its real target, and stale drafts are rejected. The interface states whether the model receives each source. Memories have one master switch and a saved-memory count. (S4, S5)
- Keyboard shortcuts are searchable, editable and resettable. A changed binding survives restart and appears beside the corresponding command; defaults include Ctrl+N for a new chat and Ctrl+, for Settings. (S6, S24, A155, R46)
- Models & accounts exposes the connected providers and their own sign-in routes without returning credentials to the renderer. Claude accounts can be selected explicitly. MCP settings can import existing Claude Code connections without exposing keys or replacing existing connections. (C12)
- Settings → Import chats lists Claude Code and Codex, with counts for interactive chats from the last 30 days; an empty source cannot be imported. Each press imports at most 50 without duplicates, reports skips, preserves originals and excludes subagent and exec runs. Codex rollouts up to 100 MB are copied and registered. Imported chats retain their names and can be opened and forked. (S31)
- The Customize page is distinct from a chat's Context Ledger. Lab is absent from Settings and navigation. Personalization, model and account pages contain working controls rather than empty overview pages. (S8, S28, S33)

## App shell and installation

- The sidebar closes beside its brand and reopens from the title bar. The application exposes Back, Forward, File, Edit, View and Help. The footer shows the person's name as a label and places Theme beside Settings; the name is asked once and remains editable in Settings. (R67)
- The startup screen uses the approved turning E. Accepted artwork and the Working animation remain unchanged. (S26, A68)
- Installation follows C2 and the desktop verification and preservation rules in [TESTING.md](TESTING.md). The candidate package opens successfully before the installed selector changes. (S29)
