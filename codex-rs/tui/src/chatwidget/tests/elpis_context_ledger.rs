//! Evals for the Context Ledger on the new base: where it sits, the keys that drive it, and the
//! `/add` and `/context` commands.
//!
//! Each behaviour has a positive case and a negative case.

use super::*;
use crate::elpis_app_event::ElpisAppEvent;
use crate::elpis_ledger_events::ManualMemoryRequestTarget;
use crate::elpis_ledger_events::ManualMemoryStatusCompletion;
use crate::elpis_ledger_events::ManualMemoryStorageTarget;
use crate::elpis_ledger_events::ManualMemoryViewKey;
use crate::render::renderable::Renderable;
use pretty_assertions::assert_eq;
use tempfile::tempdir;

const WIDTH: u16 = 150;

/// Point the widget at a temporary Elpis home and project holding every kind of ledger source,
/// then load the rows the way the App's loader does.
fn configure_ledger_sources(
    chat: &mut ChatWidget,
    root: &std::path::Path,
) -> anyhow::Result<(PathBuf, PathBuf)> {
    let home = root.join(".elpis-next");
    let memories = home.join("memories");
    let cwd = root.join("project");
    let global = root.join("global/AGENTS.md");
    let workspace = crate::legacy_core::elpis_context::workspace_context_dir(Some(&memories), &cwd)
        .expect("workspace path");
    std::fs::create_dir_all(global.parent().expect("global parent"))?;
    std::fs::create_dir_all(&cwd)?;
    std::fs::create_dir_all(&workspace)?;
    std::fs::create_dir_all(&memories)?;
    std::fs::write(&global, "Global instructions")?;
    std::fs::write(cwd.join("AGENTS.md"), "Project instructions")?;
    std::fs::write(workspace.join("GOAL.md"), "Ship the grouped ledger")?;
    std::fs::write(workspace.join("ES.md"), "Command evidence")?;
    std::fs::write(memories.join("MEMORY.md"), "Durable memory")?;

    chat.config.codex_home = AbsolutePathBuf::from_absolute_path(&home)?;
    chat.config.cwd = AbsolutePathBuf::from_absolute_path(&cwd)?;
    chat.instruction_source_paths = vec![
        codex_utils_path_uri::PathUri::from_abs_path(&AbsolutePathBuf::from_absolute_path(
            &global,
        )?),
        codex_utils_path_uri::PathUri::from_abs_path(&AbsolutePathBuf::from_absolute_path(
            cwd.join("AGENTS.md"),
        )?),
    ];
    chat.last_rendered_width.set(Some(WIDTH));
    seed_ledger_from_disk(chat)?;
    Ok((memories, cwd))
}

/// Load the ledger's rows from disk, as `App::load_manual_memory_status` does.
fn seed_ledger_from_disk(chat: &mut ChatWidget) -> anyhow::Result<ManualMemoryRequestTarget> {
    let memories = elpis_memory_dir(chat.config_ref());
    let cwd = chat.config_ref().cwd.to_path_buf();
    let (admission_path, memory_path) =
        crate::legacy_core::elpis_context::manual_memory_storage_paths(Some(&memories), &cwd)
            .ok_or_else(|| anyhow::anyhow!("ledger storage is unavailable"))?;
    let thread_id = ThreadId::new();
    let target = ManualMemoryRequestTarget {
        view: ManualMemoryViewKey {
            epoch: chat
                .manual_memory_bound_target()
                .map_or(1, |target| target.view.epoch.saturating_add(1)),
            primary_root_thread_id: thread_id,
            displayed_thread_id: thread_id,
            cwd: cwd.clone(),
            memory_path: memory_path.clone(),
        },
        storage: ManualMemoryStorageTarget {
            admission_path,
            memory_path,
        },
    };
    let status = crate::legacy_core::elpis_context::manual_memory_status(Some(&memories), &cwd)?
        .ok_or_else(|| anyhow::anyhow!("ledger status is unavailable"))?;
    let sources = crate::legacy_core::elpis_context::continuity_sources_from_manual_memory_status(
        Some(&memories),
        &cwd,
        &chat.instruction_source_paths_as_path_bufs(),
        /*dev_rule_roots*/ &[],
        Some(&status),
    )?;
    chat.bind_manual_memory_loading(
        target.clone(),
        /*pending_context_report*/ false,
        /*pending_mutation*/ None,
    );
    anyhow::ensure!(
        chat.apply_manual_memory_status_completion(
            &target,
            ManualMemoryStatusCompletion::Ready { status, sources },
        ),
        "the ledger rejected its own target"
    );
    Ok(target)
}

fn rows(buf: &ratatui::buffer::Buffer, columns: std::ops::Range<u16>) -> Vec<String> {
    (0..buf.area.height)
        .map(|y| {
            columns
                .clone()
                .map(|x| crate::terminal_hyperlinks::strip_osc8(buf[(x, y)].symbol()))
                .collect::<String>()
        })
        .collect()
}

fn render_full(renderable: &dyn Renderable) -> ratatui::buffer::Buffer {
    let height = renderable.desired_height(WIDTH);
    let area = Rect::new(0, 0, WIDTH, height);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    renderable.render(area, &mut buf);
    buf
}

/// The standalone ledger, drawn tall enough that nothing is cut.
fn ledger_alone(chat: &ChatWidget) -> Vec<String> {
    let width = chat.context_ledger_width(WIDTH);
    let height = chat.context_ledger_desired_height(width);
    let area = Rect::new(0, 0, width, height);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    chat.render_context_ledger(area, &mut buf);
    rows(&buf, 0..width)
}

/// The ledger's top row is the composer box's top row, and its last line is on screen.
fn assert_ledger_beside_composer(chat: &ChatWidget, buf: &ratatui::buffer::Buffer) {
    let ledger_width = chat.context_ledger_width(WIDTH);
    assert!(ledger_width > 0, "the ledger is hidden");
    let left = rows(buf, 0..WIDTH - ledger_width);
    let right = rows(buf, WIDTH - ledger_width..WIDTH);
    let identity_row = left
        .iter()
        .position(|row| row.contains("· location"))
        .expect("the identity line sits directly above the composer");
    let ledger_top = right
        .iter()
        .position(|row| row.contains("CONTEXT LEDGER"))
        .expect("the ledger is drawn beside the composer");
    assert_eq!(
        ledger_top,
        identity_row + 1,
        "the ledger must start on the composer box's top row\n{}",
        rows(buf, 0..WIDTH).join("\n")
    );
    let last = ledger_alone(chat)
        .into_iter()
        .rev()
        .find(|row| !row.trim().is_empty())
        .expect("the ledger has content");
    assert!(
        right.iter().any(|row| row.trim_end() == last.trim_end()),
        "the ledger was trimmed; its last line is missing: {last:?}\n{}",
        rows(buf, 0..WIDTH).join("\n")
    );
}

#[tokio::test]
async fn ledger_top_aligns_with_the_composer_and_runs_down_untrimmed() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;

    // Inline screen.
    let inline = render_full(&chat.as_renderable());
    assert_ledger_beside_composer(&chat, &inline);

    // Fullscreen (owned) screen.
    let owned = chat.bottom_pane_renderable(
        /*footer*/ None,
        crate::bottom_pane::CommandPopupPlacement::Overlay,
        /*composer_gap*/ None,
        /*working_tip*/ None,
    );
    assert_ledger_beside_composer(&chat, &render_full(&owned));
    Ok(())
}

#[tokio::test]
async fn hidden_ledger_gives_the_composer_the_full_width() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT));

    assert_eq!(chat.context_ledger_width(WIDTH), 0);
    let buf = render_full(&chat.as_renderable());
    let screen = rows(&buf, 0..WIDTH).join("\n");
    assert!(!screen.contains("CONTEXT LEDGER"), "{screen}");
    Ok(())
}

#[tokio::test]
async fn tab_focuses_the_ledger_and_alt_c_hides_it_without_touching_the_draft() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
    chat.last_rendered_width.set(Some(WIDTH));
    chat.bottom_pane
        .set_composer_text("Keep this draft".into(), Vec::new(), Vec::new());
    assert!(chat.context_ledger_width(WIDTH) > 0, "visible by default");

    chat.handle_key_event(KeyEvent::from(KeyCode::Tab));
    assert!(chat.context_ledger_has_focus());
    let area = Rect::new(0, 0, WIDTH, 40);
    assert_eq!(chat.as_renderable().cursor_pos(area), None);

    chat.handle_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT));
    assert_eq!(chat.context_ledger_width(WIDTH), 0);
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT));
    assert!(chat.context_ledger_width(WIDTH) > 0);

    assert_eq!(chat.bottom_pane.composer_text(), "Keep this draft");
    assert!(op_rx.try_recv().is_err(), "nothing was submitted");
}

#[tokio::test]
async fn tab_completes_a_slash_command_before_touching_the_ledger() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
    chat.last_rendered_width.set(Some(WIDTH));
    chat.bottom_pane
        .set_composer_text("/com".into(), Vec::new(), Vec::new());
    chat.bottom_pane.pre_draw_tick();

    chat.handle_key_event(KeyEvent::from(KeyCode::Tab));

    assert_eq!(chat.bottom_pane.composer_text(), "/compact ");
    assert!(!chat.context_ledger_has_focus());
    assert!(op_rx.try_recv().is_err());
}

fn row_state(chat: &ChatWidget, name: &str) -> String {
    ledger_alone(chat)
        .into_iter()
        .find(|row| row.contains(name))
        .unwrap_or_else(|| panic!("no ledger row for {name}"))
}

#[tokio::test]
async fn space_on_a_focused_row_writes_its_admission() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;
    let before = row_state(&chat, "ES.md");

    chat.handle_key_event(KeyEvent::from(KeyCode::Tab));
    for _ in 0..16 {
        if chat
            .selected_continuity_source()
            .is_some_and(|source| source.name == "ES.md")
        {
            break;
        }
        chat.handle_key_event(KeyEvent::from(KeyCode::Down));
    }
    chat.handle_key_event(KeyEvent::from(KeyCode::Char(' ')));
    seed_ledger_from_disk(&mut chat)?;

    let after = row_state(&chat, "ES.md");
    assert_ne!(before, after, "the admission did not change on disk");
    assert!(
        before.contains("INCLUDED") && after.contains("EXCLUDED")
            || before.contains("EXCLUDED") && after.contains("INCLUDED"),
        "{before:?} -> {after:?}"
    );
    Ok(())
}

#[tokio::test]
async fn space_with_the_ledger_unfocused_leaves_admissions_alone() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;
    let before = row_state(&chat, "ES.md");

    chat.handle_key_event(KeyEvent::from(KeyCode::Char(' ')));
    seed_ledger_from_disk(&mut chat)?;

    assert!(!chat.context_ledger_has_focus());
    assert_eq!(row_state(&chat, "ES.md"), before);
    Ok(())
}

fn submit(chat: &mut ChatWidget, text: &str) {
    chat.bottom_pane
        .set_composer_text(text.to_string(), Vec::new(), Vec::new());
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
}

#[tokio::test]
async fn add_puts_a_file_under_user_files() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;
    let notes = root.path().join("user-notes.md");
    std::fs::write(&notes, "Manually selected context")?;

    submit(&mut chat, &format!("/add {}", notes.display()));
    seed_ledger_from_disk(&mut chat)?;

    let ledger = ledger_alone(&chat).join("\n");
    assert!(ledger.contains("USER FILES"), "{ledger}");
    assert!(ledger.contains("user-notes.md"), "{ledger}");
    let history = drain_insert_history(&mut rx)
        .iter()
        .map(|lines| lines_to_single_string(lines))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(history.contains("to the Context Ledger"), "{history}");
    Ok(())
}

#[tokio::test]
async fn bare_add_prints_its_usage_and_adds_nothing() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;

    submit(&mut chat, "/add");
    seed_ledger_from_disk(&mut chat)?;

    assert!(!ledger_alone(&chat).join("\n").contains("USER FILES"));
    let history = drain_insert_history(&mut rx)
        .iter()
        .map(|lines| lines_to_single_string(lines))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(history.contains("Usage: /add"), "{history}");
    Ok(())
}

#[tokio::test]
async fn context_asks_the_app_for_the_report_once_the_ledger_is_loaded() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;

    submit(&mut chat, "/context");

    assert!(
        std::iter::from_fn(|| rx.try_recv().ok()).any(|event| matches!(
            event,
            AppEvent::Elpis(ElpisAppEvent::RequestContextUsageReport(_))
        )),
        "/context did not ask the App for the report"
    );
    Ok(())
}

#[tokio::test]
async fn context_before_the_ledger_loads_says_so_and_asks_for_nothing() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;

    submit(&mut chat, "/context");

    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(!events.iter().any(|event| matches!(
        event,
        AppEvent::Elpis(ElpisAppEvent::RequestContextUsageReport(_))
    )));
}

#[tokio::test]
async fn smart_prune_row_syncs_then_shows_the_thread_state_as_in_v030() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.last_rendered_width.set(Some(WIDTH));

    let ledger = ledger_alone(&chat).join("\n");
    assert!(ledger.contains("[···] SYNC"), "{ledger}");
    assert!(ledger.contains("Reading current thread state"), "{ledger}");
    assert!(!ledger.contains("Not in this Elpis build yet"), "{ledger}");

    // Negative: once a thread reports Smart Prune state, the row shows it.
    chat.smart_prune_synced = true;
    chat.smart_prune.enabled = true;
    let ledger = ledger_alone(&chat).join("\n");
    assert!(ledger.contains("[━━━●] ON"), "{ledger}");
    assert!(!ledger.contains("SYNC"), "{ledger}");
}
