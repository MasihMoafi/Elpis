# Manual Memory and Agent/Work-Graph Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement one checked task at a time. Do not dispatch parallel implementers: both plans touch shared app-server/TUI seams and the coordinator must review each commit before starting the next task.

This is deliberately split into two independently reviewable plans with no code dependency on one another. Execute Plan A first as the product priority; after its review gate, Plan B may be executed from the same approved baseline by one implementer. The only order within a plan is the listed task order.

## Common evidence and constraints

- Spec: `docs/superpowers/specs/2026-08-31-elpis-daily-driver-readiness-design.md`, sections 3.4–3.5 and Verification and Acceptance.
- Source audit: `.superpowers/daily-driver-audits/agents-memory.md`.
- Keep `enable_fanout = false`; do not add a scheduler, swarm layer, graph authoring, or automatic branch/worktree integration.
- Do not add a slash command. Reuse `/agent`; preserve its existing selection and Alt+Left/Right behavior.
- App-server protocol changes are additive. Existing JSON must deserialize unchanged; use `#[serde(default)]` on every newly added response field that can appear in an existing persisted/test fixture. Do not rename an existing method or field.
- All TUI/network-like app-server requests are asynchronous. Do not mutate visible selection/status optimistically; apply a result only if it still belongs to the same active primary thread and request generation.
- Plan A adds only a path-free scalar manual-memory projection to the dashboard because the product spec requires the Ledger and dashboard to agree. Memory body text and configured paths never enter dashboard state. Plan B adds no graph data or controls to the dashboard.
- The implementer must first read `AGENTS.md`, `docs/GUIDE.md`, `docs/context.md`, `docs/sessions.md`, `docs/WORK_GRAPHS.md`, `docs/SHIPPING_RULES.md`, and `docs/LOCAL_BUILD_RULES.md`, then verify the worktree is clean apart from this plan’s own changes.
- Do not run Cargo, Rust tests, `rustfmt`, builds, installation, tmux, browser/editor/process/config changes, or network actions while drafting or implementing this daily-driver stage. The commands in the final verification sections are deferred commands, not commands to run now.
- Every deferred Cargo command runs from `codex-rs` with the exact `CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo ... --locked` wrapper. Never remove or raise the throttle.

## Genuine source blocker: memory editing

`codex-rs/tui/src/external_editor.rs` proves that Elpis can open a temporary Markdown file, waits for a successful editor exit, and returns the edited text. `codex-rs/tui/src/app/input.rs` only writes that returned text into the chat composer. There is no existing target-file writeback helper in the TUI that atomically replaces `MEMORY.md` after that exit. Therefore this candidate must **not** wire the external editor to memory. It supplies atomic create plus reveal/copy-path and deliberately defers edit/writeback until a separately reviewed file-write contract exists. This is a source-backed scope boundary, not a UI omission.

---

# Plan A — Truthful Usable Manual Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` task-by-task. Checkbox steps are review checkpoints, not evidence that a command has already run.

**Goal:** Make the one canonical user-maintained `MEMORY.md` visible, creatable, explicitly admissible, and truthful about its 8,000-character request contribution without restoring automatic memory promotion.

**Architecture:** Keep request injection in the current app-server extension path and keep admission persisted per workspace. Add one path-free typed memory-status projection derived from the same canonical path and admission record as injection, plus a cached metadata-only `ContinuitySource` list whose canonical Memory row is built from that status. Core request assembly remains the only code allowed to turn memory body text into a prompt and, for canonical memory only, rechecks admission after its asynchronous body read before adding the section. The TUI performs source/status discovery, creation, and manual-memory admission writes on blocking workers. App—not a reconstructable ChatWidget—owns a monotonically increasing, never-reused view epoch keyed by primary root thread, displayed thread, cwd, and configured memory path. Mutation launch and the mandatory post-mutation refresh each advance that epoch so an older coalesced status read cannot settle new state. Because blocking writes cannot be cancelled, App separately retains the minimal launched-mutation state by stable workspace-admission and memory paths until completion. ChatWidget synchronously marks Create as pending to prevent duplicate events and raises a local submission barrier before emitting an admission-change request; it reuses the existing input queue rather than adding another. The Context Ledger, `/context`, `/usage`, and dashboard consume the same cached source/status projection; none discovers files while rendering. Creation reserves the final path with `create_new`, durably persists admission false while the reservation is empty, and writes the template only after that persistence succeeds. It never starts an editor.

**Tech Stack:** Rust workspace (`codex-core`, `codex-app-server`, `codex-tui`), Tokio filesystem APIs, existing Context Ledger and app-server extension tests.

**Spec:** `docs/superpowers/specs/2026-08-31-elpis-daily-driver-readiness-design.md` §3.5 and §Verification; `.superpowers/daily-driver-audits/agents-memory.md` §3.

## Plan A global constraints

- Canonical path is exactly `config.memory_dir/MEMORY.md` (normally `~/.elpis/memories/MEMORY.md`); no second memory file, database, retrieval index, or automatic extractor is introduced.
- Valid status values are exactly `missing`, `available_not_admitted`, and `admitted`. An I/O, invalid-UTF-8, or non-file failure is a separate unavailable/error cache state and must never be misreported as missing or zero-sized.
- Status includes both `request_chars_if_admitted` and `eligible_chars_now`, plus `limit_chars: 8000` and `truncated`. The first is the capped character contribution the file would make if admitted. The second is the contribution the current status snapshot makes eligible for the **next** request, so it is zero whenever the file is missing or not admitted. It is not evidence that a request actually injected those characters: the request builder rereads admission/content and remains the only per-request authority. `truncated` is true iff the trimmed Rust-character count exceeds 8,000.
- Exact status semantics are:

  | File/state | `request_chars_if_admitted` | `eligible_chars_now` | `truncated` |
  | --- | ---: | ---: | --- |
  | missing | 0 | 0 | false |
  | empty/whitespace, not admitted | 0 | 0 | false |
  | empty/whitespace, admitted | 0 | 0 | false |
  | new template, not admitted | 14 | 0 | false |
  | new template, admitted | 14 | 14 | false |
  | 8,000 trimmed Rust characters, not admitted | 8,000 | 0 | false |
  | 8,000 trimmed Rust characters, admitted | 8,000 | 8,000 | false |
  | 8,001 trimmed Rust characters, not admitted | 8,000 | 0 | true |
  | 8,001 trimmed Rust characters, admitted | 8,000 | 8,000 | true |

  `Unavailable` is a TUI/dashboard phase, not a valid status row: it carries no admission state and no numeric counts rather than misleading zeroes.

- A missing-memory Create action creates only `# Elpis Memory\n`, creates the parent directory as needed, and never overwrites a concurrent/user-created file. It first reserves the final path as an empty file with `create_new`; a collision returns `AlreadyExists` without changing admission or content. While the reservation contains no template bytes, creation durably persists memory admission false through the existing admission writer: write and `sync_all` a unique same-directory `create_new` temporary file, atomically rename it, then open and `sync_all` the admission directory. Only after all three steps succeed may creation write a template byte and `sync_all` the memory file. If admission persistence fails, leave the exclusively created reservation empty and report that exact partial state; do not unlink by pathname, because a concurrent replacement could otherwise be deleted. Claim only that Elpis wrote no template. A later template write/sync failure leaves admission false, returns an error, and may leave a partial present file. Every Create outcome—success, collision, admission failure, write failure, or sync failure—requests a fresh status before the UI settles.
- Missing memory always has effective admission false even if a stale `memory = true` record exists. Every admission entry point—including direct core calls, Space/Enter, mouse, `i`, and `g i`—must refuse to admit a missing canonical memory file. The row remains selectable so Create and Copy path are usable.
- The canonical `memory_dir/MEMORY.md` can be admitted only through its dedicated Memory row. `/add` rejects that exact file with fixed “use the Memory row” guidance; a directory add excludes it and errors if no other eligible file remains. It must never create an admitted custom-source alias that the canonical-row dedupe later hides.
- Admission remains the existing explicit per-workspace toggle. Manual-memory admission changes use the same worker/epoch pipeline as status/create. Before emitting the request, ChatWidget synchronously raises a local barrier used by direct submission, initial submission, and the central queue-drain path. While the write is pending, a user turn stays in the existing input queue before request construction and every further memory admission action is disabled. Durable success clears the barrier and drains normally. Failure or lifecycle invalidation clears the barrier only after restoring blocked input to the composer unsent. This guarantees that an immediate withdrawal affects the next app-server-built request without inventing another queue or relying on AppEvent ordering. Create is not a user-turn barrier: instead, it enters `Creating` synchronously so one keypress emits one event, and the request builder's post-read admission recheck makes a concurrent turn fail closed.
- Admission reads are fallible. `NotFound` means the default admission record; a valid current or recognized legacy record is accepted; unreadable, non-file, invalid TOML, or unrecognized data is an error. Status reports a fixed allowlisted unavailable reason and every create/toggle/add/remove operation refuses to overwrite an admission record it could not read. Request assembly fails closed without admitting any source on an admission-read error.
- While App owns a Create or memory-admission mutation for a stable admission target, every TUI admission-file writer for that target—single/bulk toggle, remove, and `/add`—is disabled/rejected. This is the minimal in-process lost-update guard; unique temporary files prevent temp-name collisions. Cross-process read-modify-write locking is explicitly deferred and must not be claimed.
- No manual-memory status/read/create/admission-write or continuity-source discovery call is allowed in Ledger, `/context`, `/usage`, or dashboard rendering, nor in synchronous key/mouse handling. Those paths use the cached typed status/source projection and send App-owned epoch-keyed `AppEvent` requests; the worker uses `spawn_blocking` (or an equivalent async filesystem boundary).
- No content is carried through `AppEvent`, rendered in the ledger, history, notifications, clipboard output, dashboard, or logs. Dashboard source labels are logical and path-free: built-in labels remain fixed, while a custom `/add` row uses only its basename (or `Custom source` when no basename exists), even if identical basenames repeat. Full custom paths stay TUI-local. Tests use planted non-secret fixtures only.

## Plan A file map and interfaces

| File | Responsibility |
| --- | --- |
| `codex-rs/core/src/elpis_context.rs` | Canonical path-free memory status/create helpers, fallible current/legacy admission parsing, unique durable writer, missing-admission guard, post-body-read request recheck, metadata-only source projection from cached memory status, and unit tests; existing request builder remains the single admission/injection authority. |
| `codex-rs/core/src/agents_md_manager.rs` and its colocated tests | Remove sticky admitted-instruction reuse on missing/unreadable/corrupt admission; retain discovery only, fail closed for the next request, and retry on refresh. |
| `codex-rs/app-server/src/extensions.rs` | No new memory transport; retain the extension call path and add only a narrow regression assertion if a helper extraction makes it necessary. |
| `codex-rs/app-server/tests/suite/v2/memory_recall.rs` | Full mock-request positive, negative, create, withdrawal, and truncation evidence. |
| `codex-rs/tui/src/app.rs`, `codex-rs/tui/src/app_event.rs`, `codex-rs/tui/src/app/background_requests.rs`, `codex-rs/tui/src/app/event_dispatch.rs`, `codex-rs/tui/src/app/session_lifecycle.rs`, and `codex-rs/tui/src/app/thread_routing.rs` | App-owned never-reused view epoch plus stable-target mutation ownership; existing background-request module launches workers; event dispatch settles current-target results; lifecycle invalidation rejects stale display data without forgetting writes. |
| `codex-rs/tui/src/chatwidget.rs`, `codex-rs/tui/src/chatwidget/constructor.rs`, `codex-rs/tui/src/chatwidget/session_flow.rs`, `codex-rs/tui/src/chatwidget/input_flow.rs`, `codex-rs/tui/src/chatwidget/input_submission.rs`, `codex-rs/tui/src/chatwidget/input_restore.rs`, and `codex-rs/tui/src/chatwidget/slash_dispatch.rs` | Render-facing status plus metadata-only source cache/phase; synchronous Create pending state and admission-change submission barrier; guarded direct/initial/queued submission; same-target `/add` rejection; existing composer restore on admission failure/invalidation. |
| `codex-rs/tui/src/chatwidget/context_ledger.rs` | Render and key handling for the cached memory row, Create and Copy configured path actions, and focused rendering/key tests. |
| `codex-rs/tui/src/chatwidget/context_usage.rs`, `codex-rs/tui/src/chatwidget/status_controls.rs`, `codex-rs/tui/src/status/card.rs`, `codex-rs/tui/src/status/tests.rs`, `codex-rs/tui/src/dashboard_server.rs`, and `codex-rs/tui/src/dashboard_assets/index.html` | Publish/render one cached path-free scalar memory/source projection in Context, `/usage`, and dashboard; never read the file during snapshot rendering. Republish dashboard JSON on every matching cache phase/result/lifecycle transition. |
| `codex-rs/tui/src/clipboard_copy.rs` | Reuse only its existing safe clipboard result/fallback API if it already accepts a literal path; do not broaden clipboard behavior. |
| `codex-rs/tui/src/app/tests/manual_memory.rs`, `codex-rs/tui/src/chatwidget/tests/context_ledger.rs`, `codex-rs/tui/src/chatwidget/tests/slash_commands.rs`, `codex-rs/tui/src/status/tests.rs`, and colocated tests in `context_usage.rs`/`dashboard_server.rs` | Focused cached-state, stale-result, write-conflict, key/mouse, clipboard-lease, `/usage`, and dashboard projection tests. |
| `docs/context.md` | Document the canonical status/create/admit/cap/key contract and the deliberate no-editor boundary. |
| `tools/verify-elpis/surfaces.toml` and `tests/verify-elpis/test_verify_elpis.sh` | Stable memory filters and first-match path mappings that select the required union of memory/context/dashboard checks. |

The core interface introduced in Task A1 is the contract consumed by the TUI and request tests:

```rust
pub const MANUAL_MEMORY_LIMIT_CHARS: usize = 8_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManualMemoryAdmissionState {
    Missing,
    AvailableNotAdmitted,
    Admitted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManualMemoryUnavailableReason {
    AdmissionUnavailable,
    MemoryUnreadable,
    InvalidUtf8,
    MemoryPathNotFile,
}

#[derive(Debug)]
pub struct ManualMemoryStatusError {
    pub reason: ManualMemoryUnavailableReason,
    source: std::io::Error, // private; never serialized or rendered verbatim
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManualMemoryStatus {
    pub state: ManualMemoryAdmissionState,
    pub bytes: u64,
    pub request_chars_if_admitted: usize,
    pub eligible_chars_now: usize,
    pub limit_chars: usize,
    pub truncated: bool,
}

pub fn manual_memory_status(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> Result<Option<ManualMemoryStatus>, ManualMemoryStatusError>;

pub fn create_manual_memory(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> std::io::Result<ManualMemoryStatus>;

pub fn continuity_sources_with_dev_rule_roots(
    memories_root: Option<&Path>,
    cwd: &Path,
    instruction_source_paths: &[PathBuf],
    dev_rule_roots: &[AbsolutePathBuf],
) -> std::io::Result<Vec<ContinuitySource>>;

pub fn continuity_sources_from_manual_memory_status(
    memories_root: Option<&Path>,
    cwd: &Path,
    instruction_source_paths: &[PathBuf],
    dev_rule_roots: &[AbsolutePathBuf],
    manual_memory: Option<&ManualMemoryStatus>,
) -> std::io::Result<Vec<ContinuitySource>>;

pub fn admission_fingerprint(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> std::io::Result<Option<String>>;

pub fn instruction_source_admitted(
    memories_root: Option<&Path>,
    cwd: &Path,
    path: &Path,
) -> std::io::Result<bool>;
```

`ManualMemoryStatusError` retains its `io::Error` source for local diagnostics but exposes only one `ManualMemoryUnavailableReason` to UI/dashboard code; raw error/path text is never serialized. `manual_memory_status(None, _)` returns `Ok(None)` only when Elpis has no configured memory root. `create_manual_memory(None, _)` returns `NotFound` and performs no filesystem write. The configured path is derived separately and exactly as `memories_root.join("MEMORY.md")`; status itself is path-free so the dashboard cannot accidentally serialize it. `manual_memory_status` returns a typed unavailable error for admission-read failure, unreadable content, invalid UTF-8, or an existing non-file path. Both existing source-list entry points become fallible; the cached-status variant reuses the supplied Memory scalars and never reads its body. Request assembly handles source-list error by returning no admitted-context prompt; the TUI worker maps it to Unavailable. The fingerprint distinguishes configured-file `NotFound` as `Ok(None)` from a read error. Native instruction filtering maps each admission-read error to not admitted, clears the manager's prior admitted subset without discarding its loaded discovery, and leaves the error uncached so the next refresh retries. The existing `set_continuity_source_admitted(..., "MEMORY.md", admitted)` remains the public admission API, but its memory arm must reject `admitted = true` unless the canonical file currently exists and is a regular file.

### Task A1: Make canonical memory state and atomic creation testable in core

**Files:**

- Modify: `codex-rs/core/src/elpis_context.rs`
- Test: colocated `#[cfg(test)]` tests in `codex-rs/core/src/elpis_context.rs`
- Modify and test: `codex-rs/core/src/agents_md_manager.rs`

**Consumes:** Existing `workspace_context_dir`, `read_admission`, `set_continuity_source_admitted`, `truncate_chars`, and the actual `memory_dir/MEMORY.md` convention.

**Produces:** `ManualMemoryAdmissionState`, `ManualMemoryStatus`, `ManualMemoryUnavailableReason`, `MANUAL_MEMORY_LIMIT_CHARS`, `manual_memory_status`, and `create_manual_memory` used by Tasks A2–A4.

- [ ] **Step 1: Add failing core tests before changing the source.**

  Add temp-directory tests with these exact assertions:

  ```rust
  #[test]
  fn manual_memory_missing_is_not_eligible_for_next_request() {
      let status = manual_memory_status(Some(memories.path()), cwd.path()).unwrap().unwrap();
      assert_eq!(status.state, ManualMemoryAdmissionState::Missing);
      assert_eq!(status.request_chars_if_admitted, 0);
      assert_eq!(status.eligible_chars_now, 0);
      assert_eq!(status.limit_chars, MANUAL_MEMORY_LIMIT_CHARS);
      assert!(!status.truncated);
  }

  #[test]
  fn create_manual_memory_is_exclusive_and_leaves_memory_unadmitted() {
      let created = create_manual_memory(Some(memories.path()), cwd.path()).unwrap();
      assert_eq!(created.state, ManualMemoryAdmissionState::AvailableNotAdmitted);
      assert_eq!(created.request_chars_if_admitted, 14);
      assert_eq!(created.eligible_chars_now, 0);
      let path = memories.path().join("MEMORY.md");
      assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Elpis Memory\n");
      set_continuity_source_admitted(Some(memories.path()), cwd.path(), "MEMORY.md", true).unwrap();
      std::fs::write(&path, "user content").unwrap();
      assert!(matches!(
          create_manual_memory(Some(memories.path()), cwd.path()),
          Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists
      ));
      assert_eq!(std::fs::read_to_string(&path).unwrap(), "user content");
      assert_eq!(manual_memory_status(Some(memories.path()), cwd.path()).unwrap().unwrap().state,
          ManualMemoryAdmissionState::Admitted);
  }
  ```

  Also add explicit whitespace-only, exact-8,000, and 8,001-character Unicode-safe fixtures in both unadmitted and admitted states. The long unadmitted fixture asserts `AvailableNotAdmitted`, `request_chars_if_admitted == 8_000`, `eligible_chars_now == 0`, `limit_chars == 8_000`, and `truncated == true`; after admission, assert state `Admitted`, `eligible_chars_now == 8_000`, and unchanged potential/cap/truncation. The existing truncation helper yields 7,999 fixture characters plus one ellipsis for the 8,001 case.

  Add error tests for an existing directory at `MEMORY.md`, invalid UTF-8, and an unreadable/read failure where portable. They must return their exact allowlisted reason, not `Missing`. Add admission-file fixtures for NotFound/default, valid typed state, recognized legacy dotted keys, invalid TOML, a directory/non-file, and an unreadable/read failure where portable. For mixed current/legacy input, prove an explicitly present canonical field wins even when it is `false`: `memory = false` plus legacy `MEMORY.md = true` stays withdrawn, while `memory = true` plus legacy false stays admitted; legacy supplies the value only when the canonical field is absent. A later write must preserve that chosen state and every other recognized current field/map while serializing canonical form. Apply the same present-current-wins/per-entry rule to the other recognized scalar and dev-source legacy keys. Invalid/unreadable/non-file admission must make status unavailable and make toggle/add/remove leave the original admission bytes/path unchanged; Create also preserves that admission record and leaves only its exact empty `MEMORY.md` reservation after its failed persistence read. Add `elpis_context_admission_error_clears_cached_admitted_instructions`: seed a manager with a valid admitted optional instruction, then exercise invalid/unreadable/non-file admission and deletion. The next refresh retains loaded discovery but exposes no formerly admitted optional instruction; repair recovers; configured-file NotFound uses the explicit default (including default-on dev rules) rather than the prior cached selection. A read error during per-source filtering also clears the admitted subset and is not cached as a successful fingerprint. Add a stale-admission test: persist admitted, delete the file, assert effective state `Missing`, assert a direct attempt to admit it fails, Create, and assert the result and persisted state are not admitted. Add canonical `/add` tests: direct `MEMORY.md` is rejected with fixed guidance; directory add excludes it; a directory containing only it errors; no custom-source alias is persisted. Add injected failures for unique-temp create/write/sync, rename, admission-directory sync, template write, and template sync. Admission-persistence failure writes no template and leaves only its empty exclusive reservation; it must never delete a pathname that could have been concurrently replaced. Template write/sync failure remains unadmitted and reports the partial result. Add a collision fixture proving both content and prior admission are preserved.

- [ ] **Step 2: Record the required fail-first command without running it.**

  Deferred command: `cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core --lib --locked elpis_context`

  Expected initial result: compilation failure because the status type/helpers do not exist. Do not execute it in this stage.

- [ ] **Step 3: Implement the minimal projection and exclusive creation.**

  Put `MANUAL_MEMORY_LIMIT_CHARS` beside the current `MAX_RULE_CHARS` and make the memory branch of `source_char_limit` use that named constant. Derive the path once from `memories_root.join("MEMORY.md")`; use metadata/`NotFound` handling to distinguish missing from an existing non-file, read UTF-8 content only for a present regular file, trim with the existing semantics, and count Rust `char`s before and after the existing truncation helper.

  Make `read_admission` fallible in place. Only file `NotFound` yields `ContinuityAdmission::default()`. Parse presence separately from the defaulted typed value: an explicitly present canonical scalar or map entry wins, including `false`; a recognized legacy dotted boolean supplies only a semantically absent canonical field/entry. Do not let `#[serde(default)]` collapse absent and explicit false before applying precedence. Invalid TOML, a non-file, read/UTF-8 failure, conflicting duplicate syntax that cannot be assigned this precedence, or data outside the accepted current/legacy shapes is an error; every read-modify-write caller propagates it and preserves the original admission file. Make `admission_fingerprint` fallible too: for a configured workspace only admission-file NotFound is `Ok(None)`; other read/UTF-8/non-file errors propagate. Make `instruction_source_admitted` return the fallible result rather than silently using defaults.

  In `AgentsMdManager::refresh`, delete the `unreadable_after_known_state` reuse branch. On fingerprint failure or any per-source admission-read failure, retain/update only `loaded`, set `admitted = None` for the next request, and do not cache the failed fingerprint/filter result, so a later refresh retries. The filtering closure treats an individual error as false while recording that the whole admitted projection is unavailable. A readable NotFound/default state is cacheable and uses the documented optional-off/dev-rule-on defaults. Never preserve a previously admitted optional instruction merely because the admission file disappeared or became unreadable.

  Upgrade the existing `write_admission` implementation in place; do not add a second memory-only persistence format or writer. Reuse the workspace's existing `tempfile::NamedTempFile`/`Builder` dependency to reserve a unique same-directory temporary file, write the TOML through that opened file, `sync_all` it, atomically persist/rename it over `admission.toml`, then open and `sync_all` the workspace/admission directory. Its tests must fail at each injectable persistence stage and prove no successful return before directory sync. Do not invent a name generator or use the current fixed `admission.toml.tmp` name.

  `create_manual_memory` must `create_dir_all(memories_root)`, reserve the exact final path with `OpenOptions::write(true).create_new(true)`, and leave it empty while durably persisting `memory = false` through that writer. On admission-write failure, leave that reservation empty, return the persistence error with an exact "empty memory file reserved; no template written" classification, and never call pathname-based removal. After persistence succeeds, write exactly `# Elpis Memory\n`, `sync_all`, and derive/return status. A collision occurs before admission is touched. A template write/sync failure may leave a partial file but admission stays false. Do not replace an existing file.

- [ ] **Step 4: Make the existing source list agree with the status.**

  Retain `ContinuitySource` and its existing generic non-empty rule for non-memory rows. Build the canonical memory row specially from `ManualMemoryStatus` for all valid states: missing is selectable but not admittable and has zero bytes/tokens; empty present memory remains visible with its persisted state and zero contribution; nonempty present memory uses the status-derived capped estimate. Never infer status from row absence. Add a projection entry point that accepts an already derived `ManualMemoryStatus` and returns the metadata-only source list without rereading memory content. It runs on the same status worker; TUI render/status/snapshot code receives and caches its result rather than calling discovery. Admission-read failure makes request-side discovery fail closed and makes the cached display unavailable; it is never converted to a default admitted selection.

- [ ] **Step 5: Run the deferred focused core check only at functional close, inspect its output, and commit.**

  Deferred expected result: all new missing/error/empty/create/collision/stale-admission/persistence-failure/truncation tests pass, with no test silently admitting the new file. Commit only the explicit paths with:

  ```bash
  git add codex-rs/core/src/elpis_context.rs codex-rs/core/src/agents_md_manager.rs
  git commit -m "feat: expose truthful manual memory status"
  ```

### Task A2: Prove app-server request admission, withdrawal, and truncation

**Files:**

- Modify: `codex-rs/app-server/tests/suite/v2/memory_recall.rs`
- Modify only if necessary for testability: `codex-rs/app-server/src/extensions.rs`
- Test support: `codex-rs/core/src/elpis_context.rs`

**Consumes:** Task A1 status helpers and the existing `ElpisContinuityExtension` request contribution path.

**Produces:** Request-level proof that the app server, rather than a ledger-only path, obeys manual-memory state.

- [ ] **Step 1: Add failing request-level fixtures.**

  Extend the existing mock Responses capture test with five exact end-to-end cases:

  1. no `MEMORY.md` yields no manual-memory source header in the outgoing developer fragment;
  2. after `create_manual_memory`, overwrite the non-secret fixture with `MEMORY_CREATE_MARKER` while admission remains false; the same live thread's next request excludes both the manual-memory source header and that marker;
  3. explicitly admit that same file and prove `MEMORY_CREATE_MARKER` appears in the outgoing developer fragment, then set admission false and prove the immediately following request excludes both header and marker;
  4. an admitted 8,001+ character fixture reports `truncated = true` and the captured source body has exactly 8,000 Rust characters under the existing ellipsis truncation convention, with no character after the capped fragment.
  5. make `admission.toml` unreadable/invalid and assert request construction fails closed with no admitted-context section and never rewrites the corrupt fixture.

  Extract one private `read_continuity_source_section` helper used by the builder; do not add a public hook. In a core unit test, pass it a prebuilt canonical `ContinuitySource` carrying stale `admitted = true`, durably set admission false before its body read, and assert it returns `None`. This is the deterministic proof of the post-read recheck; the app-server cases remain end-to-end sequential boundaries.

  The test must inspect only the local mock request payload and literal fixture markers. It must not print a real memory file or call a provider.

- [ ] **Step 2: Record the fail-first request command without running it.**

  Deferred command: `cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-app-server --test all --locked memory_recall`

  Expected initial result: the create/status/truncation assertions fail before Task A1/A2 implementation is complete. Do not execute it now.

- [ ] **Step 3: Make request construction use the same cap constant and status semantics.**

  Do not add a second injection path or a memory RPC. Keep `ElpisContinuityExtension` calling `build_continuity_prompt_with_dev_rule_roots`. Replace any remaining memory use of the generic `MAX_RULE_CHARS` with `MANUAL_MEMORY_LIMIT_CHARS` through `source_char_limit`; preserve all existing non-memory caps. For canonical `MEMORY.md` only, after `tokio::fs::read_to_string` completes and immediately before pushing its section, re-read the fallible admission record and require `memory == true`. If that read fails or now says false, skip the section. This closes the Create race because the template is never nonempty until false admission is durable. The builder continues to skip missing content and returns `None` when no admitted content exists.

- [ ] **Step 4: Add an old-state compatibility test.**

  Correct `read_admission` so a syntactically valid typed TOML parse cannot swallow a legacy dotted key before the compatibility parser sees it. Use an admission file with current `memory = true`, one with no `memory` key, and the legacy flat `MEMORY.md = true`; assert they load admitted, unadmitted, and admitted respectively. Toggle memory in each relevant fixture and prove unrelated recognized legacy selections survive the rewrite. Invalid or unrecognized data must return an error and remain byte-identical. This protects current user state without silently changing default admission or overwriting a record Elpis does not understand.

- [ ] **Step 5: Run the deferred request check only at functional close, inspect it, and commit.**

  Deferred expected result: positive admission and immediate withdrawal are both demonstrated through the app-server mock request, while missing/create remain negative. Commit with:

  ```bash
  git add codex-rs/core/src/elpis_context.rs codex-rs/app-server/src/extensions.rs codex-rs/app-server/tests/suite/v2/memory_recall.rs
  git commit -m "test: prove manual memory request boundaries"
  ```

### Task A3: Add a non-blocking, epoch-safe TUI memory-status pipeline

**Files:**

- Modify: `codex-rs/tui/src/app.rs`
- Modify: `codex-rs/tui/src/app_event.rs`
- Modify: `codex-rs/tui/src/app/background_requests.rs`
- Modify: `codex-rs/tui/src/app/event_dispatch.rs`
- Modify: `codex-rs/tui/src/app/session_lifecycle.rs`
- Modify: `codex-rs/tui/src/app/thread_routing.rs`
- Modify: `codex-rs/tui/src/chatwidget.rs`
- Modify: `codex-rs/tui/src/chatwidget/constructor.rs`
- Modify: `codex-rs/tui/src/chatwidget/session_flow.rs`
- Modify: `codex-rs/tui/src/chatwidget/input_flow.rs`
- Modify: `codex-rs/tui/src/chatwidget/input_submission.rs`
- Modify: `codex-rs/tui/src/chatwidget/input_restore.rs`
- Modify: `codex-rs/tui/src/chatwidget/slash_dispatch.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_ledger.rs`
- Modify: `codex-rs/tui/src/chatwidget/status_controls.rs`
- Modify: `codex-rs/tui/src/status/card.rs`
- Modify: `codex-rs/tui/src/status/tests.rs`
- Modify: `codex-rs/tui/src/app/tests.rs`
- Create: `codex-rs/tui/src/app/tests/manual_memory.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests/composer_submission.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests/slash_commands.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests/context_ledger.rs`

**Consumes:** Task A1 `ManualMemoryStatus` and exact configured `memory_dir/MEMORY.md` plus current active-primary-thread lifecycle.

**Produces:** Ledger, `/usage`, and dashboard code can synchronously read a cached scalar projection, while every memory status/create/admission operation happens on a worker, pending admission reuses the existing input queue, same-target admission writers cannot race a memory mutation, and stale results cannot cross a workspace/thread switch or mutation generation.

- [ ] **Step 1: Add failing state-machine and stale-result tests.**

  Add tests for these exact transitions:

  - initialization or a workspace/primary/displayed-thread switch increments the App-owned epoch, retains no status from the old view key, sets phase `Loading`, and schedules one status request; if the new view shares a target with pending admission, it is `Loading` plus the submission barrier until its own status settles;
  - two refresh requests for the same key/epoch coalesce, but a mutation launch advances the epoch and its completion advances it again before the mandatory status refresh;
  - a matching successful result stores only `ManualMemoryStatus` scalars and becomes phase `Ready`;
  - an I/O result becomes phase `Unavailable` with a sanitized user-facing error, no state/count values, and is not converted to `Missing`;
  - late status results are ignored for an older epoch, different cwd, different memory path, different primary root thread, or different displayed thread;
  - before a Create `AppEvent` is emitted, ChatWidget synchronously enters phase `Creating`; duplicate/same-loop `c` is disabled, exactly one Create event is sent, and the launched write remains owned by its stable storage target even if the view epoch changes;
  - a slow pre-mutation status result followed by mutation launch/completion cannot apply or coalesce into the post-mutation read: only the fresh post-mutation epoch may settle the cache;
  - before a memory admission `AppEvent` is emitted, ChatWidget synchronously raises its local submission barrier; a same-loop Enter, direct submit, initial submit, and every central queue drain are blocked before `AppCommand::user_turn` construction;
  - every further admission action—duplicate or opposite—is disabled while one is pending; no second intent queue exists;
  - while either Create or memory admission owns the current storage target, single/bulk/remove and `/add` admission-file writes for that target are rejected without reading or rewriting `admission.toml`; a different storage target is unaffected;
  - every attempted ordinary single toggle, remove, or `/add` result—success or error—synchronously marks the projection Loading and sets a local `refresh_requested` invalidation marker before emitting one coalesced refresh event; only `remove Ok(false)` skips it because no write occurred. While the marker is set, same-epoch status results are rejected, then App dispatch advances the epoch, binds Loading to that new key, clears the marker, and launches the source/status worker. A no-Memory bulk refreshes exactly once after all attempts or its first error, even when that error is on the first row; a bulk whose successful ordinary writes are followed by enqueued Memory relies on that mutation's mandatory post-mutation refresh;
  - a user turn submitted during pending withdrawal/admission stays in the existing input queue; same-view durable success plus a matching fresh status drains it, while mutation/status failure restores it to the composer unsent;
  - A→B on the same storage target propagates the admission barrier to B while an admission write continues; B starts `Loading` without borrowing A's status, cannot submit until completion and a B-epoch status refresh settles. A Create mutation propagates `Creating`/write exclusion but does not block turns;
  - A→B on a different storage target restores A's blocked input before snapshot/switch and leaves B unblocked;
  - A→B→A with the same root/cwd and late completion never applies A1 cache data or auto-sends restored input; it refreshes under the current A epoch;
  - new/resume/fork/clear/thread-selection/config-cwd transitions increment the view epoch, restore blocked input before replacement, and retain any launched mutation by stable storage target until it finishes.

  Add the ordinary-write race explicitly: queue old status S1 between a synchronous non-memory write and dispatch of its refresh event; `refresh_requested` must reject S1, the refresh event advances the epoch, and only S2 replaces Loading. Exercise both Ok and the post-rename directory-sync Err, plus a corrupt-read Err that refreshes to Unavailable; only `remove Ok(false)` performs no invalidation. A bulk aborting on its first ordinary error still refreshes exactly once. Assert event payloads/cache values contain no memory body `String` or bytes. A successful status result may carry the metadata-only `Vec<ContinuitySource>` (names, paths, state, sizes/estimates) needed by Ledger/status actions, but the dashboard projection strips every path. A view key contains only epoch, primary root thread id, displayed thread id, cwd, and configured memory path. A storage key contains only the derived workspace admission path and configured memory path; it has no epoch/thread identity and is never serialized to the dashboard.

- [ ] **Step 2: Record the fail-first TUI command without running it.**

  Deferred command: `cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib --locked manual_memory_`

  Expected initial result: the status request/result events, cache, epoch, and stale-result behavior are absent. Do not execute it now.

- [ ] **Step 3: Implement the worker boundary and typed cache.**

  Add explicit status, create, and admission request/result `AppEvent`s. App owns one checked, monotonically increasing view epoch plus a minimal map of launched create/admission writes keyed by stable storage target; `spawn_blocking` work is not cancellation-safe, so an epoch change must never erase mutation ownership. Dispatching a mutation advances the epoch before launch. Completing it advances the epoch again before its forced status read. Every additional memory mutation and every other TUI admission-file writer for the same target is disabled while its mutation is present. Do not create a generic worker framework or a second queue.

  Reuse `app/background_requests.rs`: its launch helpers run the synchronous core operations in `spawn_blocking` and return both the original view key and stable storage key through `AppEvent`. Keep `app/event_dispatch.rs` responsible for validating requests, invoking those launch helpers, retaining mutation state across view changes, and applying results. Ordinary status results require an exact current view key and cannot clear/replace pending mutation phase. A mutation result never applies its old cache directly: if the current view shares its storage target, advance the epoch, schedule a fresh status under that new epoch, and keep admission barrier or `Creating` state until that read settles; if it does not, remove the finished mutation without touching the current view. Every Create result, including collision and partial failure, follows this refresh rule. Dashboard JSON is republished after every matching phase/result/lifecycle transition.

  ChatWidget owns a render cache with `phase = Loading | Ready | Creating | Unavailable`, `status: Option<ManualMemoryStatus>`, `sources: Vec<ContinuitySource>`, `unavailable_reason: Option<ManualMemoryUnavailableReason>`, `pending_mutation: Option<Create | Admission>`, the narrow `refresh_requested` invalidation bit, and one same-view `pending_context_report` bit. `ManualMemoryStatus` remains path-free; source paths stay TUI-local and are never dashboard fields. Replace `ChatWidget::continuity_sources` live discovery with a clone/borrow of this cache. Change the `/usage` status-card constructor seam to accept the same cached source slice from `status_controls` rather than calling the newly fallible core API; standalone compatibility helpers may pass an empty slice. This mechanical consumer plumbing belongs to A3 so its TUI checkpoint compiles before A4 adds visual/action behavior. `Admission` is the local submission barrier and is set synchronously before the request event; `Create` is also set synchronously but only blocks duplicate/mutating admission actions. `Loading` has neither status/sources nor reason; `Unavailable` has one allowlisted reason and no status/sources/counts; `Ready` has a matching status/source snapshot; `Creating` may retain the last truthful snapshot. Raw `io::Error` text/path is never serialized, logged, or rendered verbatim.

- [ ] **Step 4: Wire lifecycle refresh and invalidation.**

  Schedule an initial status after the primary and displayed threads/workspace are known. Refresh after every admission result, every Create result, every ordinary single toggle/remove/`/add` result except `remove Ok(false)`, and explicit `/context` request. An ordinary mutation result synchronously sets Loading plus `refresh_requested` even on error because rename may already have committed; App dispatch then advances the epoch, binds Loading to the new key, clears the marker, and coalesces one source/status request. Status-result dispatch checks the marker before accepting even a matching old epoch. Bulk suppresses per-row refreshes: if it does not enqueue Memory, schedule exactly one after all attempts or its first error, including a first-row error; if Memory is enqueued last after successful ordinary writes, its mandatory post-mutation refresh covers the whole batch. `RequestContextUsageReport` sets one pending report for the current view, synchronously invalidates the old cache, and forces a new App epoch before scheduling; it cannot join a worker from the pre-request epoch. Duplicate requests coalesce only after the first has established that new epoch. Append no history output until the matching fresh Ready or Unavailable result. `/usage` remains a cached read. A lifecycle/view-key change discards the old pending report rather than printing stale data. On new/resume/fork/clear/primary-thread selection/displayed-thread selection or cwd/memory-root change, restore admission-barrier-blocked input to that thread's composer before snapshot/replacement, increment the App epoch, then schedule. Reconstructing ChatWidget must not reset or reuse the App epoch. Seed the new widget's pending mutation from any App-owned mutation with the same storage target: admission recreates the barrier, Create recreates `Creating` and write exclusion only.

  Guard `handle_composer_input_result`/`queue_user_message_with_options`, direct user-turn construction, `submit_initial_user_message_if_pending`, and the central `maybe_send_next_queued_input` only for pending admission. Reuse `queued_user_messages`, its existing history-record queue, and the existing composer-restore helper. When admission completes for the current storage target, settle only after a current-epoch status read: durable success clears the barrier and calls the existing queue drain; mutation failure or status-read failure restores queued input to the composer before clearing the barrier. A lifecycle switch always restores rather than auto-sending. Create settles after its fresh status without draining/restoring input because it never blocked submission. Guard `set_context_source_admitted`, bulk toggle, remove, and `/add` through one current-target pending-mutation predicate before any admission read/write. Never read memory/admission status in `ledger_lines`, height calculation, `/usage` construction, dashboard publication, key handling, mouse handling, input submission, or `pre_draw_tick`.

- [ ] **Step 5: Record the deferred focused check and commit.**

  Deferred expected result: all `manual_memory_` cache/worker/lifecycle/barrier/restore/write-conflict/stale-result tests pass, including same-loop Enter, duplicate Create, old-status→mutation→fresh-status ordering, ordinary-write invalidation, fresh `/context`, mutation/status failure, same-target A→B, different-target A→B, and same-target A→B→A. The TUI also compiles against A1's fallible discovery API because Ledger and status-card consumers now receive cached sources. Stage only these explicit files—never the whole `app` or `chatwidget` directory—with:

  ```bash
  git add codex-rs/tui/src/app.rs codex-rs/tui/src/app_event.rs codex-rs/tui/src/app/background_requests.rs codex-rs/tui/src/app/event_dispatch.rs codex-rs/tui/src/app/session_lifecycle.rs codex-rs/tui/src/app/thread_routing.rs codex-rs/tui/src/chatwidget.rs codex-rs/tui/src/chatwidget/constructor.rs codex-rs/tui/src/chatwidget/session_flow.rs codex-rs/tui/src/chatwidget/input_flow.rs codex-rs/tui/src/chatwidget/input_submission.rs codex-rs/tui/src/chatwidget/input_restore.rs codex-rs/tui/src/chatwidget/slash_dispatch.rs codex-rs/tui/src/chatwidget/context_ledger.rs codex-rs/tui/src/chatwidget/status_controls.rs codex-rs/tui/src/status/card.rs codex-rs/tui/src/status/tests.rs codex-rs/tui/src/app/tests.rs codex-rs/tui/src/app/tests/manual_memory.rs codex-rs/tui/src/chatwidget/tests.rs codex-rs/tui/src/chatwidget/tests/composer_submission.rs codex-rs/tui/src/chatwidget/tests/slash_commands.rs codex-rs/tui/src/chatwidget/tests/context_ledger.rs
  git commit -m "feat: load manual memory state without blocking the TUI"
  ```

### Task A4: Render and control memory in the Ledger and dashboard

**Files:**

- Modify: `codex-rs/tui/src/chatwidget/context_ledger.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_usage.rs`
- Modify: `codex-rs/tui/src/chatwidget/status_controls.rs`
- Modify: `codex-rs/tui/src/status/card.rs`
- Modify: `codex-rs/tui/src/status/mod.rs` only for the narrow path-free display-data re-export
- Modify: `codex-rs/tui/src/status/tests.rs`
- Modify: `codex-rs/tui/src/dashboard_server.rs`
- Modify: `codex-rs/tui/src/dashboard_server_tests.rs`
- Modify: `codex-rs/tui/src/dashboard_assets/index.html`
- Modify only if the existing literal-path copy helper needs a narrow public wrapper: `codex-rs/tui/src/clipboard_copy.rs`
- Test: `codex-rs/tui/src/chatwidget/tests/context_ledger.rs`, `codex-rs/tui/src/chatwidget/tests/status_command_tests.rs`, colocated tests in `codex-rs/tui/src/chatwidget/context_usage.rs`, and publication-transition assertions in `codex-rs/tui/src/app/tests/manual_memory.rs`; dashboard server tests live in `codex-rs/tui/src/dashboard_server_tests.rs`
- Modify: `tools/verify-elpis/surfaces.toml` and `tests/verify-elpis/test_verify_elpis.sh`
- Modify: `docs/context.md`

**Consumes:** Task A3's cached status and event requests; current Ledger selection/admission logic; existing clipboard lease contract; current dashboard snapshot.

**Produces:** A user can see and control truthful manual memory without content exposure, and Context Ledger totals, `/usage`, and dashboard agree with the same path-free state/count/cap/truncation/reason.

- [ ] **Step 1: Add failing rendered-state, action, and dashboard tests.**

  Drive the Ledger from injected cached states rather than real file reads and assert these exact semantics:

  ```text
  MEMORY.md  Missing  next request 0/8000 chars
  MEMORY.md  Available — not admitted  next request 0/8000 · 14/8000 if admitted
  MEMORY.md  Admitted  next request 8000/8000 — truncated
  MEMORY.md  Unavailable
  ```

  Add key/mouse tests for: missing remains navigable; Space/Enter and mouse do not admit it; `i` and `g i` skip it; an unmodified lowercase `c` synchronously enters Creating and sends one Create request even when pressed twice before App dispatch; completion leaves `Available — not admitted`; Space/Enter then admits it; a collision preserves content/admission and refreshes status; Backspace/Delete cannot remove the canonical memory row. With Ledger focused on missing Memory, Ctrl+C must return false from Ledger handling and reach the existing ChatWidget Ctrl+C interrupt/exit route instead of creating a file. Modified or uppercase `c` is likewise not Create. While Create/admission is pending, single/bulk/remove and `/add` writes for the same admission target are rejected. Direct `/add` of canonical `MEMORY.md` shows fixed “use the Memory row” guidance and never claims it is enabled. Ordinary toggle/remove/add results—including partial-commit and corrupt-read errors—and a no-Memory bulk each invalidate then refresh the cached rows/totals; bulk refreshes once, not per row, and `remove Ok(false)` alone skips refresh. Queue an old status between an ordinary write and refresh dispatch and prove it cannot overwrite Loading. Issue `/context` against an externally edited memory file and prove no report is appended until the fresh result; duplicates coalesce and `/usage` remains a cached read. Assert no action places body text in Ledger history and rendering performs no discovery call.

  Add portable total/bar tests: only phase `Ready` plus state `Admitted` contributes the status-derived capped token estimate. Missing, unadmitted, Loading, Creating, and Unavailable contribute zero. Remove the current blanket Memory-category exclusion so the Ledger headline, category total, and usage-bar segment agree with the row instead of misclassifying admitted memory as conversation.

  Add unmodified lowercase `p` tests for **Copy configured memory path** in all states. Modified or uppercase `p` is not consumed by Ledger. Copy exactly `config.memory_dir/MEMORY.md` without canonicalization or a metadata read. On success, replace/store the returned clipboard lease so it remains alive; on failure, preserve the previous lease and show fixed copy plus the exact configured path in footer/transient feedback, never history or a raw backend error. Do not call a file manager. Preserve Ctrl+click/open-file only when cached `Ready` proves an existing regular file.

  Add `/usage` tests proving it consumes the injected cached projection and performs no live continuity/memory read. Pass/store a path-free semantic memory snapshot (phase/status/reason/pending) with the cached sources because an empty source slice cannot distinguish Loading from Unavailable. Its memory line and totals must match the Ledger for Ready/Admitted and zero-contribution states; never infer a semantic memory state from a missing generic source.

  Add dashboard serialization/render tests for these invariants: `manual_memory = null` only in the additive mapper/back-compat case where no memory root is configured; runtime `Config.memory_dir` is mandatory, so an unbound or newly reconstructed ChatWidget still publishes `loading` rather than briefly removing the row. Otherwise `phase` is exactly `loading`, `ready`, `creating`, or `unavailable`; `state` is optional and, when present, exactly `missing`, `available_not_admitted`, or `admitted`; count/cap/truncation fields are optional together; `unavailable_reason` is optional and exactly one of `admission_unavailable`, `memory_unreadable`, `invalid_utf8`, `memory_path_not_file`, `sources_unavailable`, or `worker_failed`. `ready` carries state/counts, `creating` may carry the last truthful state/counts, `loading` carries neither, and `unavailable` carries only its reason. Admission launch follows A3's current invalidation contract: it immediately publishes `loading + admission_pending = true` with no borrowed state/counts; a same-target thread/view switch remains `loading + admission_pending = true` until that view's own refresh. Map all six reason codes to fixed user copy; never interpolate an I/O error or falsely relabel source/worker failures as a memory-file failure. Prove dashboard JSON is republished after initial Loading, matching status, mutation launch, same-target switch, post-mutation refresh, Unavailable, and lifecycle invalidation—not only after `/context` or `/dashboard`. Plant both the configured memory path and an absolute custom `/add` path; JSON/DOM must contain neither absolute path nor planted body/raw-I/O markers, and the custom row may expose only its basename/fixed fallback. Use safe DOM text APIs.

- [ ] **Step 2: Record fail-first checks without running them.**

  Deferred commands:

  ```bash
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib --locked manual_memory_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib --locked context_ledger
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib --locked context_usage
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib --locked dashboard
  ```

  Expected initial result: status text, guarded controls, clipboard-lease behavior, and dashboard scalar projection are absent. Do not execute them now.

- [ ] **Step 3: Implement the smallest truthful interaction contract.**

  In focused Ledger mode, reserve only unmodified lowercase `c` for **Create memory** when selected memory is `Missing` and no memory operation is pending; reserve only unmodified lowercase `p` for **Copy configured memory path** for every memory cache state. Any modifier, including Ctrl, makes Ledger return false so the existing outer key routing remains authoritative; in particular Ctrl+C must continue to interrupt/exit and never create Memory. Retain Space/Enter for explicit admission, but send an App admission request rather than calling the core setter in key/mouse handling. Reject missing/loading/creating/pending/unavailable memory first. Apply the same guard to mouse, `i`, `g i`, `g e`, and any bulk helper.

  Calculate `all_admitted` from exactly the rows eligible for that bulk mutation. A manual-memory row in missing/loading/creating/admission-pending/unavailable state is excluded from both the calculation and the writes; it must not make the aggregate false and must not receive a mutation. Present ready memory participates normally. For `i`/`g i`/`g e`, write all eligible non-memory rows first, then enqueue canonical Memory last; if any ordinary write fails, do not enqueue Memory. Test that rows rendered after Memory still change and exactly one memory event is last. Add conditional focused hints. Synthesize the canonical semantic row from the bound path plus cached phase/status/reason so it remains navigable in Loading/Creating/Unavailable, without fake counts or a file link. Filter/replace only the generic source whose `source.path == bound_target.view.memory_path`, so it renders exactly once; do not filter by Memory category or basename because custom `/add` files under the memory directory must remain visible. Use that same exact-path predicate for Ledger replacement/deduplication and dashboard filtering. Rendering never reads `MEMORY.md`. Only cached Ready+Admitted contributes `eligible_chars_now.div_ceil(4)` for canonical memory; preserve admitted custom Memory-category contributions. On matching Create/admission refresh, reselect the canonical row by exact path before clearing pending state because the selected index may have changed. Guard every admission-file writer through Task A3's current-target pending predicate. Reject the canonical path in `/add` through the core helper so key, paste, file, and directory routes cannot bypass the dedicated bit.

  On matching Create success, keep the row selected and refresh status/context estimates. On `AlreadyExists`, preserve the existing file and admission, surface the collision, and refresh. On any other error, preserve selection, perform no compensating admission write, show only sanitized fixed copy, and let the mandatory fresh status report the actual resulting file/admission state; a post-rename directory-sync or template write/sync failure may already have left admission false. Do not invoke `external_editor` and do not add an edit key.

- [ ] **Step 4: Add path-free dashboard memory state.**

  Add one optional, `#[serde(default)]` `DashboardManualMemory` scalar object under existing dashboard schema v1 rather than inferring memory state from `DashboardSource.admitted`; do not bump the schema or break the older Activity fixture. Its fields are `phase`, optional `state`, optional `request_chars_if_admitted`, optional `eligible_chars_now`, optional `limit_chars`, optional `truncated`, optional allowlisted `unavailable_reason` (including distinct `sources_unavailable` and `worker_failed` codes), and `admission_pending`. Enforce the phase/state/count/reason invariants from Step 1. Never include a path, body, raw error, or file metadata unnecessary to the contract. Filter only the source whose path exactly matches the configured manual-memory path from `DashboardSource` so manual memory renders once; preserve other Memory-category custom sources. When mapping other cached sources to `DashboardSource`, keep fixed built-in logical names and replace an absolute custom-source name with only `source.path.file_name()` or `Custom source`; do not serialize the full `ContinuitySource.name`/path. Publish from the same ChatWidget cache the Ledger and `/usage` render; do not call a filesystem helper during snapshot publication. Trigger the existing dashboard publisher after every matching cache transition. Add a compact semantic memory row that preserves the landed Observatory/Continuity Spine identity, hierarchy, status tones, safe-DOM contract, and restrained-motion behavior.

- [ ] **Step 5: Correct verification selection before closing Plan A.**

  Reuse the existing `core-elpis-context`, `core-memory-dir-bounds`, `core-memory-permission-profile`, `tui-context-ledger`, `tui-dashboard`, and `tui-context-usage` commands. Broaden only `core-elpis-context` from `elpis_context::tests` to the locked `elpis_context` substring so it non-vacuously includes the colocated `elpis_context_admission_error_...` manager regression. Change `app-server-memory-recall` to the module-wide `memory_recall` filter and add only one new `tui-manual-memory` command whose `manual_memory_` filter also covers status and slash tests. The `memory` surface is exactly `fmt-check` plus these eight test commands: `core-elpis-context`, `app-server-memory-recall`, `core-memory-dir-bounds`, `core-memory-permission-profile`, `tui-manual-memory`, `tui-context-ledger`, `tui-dashboard`, and `tui-context-usage`. Add `tui-manual-memory` to `full`; retain both existing core memory safety commands in `memory` and `full`. Every Cargo test command uses `--locked`; retain `fmt-check` exactly as `cargo fmt --all --check`.

  First-match ownership must enumerate every touched production/test/doc path before broad families: `elpis_context.rs` and `agents_md_manager.rs` select `memory, context-compaction`; `extensions.rs` selects `memory, app-server`; `memory_recall.rs` selects `memory`; every exact Task A3 App/ChatWidget/status/slash/test path except the two Ledger paths selects `memory, tui`; Ledger production/tests select `memory, context-compaction`; dashboard/context-usage assets/tests, including `dashboard_server_tests.rs`, select `memory, dashboard`; `docs/context.md` selects `memory, docs`; and an optionally touched `clipboard_copy.rs` selects `memory, tui`. Keep `tests/verify-elpis/**` and `tools/verify-elpis/**` selecting `full` ahead of all of them. A3's combined changed paths intentionally have mixed signatures and therefore select `full`. Extend the fake-Cargo/static harness to assert every command/filter and one representative for every exact path rule, rejecting zero-match/spoofed summaries.

  Assert each representative single path selects its exact intended surface union. Assert that a changed-path set containing different surface signatures intentionally selects `full`, not an accumulated focused union. Assert the manifest and verifier-test paths themselves select `full`; because Task A4 changes both, its complete changed-path verification also selects `full`.

- [ ] **Step 6: Record deferred full Plan A checks and commit.**

  At functional close only, defer these exact commands through the future verification manifest’s `memory` surface:

  ```bash
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core --lib --locked elpis_context
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core --lib --locked memory_dir_is_readable_without_creating_or_widening_writes
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core --lib --locked permission_profile_override_keeps_memories_root_out_of_legacy_projection
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-app-server --test all --locked memory_recall
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib --locked manual_memory_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib --locked context_ledger
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib --locked dashboard
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib --locked context_usage
  ```

  Expected final evidence: core/request/TUI `/usage`/Ledger/dashboard agree on missing/create/admit/withdraw/truncate/unavailable behavior, async results are epoch-safe, and any unavailable local check remains explicitly unexecuted. Commit with:

  ```bash
  git add codex-rs/tui/src/app/tests/manual_memory.rs codex-rs/tui/src/chatwidget/context_ledger.rs codex-rs/tui/src/chatwidget/context_usage.rs codex-rs/tui/src/chatwidget/status_controls.rs codex-rs/tui/src/status/card.rs codex-rs/tui/src/status/mod.rs codex-rs/tui/src/status/tests.rs codex-rs/tui/src/dashboard_server.rs codex-rs/tui/src/dashboard_server_tests.rs codex-rs/tui/src/dashboard_assets/index.html codex-rs/tui/src/clipboard_copy.rs codex-rs/tui/src/chatwidget/tests/context_ledger.rs codex-rs/tui/src/chatwidget/tests/status_command_tests.rs docs/context.md tools/verify-elpis/surfaces.toml tests/verify-elpis/test_verify_elpis.sh
  git commit -m "feat: make manual memory visible and controllable"
  ```

## Plan A acceptance checklist

- A fresh workspace with no file says `missing`, has effective admission false even with stale persisted state, injects nothing, and offers Create without allowing any toggle path to admit it.
- Create synchronously becomes pending once, reserves an empty final path, durably clears admission, then writes the exact minimal non-secret file; a stale pre-read admitted snapshot is rechecked after body read and cannot inject it. A collision preserves content/admission, and a persistence failure leaves the reservation empty without deleting a possibly replaced pathname or exposing template content.
- Admission is separate; a planted fact appears only in the app-server request after explicit admission and disappears in the next request after withdrawal.
- Missing/corrupt/unreadable admission is fail-closed and byte-preserving; concurrent same-target TUI admission writers cannot overwrite a pending memory mutation, and canonical `MEMORY.md` cannot be smuggled in through `/add`.
- Empty/template/exact-8,000/Unicode-8,001 cases distinguish potential from actually injected characters, and the captured request matches the cap.
- Source/status/create work cannot block Ledger, `/context`, `/usage`, or dashboard rendering; late and pre-mutation results are discarded, post-mutation refresh has a fresh epoch, and duplicate Create emits once.
- Ledger headline/bar/row, `/usage`, and dashboard agree on Ready+Admitted contribution and status/count/cap/truncation/unavailable reason; the dashboard gets no path/body/raw error and republishes on cache changes, while Copy path is an explicit TUI-only action that retains its clipboard lease.
- The TUI exposes only path/status/actions, never content; editor/writeback remains deferred by the stated source blocker.

---

# Plan B — Safe `/agent` Controls and Read-Only Experimental Work Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` task-by-task and one implementer at a time. Tasks B1–B4 have no source dependency on Plan A, but do not start them until Plan A’s review gate is complete because manual memory is the required product priority. Task B5 waits for Plan A's verifier changes and merges, rather than replaces, their path unions.

**Goal:** Extend the existing `/agent` surface with authority-checked ordinary-child controls while making the already-persisted work graph inspectable as an off-by-default, experimental, read-only mode.

**Architecture:** Add one narrow public core bridge on `ThreadManager`. It accepts a claimed root plus target, proves that the root is loaded, has no parent, and has a root-capable source according to `is_non_root_agent`, uses that root thread's actual shared `session.services.agent_control`, and fail-closed revalidates matching persisted/live lineage plus status at execution time. App-server first asks state for the root-scoped durable historical work-graph ownership fact, then calls the core bridge through one `serialization: None` RPC with its own per-`(root,target)` operation gate. Identical requests join one spawned result; a different request for that target is rejected while pending. `/agent` immediately opens a dedicated bottom-pane Agents view from cached navigation and refreshes in the background. Its off-by-default Work graph mode reuses `workGraph/list`, adds only sanitized recent event summaries, and never mutates a graph.

**Tech Stack:** Rust core/thread manager, app-server protocol v2 and request processor, existing root-scoped `AgentControl`, persisted SQLite work-graph state, existing TUI background request path and bottom-pane child views.

**Spec:** `docs/superpowers/specs/2026-08-31-elpis-daily-driver-readiness-design.md` §3.4 and §Verification; `.superpowers/daily-driver-audits/agents-memory.md` §§1–2; `docs/WORK_GRAPHS.md`.

## Plan B global constraints

- `root_thread_id` is client-selected, not trusted as “active.” Core must prove that it exists as a loaded thread, `!source.is_non_root_agent()`, and has no persisted or live parent. `SessionSource::Internal` and every `SessionSource::SubAgent` variant, including `SubAgent::Other`, are therefore never roots. The target and each traversed descendant edge must be ordinary `SubAgentSource::ThreadSpawn` lineage; graph-worker ownership is filtered separately before the bridge. Persisted and live lineage are separate witnesses: when both exist, parent, source, and depth must match exactly; a conflict, cycle, malformed record, or lookup error rejects the request rather than letting either witness win. Child-as-fake-root, wrong-root, unrelated, unknown, conflicting/stale lineage, internal/other-subagent, and primary targets are rejected with no core/graph side effect, and the same checks repeat inside the core bridge immediately before mutation.
- The exact action matrix is:

  | Action | Required edge/runtime state | Applied result |
  | --- | --- | --- |
  | `follow_up` | Open ordinary descendant; nonblank message; runtime `PendingInit`, `Running`, `Interrupted`, `Completed`, or `Errored` after any existing V2 open-agent reload | Fresh content-free status after one `send_input` |
  | `interrupt` | Open ordinary descendant; runtime exactly `Running` | Fresh content-free status after one `interrupt_agent` |
  | `resume` | Persisted spawn edge exactly `Closed`; runtime unloaded/`NotFound`, or loaded `Shutdown` only after the old session fully exits and unloads | Fresh content-free status other than `Shutdown`/`NotFound` after one cold resume and edge reopen |
  | `close` | Persisted Open ordinary descendant with any listed runtime; or persisted Closed ordinary descendant with any listed runtime solely as a repair/idempotency path | Fresh target `Shutdown` or `NotFound` only after every live ThreadSpawn descendant is also terminal; Closed is idempotent only when target and descendants are terminal, otherwise it repairs the leaked subtree |

  `follow_up` is not an implicit resume. A `follow_up` field on another action is rejected. For follow-up only, an Open+`NotFound` target may be reloaded through the existing safe V2 metadata/load seam; otherwise it is rejected. Close may durably close a persisted Open+`NotFound` edge without loading it. A live-only/ephemeral child without an exact persisted ThreadSpawn edge may be followed up or interrupted when its live lineage/status permits, but it cannot close or resume in this slice. A validated Closed ordinary edge with live target or descendant state accepts only `close`, which repairs the whole subtree; every other action still follows the table and rejects that inconsistent state. The bridge, never TUI cache, enforces this table.
- Cold resume uses a `Config` reconstructed from the loaded root's current effective session configuration, not app-server startup config. It validates the stored parent chain/depth and closed edge, restores stored path/nickname/role/source, and lets `resume_agent_from_rollout` select V1/V2 from stored history. A loaded target may emit `Shutdown` before its session loop exits; wait through the existing completion/unload seam until that old target is absent before spawning, so `spawn_thread_with_source` cannot return the dead loaded thread. After resume, reject/compensate any fresh `Shutdown`/`NotFound` result instead of reopening the edge. Preserve the existing descendant policy exactly: only current-effective V1 plus stored-history V1 may reopen persisted Open descendants; current-effective V2 or stored-history V2 stops descendant reopening. Closed descendants never reopen. Existing V2 open-but-unloaded messaging continues through `ensure_v2_agent_loaded`; do not fake resume by changing a status flag.
- Durable state is part of success, not best-effort bookkeeping for the new root-authoritative persisted-edge bridge. The current edge-status store can acknowledge a missing-row no-op, so every bridge Closed/Open transition must immediately read back the exact parent+child edge and required status; a missing, mismatched, unreadable, or wrong-status readback is failure. Persisted-edge close must observe `Closed` before shutdown; a write/readback failure returns rejection and sends no shutdown. A validated persisted edge counts as known even when the target is unloaded—do not rely only on in-memory agent metadata—so Open+`NotFound` closes durably without a fake load. Enumerate the full ThreadSpawn descendant closure by reconciling persisted and live edges: persisted edges bridge unloaded intermediate agents, and live metadata adds reachable live-only descendants. Revalidate conflicts/cycles/errors before mutation, then return Applied only after target plus every live member re-observe as `Shutdown`/`NotFound`. If target or descendant shutdown fails and anything remains live, restore the target edge to `Open` and observe the exact readback before rejection. If that compensation write/readback also fails, return only `CoreOperationFailed`; a later close must accept and repair Closed+live-target and/or live-descendant state rather than rejecting or treating it as idempotent. Resume returns Applied only after the resumed target's edge is written and read back durably `Open`; if reopening fails, shut down the newly resumed subtree and leave or restore/read back the edge `Closed`; any incomplete shutdown is likewise repairable by a later close. Preserve the existing model-facing `AgentControl::close_agent` behavior for live-only/ephemeral agents: the bridge rejects them before calling the persisted-edge path, while a shared internal shutdown traversal may be reused. Cover target failure, unloaded-intermediate descendants, acknowledged-no-op persistence, compensation failure, retry, and the unchanged live-only model-tool close.
- `agent/control` has no outer request serialization. Parse both IDs before any gate access and key one in-flight entry by canonical `(ThreadId, ThreadId)`, never by client strings; UUID spelling aliases must join the same operation rather than bypass coalescing. An identical full request, including follow-up text, joins one spawned operation/result; a different action or different follow-up text returns `RequestAlreadyPending`. Use the smallest local gate: a short `std::sync::Mutex` map, a monotonically unique entry generation, and a generation-checked RAII removal guard held by the spawned owner. The owner holds the only result sender. Success, error, abort, panic, or future drop removes only its own generation; sender drop maps for waiters to fixed `CoreOperationFailed`. Dropping any waiter cannot cancel or leak the operation. Unrelated typed targets remain concurrent.
- Wire IDs have one fixed fail-closed mapping before state or gate access: an unparseable root is `RootNotFound`, an unparseable target is `TargetNotFound`, and `target_thread_id` is present in a rejection only when that target parsed and was reserialized canonically. Do not add another invalid-ID error vocabulary or echo an untrusted wire spelling.
- `interrupt` and `close` require a TUI confirmation naming the target agent. `follow_up` and `resume` do not. The request runs after confirmation, not when the menu opens.
- For this slice every graph-owned worker control that reaches the server is rejected with typed code `GraphOwnedWorkerReadOnly`; it does not call the core bridge and does not mutate the graph. Ownership is durable historical `task_started` assignment under the claimed root, including a terminal task whose current `assigned_thread_id` was cleared. A fully readable root history with no matching assignment returns false. Any malformed relevant `task_started` payload, invalid thread ID, query/read error, or unavailable store fails closed with `GraphOwnershipUnavailable`. Atomic task cancellation/blocking is deferred.
- The Agents view needs no ownership RPC, but it does need a new nonblocking inventory path. The current `/agent` path is blocking `thread/loaded/list` plus per-thread reads; replace it with paginated background `thread/list` using canonical `ancestorThreadId = root`, `sourceKinds = [SubAgentThreadSpawn]`, `useStateDbOnly = true`, and non-archived rows. The relationship filter already forces the state DB and bounds the query to the root's persisted descendants, so it must never issue an unscoped request or trigger rollout scan-and-repair. Classify only after the final page: ordinary persisted rows require canonical IDs, matching `Thread.parent_thread_id` and ThreadSpawn source parent at every hop, and an acyclic complete chain to the active root. Do not compare `Thread.session_id`: persisted `thread/list` currently sets it to each thread's own ID, so it is not a shared-tree discriminator. The immediate cached-navigation view may retain a currently observed live-only row as a control-free candidate; only a successful server `agent/status` validation may give it follow-up/interrupt capabilities, and a rejection leaves it control-free. Work-graph `SubAgent::Other` threads are deliberately absent from Agents inventory; represent assigned workers only through sanitized `workGraph/list` task data in the Experimental read-only mode. The server still performs durable historical ownership for every status/control request; inventory text never grants authority.
- `ThreadStatus::NotLoaded` does not distinguish a persisted Open V2 agent from a Closed agent, so TUI state must never infer controls from it. After local inventory classification, issue the new root-scoped, content-free `agent/status` request for each ordinary row. The server repeats root/lineage/graph-ownership validation and returns freshly observed runtime status plus exact `follow_up`, `interrupt`, `resume`, and `close` capability booleans derived from the matrix and durable edge. Until that response arrives the row has no mutation keys. Persisted Open+`NotFound` exposes close but exposes follow-up only after read-only validation of the existing safe V2 reload prerequisites (registry metadata plus stored V2 history); a V1/corrupt/nonreloadable target does not. Closed+`NotFound` exposes resume and idempotent close but not follow-up; a live-only child can expose follow-up/interrupt but never close/resume. TUI still sends the selected action through `agent/control`, which revalidates everything; capabilities are display affordances, not authority.
- Work graph inspection is disabled by default and labelled `Experimental · read-only`. It does not enable fanout or schedule any worker. It is not dashboard content.
- Control privacy has an explicit history boundary: `send_input` necessarily records the follow-up in the selected target conversation, but the controlling/root transcript, its UI history cells, control response, diagnostics, and telemetry never receive that body. No completion/error message, graph instruction, raw event payload, path-bearing error, or formatted core/store error enters outward protocol values, the controlling/root transcript, or telemetry. Agent status uses `CollabAgentStatus` only. The response has no free-text detail field; TUI maps `AgentControlErrorCode` to fixed local copy.
- Work-graph list mapping is an explicit projection, not pass-through. Graph `name` and task `title` are display labels only: trim, replace control characters/newlines with spaces, collapse whitespace, cap at 80/120 Rust characters respectively, and fall back to `Unnamed graph`/`Untitled task`. Graph IDs must parse as UUIDs and round-trip in canonical form. Task/dependency/event task IDs must satisfy a small manual ASCII predicate equivalent to `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`; do not add a regex dependency. Assigned thread IDs must parse as `ThreadId` and round-trip canonically. Malformed stored identity yields the fixed RPC error `Work graph data unavailable`. Enum-derived kind/status strings and numeric counts pass through. Graph `error` is always `None`; task `evidence` is always `[]`; task `failure_reason` is always `None`; task `result` is either `None` or an object containing only numeric `changedFileCount`, `checkCount`, `evidenceCount`, `riskCount`, `edgeCaseCount`, `openQuestionCount`, and `uncheckedCount`. Recent event type is one of the persisted allowlist (`graph_created`, `graph_started`, `graph_succeeded`, `graph_failed`, `graph_cancelled`, `task_started`, `task_succeeded`, `task_failed`, `task_blocked`, `task_cancelled`) or the fixed value `unknown`; payload is never read into the response. Store absence or any list/mapping failure returns only `Work graph data unavailable`; a valid empty store returns `data: []`.

## Plan B file map and interfaces

| File | Responsibility |
| --- | --- |
| `codex-rs/core/src/thread_manager.rs` | Narrow public root-authority bridge and root-effective resume config; never expose `AgentControl`. |
| `codex-rs/core/src/thread_manager_tests.rs` | Root/lineage/action-matrix and correct shared-control tests. |
| `codex-rs/core/src/agent/control.rs`, `agent/control/legacy.rs`, `agent/control/spawn.rs`, and `agent/control_tests.rs` | Exact-edge status write/readback plus persisted-edge close helper, complete persisted/live descendant traversal, preserved live-only close behavior, durable resume/compensation, cold V1/V2 resume, and store-failure tests. |
| `codex-rs/state/src/runtime/work_graphs.rs` | Root-scoped durable historical worker-ownership fact plus existing newest-first/root-filtered graph list tests; preserve `created_at_ms DESC, id ASC`. |
| `codex-rs/app-server-protocol/src/protocol/v2/agent_control.rs` (new), `v2/mod.rs`, and `protocol/common.rs` | Additive typed `agent/status` and `agent/control` RPC/outcomes with `serialization: None`; reuse `CollabAgentStatus`. |
| `codex-rs/app-server-protocol/src/protocol/v2/work_graph.rs` | Add defaulted sanitized transition summaries only; retain all existing fields and `event_count`. |
| `codex-rs/app-server/src/message_processor.rs`, `request_processors.rs`, `request_processors/thread_processor.rs`, and `request_processors/thread_processor_tests.rs` | Dispatch, root-scoped ownership check, cancellation-safe per-target spawned-operation gate, safe mapping, and sanitized graph-list mapping. |
| `codex-rs/tui/src/app.rs`, `app/background_requests.rs`, `app_event.rs`, `app/event_dispatch.rs`, and `app/session_lifecycle.rs` | App-owned overlay epoch/request IDs, immediate cached open, root-scoped paginated background thread inventory/classification, liveness/control/graph requests, result guards, and lifecycle invalidation. |
| `codex-rs/tui/src/bottom_pane/agent_view.rs` (new), `bottom_pane/mod.rs`, and `multi_agents.rs` | Dedicated minimal view; reuse agent rows/navigation, `CustomPromptView`, selection child views, and delete one-time history rendering. |
| `codex-rs/tui/src/app_server_session.rs`, `app/tests.rs`, and colocated Agent view tests | Typed client plus exact relationship-filter request, deterministic confirmation, navigation, liveness, stale-result, and graph rendering tests. |
| `codex-rs/features/src/lib.rs`, `features/src/tests.rs`, `codex-rs/tui/src/chatwidget/settings_popups.rs`, and `chatwidget/tests/popups_and_settings.rs` | Independent `WorkGraphInspector`, Experimental metadata, default false, settings persistence, and legacy config behavior. |
| `tools/verify-elpis/surfaces.toml` and `tests/verify-elpis/test_verify_elpis.sh` | Stable protocol/core/state/app-server/feature/TUI filters and exact first-match path ownership. |

The additive RPC contract introduced in Task B1 is:

```rust
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, TS, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "v2/")]
pub enum AgentControlAction { FollowUp, Interrupt, Resume, Close }

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentControlParams {
    pub root_thread_id: String,
    pub target_thread_id: String,
    pub action: AgentControlAction,
    #[serde(default)]
    pub follow_up: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentStatusParams {
    pub root_thread_id: String,
    pub target_thread_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, TS, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentActionCapabilities {
    pub follow_up: bool,
    pub interrupt: bool,
    pub resume: bool,
    pub close: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "v2/")]
pub enum AgentControlErrorCode {
    RootNotFound, RootNotTopLevel, PrimaryTargetForbidden,
    TargetOutsideRootLineage, TargetNotFound, InvalidActionForStatus,
    EmptyFollowUp, UnexpectedFollowUp, GraphOwnedWorkerReadOnly,
    GraphOwnershipUnavailable, RequestAlreadyPending, CoreOperationFailed,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export_to = "v2/", tag = "outcome")]
pub enum AgentControlResponse {
    Applied {
        target_thread_id: String,
        status: CollabAgentStatus,
    },
    Rejected {
        #[serde(default)] target_thread_id: Option<String>,
        code: AgentControlErrorCode,
        #[serde(default)] status: Option<CollabAgentStatus>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export_to = "v2/", tag = "outcome")]
pub enum AgentStatusResponse {
    Available {
        target_thread_id: String,
        status: CollabAgentStatus,
        capabilities: AgentActionCapabilities,
    },
    Rejected {
        #[serde(default)] target_thread_id: Option<String>,
        code: AgentControlErrorCode,
        #[serde(default)] status: Option<CollabAgentStatus>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkGraphEventSummary {
    #[ts(type = "number")]
    pub sequence: i64,
    pub task_id: Option<String>,
    pub event_type: String,
    #[ts(type = "number")]
    pub created_at_ms: i64,
}
```

`agent/status` and `agent/control` are new and registered with `serialization: None`, so legacy clients remain functional. Status is read-only, bypasses the mutation gate, and never loads/resumes/stops a target; it only validates and projects current capability booleans. Existing `workGraph/list` request/response names and fields stay unchanged; only `recent_events: Vec<WorkGraphEventSummary>` is added to each graph with `#[serde(default)]`. The server/core enforce authority; TUI checks are usability guards only.

### Task B1: Add the core authority bridge and durable graph-worker ownership

**Files:**

- Create: codex-rs/app-server-protocol/src/protocol/v2/agent_control.rs
- Modify: codex-rs/app-server-protocol/src/protocol/v2/mod.rs
- Test: codex-rs/app-server-protocol/src/protocol/v2/tests.rs
- Modify: codex-rs/core/src/thread_manager.rs
- Test: codex-rs/core/src/thread_manager_tests.rs
- Modify: codex-rs/core/src/agent/control.rs
- Modify: codex-rs/core/src/agent/control/legacy.rs
- Modify: codex-rs/core/src/agent/control/spawn.rs
- Test: codex-rs/core/src/agent/control_tests.rs
- Modify and test: codex-rs/state/src/runtime/work_graphs.rs

**Consumes:** The loaded root thread's existing shared AgentControl, persisted/live spawn lineage, existing resume_agent_from_rollout and V2 reload seams, and persisted work-graph events.

**Produces:** Content-free status/control protocol contracts, root-authoritative ThreadManager status/control bridges, and one root-scoped historical graph-worker ownership query for Task B2.

- [ ] **Step 1: Write fail-first protocol, authority, matrix, resume, and ownership tests.**

  Use the locked prefixes agent_status_bridge_ and agent_control_bridge_ for core and work_graph_worker_ownership_ for state. Cover every enumerated action/status/edge row; an `Internal` root; a `SubAgent::Other` fake root with no parent; root/internal/primary/unrelated targets; persisted/live parent, source, or depth disagreement; cycles and lookup errors; lineage changed immediately before mutation; reloadable Open+NotFound follow-up through the V2 seam; close of persisted Open+NotFound without reload; and fresh status after each applied action. Add status projection cases proving reloadable V2 Open+NotFound gives follow-up/close but not resume, V1/corrupt/missing-metadata Open+NotFound gives close but not follow-up/resume, Closed+NotFound gives resume/idempotent-close but not follow-up, and live-only Running gives follow-up/interrupt but not close/resume. A live-only close must reject before shutdown. Plant completion/error/follow-up sentinels and prove no status/control response, root transcript, diagnostic, or telemetry exposes them while the target conversation legitimately records a sent follow-up.

  Cover cold resume metadata and all current/stored version combinations: V1/V1 reopens only persisted Open descendants; V2/V1, V1/V2, and V2/V2 reopen none; Closed descendants never reopen. Add a gated, sleep-free loaded-`Shutdown` race: hold the old session between its Shutdown status and actual exit/unload, prove resume neither reuses it nor reopens the edge, release it, then prove exactly one cold replacement appears with fresh status other than `Shutdown`/`NotFound`. Inject spawn-edge store failures and an acknowledged-without-mutation fake store. Prove initial persisted-edge close write/readback failure—including a successful no-op acknowledgement—sends no shutdown; successful bridge close leaves the target and its whole live ThreadSpawn subtree terminal and the exact target edge observably Closed. Include target → unloaded persisted child → live grandchild behind a gate and prove the grandchild is found/stopped; persisted/live conflict, cycle, or enumeration error stops before mutation. Prove target shutdown failure restores and observes Open; descendant shutdown failure after the target stops restores Open and a retry completes the remaining subtree; compensation write/readback or no-op failure returns only `CoreOperationFailed`, and a second close repairs Closed+terminal-target+live-descendant state. Separately prove the pre-existing model-tool `close_agent` still closes a live-only/ephemeral child while the new bridge rejects that same no-edge target before shutdown. Prove resume Open no-op/readback failure or dead post-resume status shuts down the newly resumed subtree and leaves/restores an observably Closed edge; no operation reports Applied before its durable postcondition.

  Ownership cases are: active `task_started` assignment true; terminal task whose current assignment was cleared still true; the same worker under another root false; fully readable history without a match false; and any malformed relevant payload/ID or read/query failure returns an error for `GraphOwnershipUnavailable` mapping.

- [ ] **Step 2: Record the fail-first checks without running Rust.**

  Deferred checks:

  ~~~bash
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-app-server-protocol --lib --locked agent_status_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-app-server-protocol --lib --locked agent_control_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core --lib --locked agent_status_bridge_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core --lib --locked agent_control_bridge_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-state --lib --locked work_graph_worker_ownership_
  ~~~

  Expected initial result: the new types, bridge, and ownership query do not exist. Do not execute now.

- [ ] **Step 3: Add the additive content-free protocol types.**

  Add the exact contract above and export it from protocol/v2/mod.rs. Reuse CollabAgentStatus; do not create a second status vocabulary. Keep business rejection in the typed status/control responses rather than embedding arbitrary core errors.

- [ ] **Step 4: Add the root-scoped historical ownership fact.**

  Add StateRuntime::is_work_graph_worker_for_root(root_id, thread_id) -> Result<bool>. Join graphs to events, require the claimed root and `event_type = task_started`, and extract only a parseable canonical `thread_id` from every relevant payload. Do not use current `assigned_thread_id` as authority. Any malformed relevant row makes the query fail; only a fully readable no-match result is false. Do not change the already-correct graph-list ordering.

- [ ] **Step 5: Add one ThreadManager authority bridge.**

  Add the async methods:

  ~~~text
  agent_status_from_root(root, target) -> AgentStatusResponse
  control_agent_from_root(root, target, action, follow_up) -> AgentControlResponse
  ~~~

  Resolve a loaded root; require `!source.is_non_root_agent()` plus absent persisted/live parents; reject target == root; prove the target belongs to that root through an acyclic lineage whose persisted/live parent, source, and depth agree wherever both exist; then use `root.session.services.agent_control`. Status performs no load or mutation and projects only matrix-derived booleans from freshly validated runtime plus exact persisted-edge presence/status; for Open+`NotFound`, it advertises follow-up only if the same read-only registry-metadata/stored-V2-history prerequisites used by `ensure_v2_agent_loaded` are currently satisfied. Control repeats root, full lineage, direct-edge/source, durable-edge requirement for close/resume, and runtime-status validation immediately before mutation.

  For every applied action, return a freshly observed content-free status; close may therefore return `Shutdown` or `NotFound`. Add/reuse a persisted-edge close helper that writes an expected status and reads back that exact parent+child edge/status before proceeding; never treat the store's unit success as proof. Its descendant enumeration walks persisted ThreadSpawn edges through unloaded intermediates, overlays all reachable live ThreadSpawn metadata, and rejects conflict/cycle/error before shutdown. It observes Closed before shutdown, repairs Closed+terminal-target+live-descendant state, observes Open on incomplete-shutdown compensation, and reports Applied only after every live target is terminal. The ThreadManager bridge calls this helper only after proving an exact persisted target edge. Do not globally require persistence in the existing model-facing `AgentControl::close_agent`; preserve its live-only/ephemeral contract and tests. Make shared `resume_agent_from_rollout` wait for a loaded-`Shutdown` target to exit/unload before spawning and return success only after a non-`Shutdown`/non-`NotFound` replacement is observed and exact Open readback succeeds; apply the compensation rules in the global constraints on later failure. For resume, require a persisted Closed ThreadSpawn edge, reconstruct root-effective configuration from `root.session.new_default_turn()` through the existing `build_agent_resume_config` helper, restore stored agent metadata, and reuse `resume_agent_from_rollout`. Preserve the current-effective/stored-history V1/V2 descendant policy exactly. Never expose AgentControl itself or fabricate state.

- [ ] **Step 6: Commit the independently reviewed core/state slice.**

  Deferred commit:

  ~~~bash
  git add codex-rs/app-server-protocol/src/protocol/v2/agent_control.rs codex-rs/app-server-protocol/src/protocol/v2/mod.rs codex-rs/app-server-protocol/src/protocol/v2/tests.rs codex-rs/core/src/thread_manager.rs codex-rs/core/src/thread_manager_tests.rs codex-rs/core/src/agent/control.rs codex-rs/core/src/agent/control/legacy.rs codex-rs/core/src/agent/control/spawn.rs codex-rs/core/src/agent/control_tests.rs codex-rs/state/src/runtime/work_graphs.rs
  git commit -m "feat: add root-authoritative agent controls"
  ~~~

### Task B2: Add typed agent status/control routes and a cancellation-safe mutation gate

**Files:**

- Modify: codex-rs/app-server-protocol/src/protocol/common.rs
- Modify: codex-rs/app-server/src/message_processor.rs
- Modify: codex-rs/app-server/src/request_processors.rs
- Modify: codex-rs/app-server/src/request_processors/thread_processor.rs
- Test: codex-rs/app-server/src/request_processors/thread_processor_tests.rs

**Consumes:** Task B1 protocols, core bridges, and historical ownership query; existing app-server background_tasks ownership.

**Produces:** A server-authoritative read-only status RPC plus a non-serialized control RPC that coalesces only identical mutations and remains alive when a waiter disappears.

- [ ] **Step 1: Write fail-first routing, ownership, coalescing, cancellation, and privacy tests.**

  Register locked app-server tests under agent_status_ and agent_control_. Prove exact status/control dispatch and `serialization: None`; malformed root and target IDs map respectively to `RootNotFound` and `TargetNotFound` before state or gate access, and only a parsed target is returned in canonical form. Status is read-only, uses no mutation-gate entry, repeats graph ownership/root checks, and returns the exact B1 capability matrix without loading a target. Canonical, uppercase, and braced UUID aliases for the same root/target join one control call/result; every graph-owned status/control request fails closed before core; unavailable state and malformed/read-failed ownership become `GraphOwnershipUnavailable`; identical full control requests make one core call/result; a different action or different follow-up for the same canonical root/target gets `RequestAlreadyPending`; unrelated targets proceed concurrently; and dropping the first waiter neither cancels nor leaks the operation. Separately abort and panic the spawned owner, then prove the generation guard removes its entry, all waiters receive fixed `CoreOperationFailed`, and a retry proceeds. Also prove every ordinary applied/rejected/core-error completion removes the gate. Plant a follow-up sentinel and prove it is absent from responses, errors, tracing, and the controlling/root transcript; assert only the target conversation records it after a successful send.

- [ ] **Step 2: Record the fail-first checks without running Rust.**

  Deferred checks:

  ~~~bash
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-app-server-protocol --lib --locked agent_status_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-app-server-protocol --lib --locked agent_control_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-app-server --lib --locked agent_status_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-app-server --lib --locked agent_control_
  ~~~

- [ ] **Step 3: Register the additive RPC without outer serialization.**

  Add AgentStatus => "agent/status" and AgentControl => "agent/control" through the existing ClientRequest mechanism with serialization: None. Parse both wire ID strings into `ThreadId` before ownership lookup or gate access; apply the fixed malformed-ID mapping above without entering the map. Status performs ownership/root/core inspection inline or on a normal background task but never enters the mutation gate. Existing clients and workGraph/list stay unchanged.

- [ ] **Step 4: Add the smallest cancellation-safe per-target gate.**

  `ThreadRequestProcessor` owns one shared in-flight map keyed by canonical `(ThreadId, ThreadId)` behind a short `std::sync::Mutex`; never key it by raw request strings. Each entry stores a unique generation, exact `(action, follow_up)` fingerprint, and shared/watchable typed result. The first request inserts it and spawns the state ownership check plus `ThreadManager` bridge on existing `background_tasks`. The spawned future immediately owns a generation-checked RAII removal guard and the only result sender. An identical request joins; a different fingerprint is rejected immediately. Guard drop removes only the matching generation on normal return, error, abort, panic, or future drop; sender drop becomes fixed `CoreOperationFailed` for waiters. A dropped waiter owns neither sender nor guard and cannot cancel or leak the operation. Serialize canonical response IDs and do not serialize unrelated targets.

- [ ] **Step 5: Commit the independently reviewed route slice.**

  Deferred commit:

  ~~~bash
  git add codex-rs/app-server-protocol/src/protocol/common.rs codex-rs/app-server/src/message_processor.rs codex-rs/app-server/src/request_processors.rs codex-rs/app-server/src/request_processors/thread_processor.rs codex-rs/app-server/src/request_processors/thread_processor_tests.rs
  git commit -m "feat: expose authoritative agent control rpc"
  ~~~

### Task B3: Replace transcript snapshots with an immediate nonblocking Agents view

**Files:**

- Create: codex-rs/tui/src/bottom_pane/agent_view.rs
- Modify: codex-rs/tui/src/bottom_pane/mod.rs
- Modify: codex-rs/tui/src/app.rs
- Modify: codex-rs/tui/src/app_event.rs
- Modify: codex-rs/tui/src/app/background_requests.rs
- Modify: codex-rs/tui/src/app/event_dispatch.rs
- Modify: codex-rs/tui/src/app/session_lifecycle.rs
- Modify: codex-rs/tui/src/app/tests.rs
- Modify: codex-rs/tui/src/app_server_session.rs
- Modify: codex-rs/tui/src/multi_agents.rs
- Delete after removing the only production use: codex-rs/tui/src/app/agent_status_feed.rs and agent_status_feed_tests.rs

**Consumes:** Task B2 typed status/control RPCs; cached agent_navigation; existing CustomPromptView, SelectionView, thread switching, and bottom-pane view stack.

**Produces:** /agent opens instantly, receives server-derived capabilities for each ordinary descendant, controls only the selected allowed target/action, keeps transcript clean, and rejects stale async results.

- [ ] **Step 1: Write fail-first Agent view tests.**

  Lock tests under agent_view_. Prove: opening /agent is synchronous and does not await an RPC; its background inventory sends exact canonical `ancestorThreadId = root`, `sourceKinds = [SubAgentThreadSpawn]`, `useStateDbOnly = true`, and non-archived params, follows every page, and applies results only after the final page. Assert no unscoped/list-and-repair request, `SubAgentOther` filter, blocking `thread/loaded/list`, or per-thread read is issued by `/agent`. Discard ThreadSpawn parent/source mismatch, cycles, broken ancestor chains, and incomplete/error pages; deliberately distinct per-row `session_id` values do not hide a valid chain. Every ordinary row starts control-free until its matching status response arrives. Prove server capabilities—not `ThreadStatus::NotLoaded`—yield reloadable V2 Open+NotLoaded follow-up/no-resume, nonreloadable V1/corrupt Open+NotLoaded no-follow-up/no-resume, and Closed+NotLoaded resume/no-follow-up after a cold restart. Starting a control clears that target's capabilities and invalidates any older status generation; every Applied or Rejected completion requests fresh status. Cover a Running→Completed InvalidAction rejection, a late pre-control status result, and existing navigation/lifecycle updates while the overlay is open; none may leave or restore a stale key. Prove no V2 AgentStatusHistoryCell or WorkGraphHistoryCell is appended; the parent view survives follow-up and confirmation child flows; blank follow-up sends nothing; interrupt/close confirmation names the exact target; resume is direct only when allowed; primary has no controls; pending only disables that target; unrelated navigation remains live; closed rows are selectable; Enter still switches transcript; Alt+Left/Right still navigates while the modal is open, with platform word-motion fallback where appropriate; selection survives refresh; cursor movement applies a result only to its original target; A1 cannot overwrite A2 after A→B→A; and closing/reopening or switching root/transcript invalidates prior responses. Carry epoch/root/target/action through follow-up submission and confirmation acceptance; prove accepting either child after its parent overlay was closed, replaced, or switched sends zero RPC requests. No Work graph `Other` source or raw source string is requested/rendered in Agents mode; graph-assigned workers appear only in the sanitized read-only mode and grant no authority.

- [ ] **Step 2: Record the fail-first check without running Rust.**

  Deferred check:

  ~~~bash
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib --locked agent_view_
  ~~~

- [ ] **Step 3: Open a dedicated view from cached state before refreshing.**

  Add AgentView as a bottom-pane view and open it immediately from cached agent_navigation. Through the cloneable AppServerRequestHandle, `tokio::spawn`, and AppEvent path, paginate the exact relationship-filtered/state-DB-only `thread/list` described globally; classify only after all pages succeed using the canonical-root/parent/source-chain rules. Then issue one background `agent/status` per ordinary candidate and keep it control-free until its guarded result arrives. `/agent` must not use an unscoped list, rollout repair, `SubAgentOther`, the current blocking `thread/loaded/list`, or per-thread `thread/read`. Add only the minimal generic replace_view_by_id operation needed to refresh the parent while a child view is open.

  Remove both transcript paths: the V2 AgentStatusHistoryCell early return and work_graph_history_cell append. Delete the now-unused agent status feed module and obsolete helper/tests rather than retaining parallel UI paths.

- [ ] **Step 4: Reuse existing child views for exact controls.**

  AgentView emits App events carrying the current instance epoch, root, target, action, and matching status-request generation. Render f Follow-up, i Interrupt, r Resume, and x Close only when the latest server capability permits them. Use CustomPromptView for Follow-up, a target-named SelectionView confirmation for Interrupt and Close, and direct Resume. Cancel or accept returns to the same parent row. App revalidates that full intent against live overlay state and latest capability generation before spawning any control RPC; a stale child event is discarded with zero request. At control submission, advance that target's status generation, clear its capabilities, and keep it control-free until the operation and mandatory fresh status settle. Disable primary rows. Agents mode contains only root-descendant ThreadSpawn rows; graph-assigned workers are rendered from sanitized Work graph task data with fixed read-only copy in Task B4. Keep Enter for SelectAgentThread and Alt navigation in AgentView; do not introduce global bindings.

- [ ] **Step 5: Make App the sole stale-result authority.**

  App owns a never-reused AgentOverlayState instance_epoch plus root, mode, selected target, per-target statuses/capabilities/results/pending state, and monotonic inventory/status/control/graph request IDs. Apply a status or control completion only when epoch, root, target, action where applicable, and request ID still match; cache it against the request target even if the cursor moved. A new overlay, root/transcript change, or close invalidates the epoch. Every control completion, Applied or Rejected, schedules a fresh guarded target status. While the overlay is open, existing agent-navigation/lifecycle changes for its active root schedule one coalesced inventory/status refresh; do not add polling or a timer.

- [ ] **Step 6: Commit the independently reviewed Agents view.**

  Deferred commit:

  ~~~bash
  git add codex-rs/tui/src/bottom_pane/agent_view.rs codex-rs/tui/src/bottom_pane/mod.rs codex-rs/tui/src/app.rs codex-rs/tui/src/app_event.rs codex-rs/tui/src/app/background_requests.rs codex-rs/tui/src/app/event_dispatch.rs codex-rs/tui/src/app/session_lifecycle.rs codex-rs/tui/src/app/tests.rs codex-rs/tui/src/app_server_session.rs codex-rs/tui/src/multi_agents.rs codex-rs/tui/src/app/agent_status_feed.rs codex-rs/tui/src/app/agent_status_feed_tests.rs
  git commit -m "feat: add nonblocking agent control view"
  ~~~

### Task B4: Add the default-off experimental Work graph view

**Files:**

- Modify and test: codex-rs/features/src/lib.rs and features/src/tests.rs
- Modify and test: codex-rs/app-server-protocol/src/protocol/v2/work_graph.rs and protocol/v2/tests.rs
- Modify and test: codex-rs/app-server/src/request_processors/thread_processor.rs and thread_processor_tests.rs
- Test only: codex-rs/state/src/runtime/work_graphs.rs
- Modify and test: codex-rs/tui/src/chatwidget/settings_popups.rs and chatwidget/tests/popups_and_settings.rs
- Modify: codex-rs/tui/src/app.rs, app_event.rs, app/background_requests.rs, app/event_dispatch.rs, app/session_lifecycle.rs, app_server_session.rs, multi_agents.rs, and bottom_pane/agent_view.rs
- Test: codex-rs/tui/src/app/tests.rs and Agent view tests

**Consumes:** Task B3 overlay epochs/view; existing newest-first root-filtered workGraph/list; existing experimental feature registry.

**Produces:** A disabled-by-default, read-only graph inspector with safe recent history and no graph mutations.

- [ ] **Step 1: Write fail-first feature, compatibility, privacy, list, and view tests.**

  Lock filters work_graph_inspector_, work_graph_list_, and work_graph_view_. Prove missing legacy config leaves the feature false and it is independent of SpawnCsv/enable_fanout. Legacy JSON without recentEvents decodes to an empty list. Persist multiple/equal-timestamp/other-root graphs and preserve `created_at_ms DESC, id ASC`. A valid empty database returns `data: []`; an absent state database and injected graph/task/event read failures return only the fixed RPC error `Work graph data unavailable`, with no formatted store error.

  Plant raw instruction, prompt, payload, result prose, evidence, failure reason, graph error, control characters, overlong labels, and formatted-store-error sentinels. Prove the protocol/UI expose only the globally specified label projection, enum/identifier metadata, numeric result counts, empty evidence, absent failure/error fields, and allowlisted recent-event metadata. Invalid stored identities fail with the fixed safe RPC error. Prove disabled sends no request; loading/refreshing, empty, loaded, and safe-error-with-prior-same-root-data are distinct; `data.first()` is the newest graph; stale requests cannot overwrite current data. A task with validated `assigned_thread_id` renders only a fixed `Assigned worker · read-only` label plus that canonical ID/status metadata, never an `Other` source or mutation control.

- [ ] **Step 2: Record the fail-first checks without running Rust.**

  Deferred checks:

  ~~~bash
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-features --lib --locked work_graph_inspector_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-app-server-protocol --lib --locked work_graph_list_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-app-server --lib --locked work_graph_list_
  cd codex-rs && CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib --locked work_graph_view_
  ~~~

- [ ] **Step 3: Add one existing-style experimental feature.**

  Add Feature::WorkGraphInspector with key work_graph_inspector, default false, and:

  ~~~text
  name: Work graph inspector
  menu_description: Inspect persisted agent work graphs in /agent.
  announcement: Work graph inspection is experimental and read-only.
  ~~~

  Use Stage::Experimental, the existing settings persistence path, and no new feature framework.

- [ ] **Step 4: Add only sanitized recent history to the existing list contract.**

  Add defaulted `recent_events` to `WorkGraphSummary`. Each `WorkGraphEventSummary` contains numeric sequence, optional validated task ID, allowlisted/fixed event type, and numeric `created_at_ms` only. Reduce the already ordered events to the most recent 50, retain ascending sequence in the response, retain total `event_count`, and render `Recent history N of total`. Never serialize or log `payload_json`.

  Implement exactly the global projection: bounded control-free graph/task display labels; validated identifiers; enum-derived statuses/kinds; `error: None`, `evidence: []`, `failure_reason: None`; and optional result JSON containing only the seven numeric count fields. Missing arrays count as zero; a present non-object result or a present counted field with the wrong type fails the whole request with `Work graph data unavailable`. Do not include summaries, changed-file names, check/evidence/risk prose, instructions, raw payload, prompt/follow-up text, or arbitrary error detail. Do not change production graph-list SQL.

- [ ] **Step 5: Render Work graph as a mode of the same view.**

  Header is always Experimental · read-only. Show disabled, loading/refreshing, empty, safe error, and loaded states; r refreshes; 1/2 switch Agents/Work graph. Render assigned worker identity only from each sanitized task's validated canonical `assigned_thread_id`, with fixed `Assigned worker · read-only` copy and no agent mutation keys; never query or render its `SubAgent::Other` source. Do not add execute, cancel, retry, authoring, or dashboard controls. Remove the old blocking work_graph_list TUI method/imports and use Task B3's background request path. Apply results only for the active epoch/root, WorkGraph mode, and latest graph request ID.

- [ ] **Step 6: Commit the independently reviewed graph view.**

  Deferred commit:

  ~~~bash
  git add codex-rs/features/src/lib.rs codex-rs/features/src/tests.rs codex-rs/app-server-protocol/src/protocol/v2/work_graph.rs codex-rs/app-server-protocol/src/protocol/v2/tests.rs codex-rs/app-server/src/request_processors/thread_processor.rs codex-rs/app-server/src/request_processors/thread_processor_tests.rs codex-rs/state/src/runtime/work_graphs.rs codex-rs/tui/src/chatwidget/settings_popups.rs codex-rs/tui/src/chatwidget/tests/popups_and_settings.rs codex-rs/tui/src/app.rs codex-rs/tui/src/app_event.rs codex-rs/tui/src/app/background_requests.rs codex-rs/tui/src/app/event_dispatch.rs codex-rs/tui/src/app/session_lifecycle.rs codex-rs/tui/src/app_server_session.rs codex-rs/tui/src/app/tests.rs codex-rs/tui/src/multi_agents.rs codex-rs/tui/src/bottom_pane/agent_view.rs
  git commit -m "feat: inspect work graphs from agent view"
  ~~~

### Task B5: Route verification, update docs, and hold the review gate

**Files:**

- Modify: tools/verify-elpis/surfaces.toml
- Modify: tests/verify-elpis/test_verify_elpis.sh
- Modify: docs/WORK_GRAPHS.md
- Modify: docs/GUIDE.md
- Modify: this plan only for evidence corrections

**Consumes:** Tasks B1–B4 plus Plan A's already-integrated verifier/path ownership. Do not start B5 before the Plan A verifier changes exist in the branch.

**Produces:** Stable, nonzero repository-selected checks and truthful documentation; no release or manual-acceptance claim.

- [ ] **Step 1: Add locked nonzero verification filters.**

  Add protocol agent_status_ and agent_control_, core agent_status_bridge_ and agent_control_bridge_, state work_graph_worker_ownership_, app-server agent_status_ and agent_control_, app-server work_graph_list_, features work_graph_inspector_, TUI agent_view_, and TUI work_graph_view_. Route them through agents-work-graph and, where already required, app-server/full surfaces. Retain the existing core/state work-graph checks.

- [ ] **Step 2: Extend first-match path ownership without losing Plan A unions.**

  Add narrow first-match rules only for the new leaf `protocol/v2/agent_control.rs` and the Work graph leaf, routing them to agents-work-graph + app-server. Keep `protocol/common.rs`, `protocol/v2/mod.rs`, shared `protocol/v2/tests.rs`, `thread_manager.rs`, and `thread_manager_tests.rs` in path unions that still include `full`; do not replace their current broad/fallback full coverage with a narrow rule. Keep shared agent-control close/resume files full for the same reason. Route state Work graph files to agents-work-graph; app-server processor/dispatch/tests to agents-work-graph + app-server; feature registry/tests to agents-work-graph + context-compaction; and the named Agent/App/bottom-pane/settings TUI files to agents-work-graph + tui. Merge overlaps with Plan A path unions. Manifest/test changes still force full.

- [ ] **Step 3: Prove the selector using only the fake-Cargo harness.**

  Assert exact argv for every command—including both `agent_status_` protocol/app-server filters and `agent_status_bridge_` core filter—every representative path union, mixed-signature/full fallback, manifest/test-script fallback to full, and zero-pass rejection. Run only these non-Rust checks now; the harness supplies fake Cargo and verifies the throttle environment rather than compiling:

  ~~~bash
  bash -n scripts/verify-elpis tests/verify-elpis/test_verify_elpis.sh
  shellcheck scripts/verify-elpis tests/verify-elpis/test_verify_elpis.sh
  bash tests/verify-elpis/test_verify_elpis.sh
  ~~~

- [ ] **Step 4: Replace obsolete documentation.**

  Replace the claim that /agent appends snapshot/history cells with the immediate Agents view, default-off experimental/read-only graph mode, sanitized recent history, and graph-worker control rejection. State that it exposes only bounded display labels, validated identifiers/statuses, numeric counts, and allowlisted event metadata—not prompt, instruction, report, evidence, error, payload, follow-up, or message-body prose—and that it does not enable fanout, author graphs, or provide atomic graph-task cancellation.

- [ ] **Step 5: Independent review and later execution gate.**

  Obtain independent source review for each implementation task and one final cross-slice privacy/authority/lifecycle review. Only after every broader functional slice closes, inspect the selected shared target as required by `docs/LOCAL_BUILD_RULES.md`, then let the coordinator run exactly these repository-selected, throttled Rust gates from the repository root:

  ~~~bash
  elpis_shared_target="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/codex-rs/target"
  du -sh "$elpis_shared_target"
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 nice -n 10 scripts/verify-elpis --surface agents-work-graph
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 nice -n 10 scripts/verify-elpis --surface full
  ~~~

  The selector itself supplies `CODEX_SKIP_BWRAP_BUILD=1`, `CARGO_TARGET_DIR`, and `nice -n 10` to every Cargo child. Do not install, release, or claim manual acceptance.

- [ ] **Step 6: Commit verifier/docs after evidence is truthful.**

  Deferred commit:

  ~~~bash
  git add tools/verify-elpis/surfaces.toml tests/verify-elpis/test_verify_elpis.sh docs/WORK_GRAPHS.md docs/GUIDE.md docs/superpowers/plans/2026-08-31-elpis-memory-agents-work-graph.md
  git commit -m "docs: verify agent and work graph controls"
  ~~~

## Plan B acceptance checklist

- `/agent` remains the only command and preserves transcript switching/Alt navigation.
- An ordinary selected child receives only server-advertised actions after root/lineage/edge/status validation and, for interrupt/close, a target-named confirmation; Open-unloaded, Closed-unloaded, and live-only agents are never conflated.
- The coordinator, fake/other-subagent root, persisted/live-lineage conflict, unrelated/stale target, and invalid statuses cannot be controlled; duplicate actions coalesce without freezing the TUI, and stale confirmations send no request.
- Applied bridge close leaves the target plus its whole live ThreadSpawn subtree—including descendants behind unloaded persisted intermediates—terminal and its edge durably Closed; retries repair leaked descendants, while unrelated model-tool live-only close remains functional. Applied resume never reuses a loaded dead session, returns a fresh nonterminal target status, and has its durable Open edge postcondition; injected shutdown or edge-store failure is compensated and never reported as Applied.
- Graph-owned workers are visibly rejected in this read-only candidate, and the rejection leaves their task plus descendants transition-identical.
- Work graph inspection is off by default, labelled experimental/read-only, uses the newest graph for the active root, supports safe refresh, and correctly distinguishes disabled, valid-empty, storage-unavailable, loading, stale/error, and loaded states.
- Control responses contain no free text; only the target conversation receives a successful follow-up, and graph inspection exposes bounded labels, identifiers/statuses/counts, and allowlisted event metadata rather than report/error/payload prose.
- No graph authoring, generic swarm, automatic worktree/branch integration, or dashboard surface is added.

## Deferred integration gate

After code review of each task and only after the broader daily-driver functional issues are closed, use the repository-owned verification manifest’s memory and agents-work-graph surfaces plus its conservative full Linux surface. Follow `docs/LOCAL_BUILD_RULES.md` first, including target-disk inspection. Do not claim either plan complete from this draft or from unexecuted commands; Masih’s manual acceptance of the TUI workflows remains the final gate.
