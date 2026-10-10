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
use ratatui::style::Color;
use tempfile::tempdir;

const WIDTH: u16 = 150;
const LEDGER_THREAD: &str = "019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e10";

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
    let workspace = crate::legacy_core::elpis_context::thread_context_dir(
        Some(&memories),
        &cwd,
        LEDGER_THREAD,
    )?
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
    let thread_id = ThreadId::from_string(LEDGER_THREAD)?;
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
        Some(&target.view.displayed_thread_id.to_string()),
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

#[tokio::test]
async fn source_headings_and_included_markers_use_deus_ex_gold() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    configure_ledger_sources(&mut chat, root.path())?;
    for (bg, gold) in [
        ((255, 255, 255), Color::Rgb(128, 88, 10)),
        ((24, 24, 24), Color::Rgb(229, 187, 104)),
    ] {
        crate::terminal_palette::with_test_default_colors(
            crate::terminal_probe::DefaultColors {
                fg: (32, 32, 32),
                bg,
            },
            || {
                let width = chat.context_ledger_width(WIDTH);
                let area = Rect::new(0, 0, width, chat.context_ledger_desired_height(width));
                let mut buf = ratatui::buffer::Buffer::empty(area);
                chat.render_context_ledger(area, &mut buf);
                let text = rows(&buf, 0..width);
                for label in [
                    "SESSION CONTINUITY",
                    "DURABLE MEMORY",
                    "INSTRUCTIONS",
                    "INCLUDED",
                ] {
                    let (y, line) = text
                        .iter()
                        .enumerate()
                        .find(|(_, line)| line.contains(label))
                        .unwrap_or_else(|| panic!("missing {label}"));
                    let x = line
                        .chars()
                        .collect::<Vec<_>>()
                        .windows(label.len())
                        .position(|chars| chars.iter().collect::<String>() == label)
                        .unwrap();
                    assert_eq!(buf[(x as u16, y as u16)].fg, gold, "{label}");
                }
                assert_ne!(Some(gold), crate::style::context_style().fg);
            },
        );
    }
    Ok(())
}

/// The ledger's top row is the composer box's top row, and its last line is on screen.
fn assert_ledger_beside_composer(chat: &ChatWidget, buf: &ratatui::buffer::Buffer) {
    let ledger_width = chat.context_ledger_width(WIDTH);
    assert!(ledger_width > 0, "the ledger is hidden");
    let left = rows(buf, 0..WIDTH - ledger_width);
    let right = rows(buf, WIDTH - ledger_width..WIDTH);
    let composer_row = left
        .iter()
        .position(|row| row.contains("›"))
        .expect("the native composer remains beside the Ledger");
    let ledger_top = right
        .iter()
        .position(|row| row.contains("CONTEXT LEDGER"))
        .expect("the ledger is drawn beside the composer");
    assert!(
        ledger_top <= composer_row,
        "Ledger starts below the composer"
    );
    assert!(
        !left.iter().any(|row| row.contains("· location")),
        "custom identity row returned"
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
    show_context_ledger(&mut chat);
    configure_ledger_sources(&mut chat, root.path())?;

    // Inline screen.
    let inline = render_full(&chat.as_renderable());
    assert_ledger_beside_composer(&chat, &inline);

    // Fullscreen (owned) screen.
    let owned = chat.bottom_pane_renderable(crate::bottom_pane::ComposerRenderOptions {
        command_popup_placement: crate::bottom_pane::CommandPopupPlacement::Overlay,
        ..Default::default()
    });
    assert_ledger_beside_composer(&chat, &render_full(&owned));
    Ok(())
}

#[tokio::test]
async fn hidden_ledger_gives_the_composer_the_full_width() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    configure_ledger_sources(&mut chat, root.path())?;
    // Alt+C focuses the Ledger first, then hides it.
    for _ in 0..2 {
        chat.handle_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT));
    }

    assert_eq!(chat.context_ledger_width(WIDTH), 0);
    let buf = render_full(&chat.as_renderable());
    let screen = rows(&buf, 0..WIDTH).join("\n");
    assert!(!screen.contains("CONTEXT LEDGER"), "{screen}");
    assert!(
        !screen.contains('│'),
        "a Ledger rule is left behind\n{screen}"
    );
    assert!(
        screen.contains('›'),
        "the native composer is missing\n{screen}"
    );
    Ok(())
}

#[tokio::test]
async fn ledger_rule_runs_down_beside_the_native_composer() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    configure_ledger_sources(&mut chat, root.path())?;
    let buf = render_full(&chat.as_renderable());
    let screen = rows(&buf, 0..WIDTH).join("\n");
    let ledger_width = chat.context_ledger_width(WIDTH);
    let rule_x = WIDTH - ledger_width;

    // The native composer draws no box, so the Ledger's left rule is a plain line. It starts on
    // the Ledger's first row, below the blank row Codex leaves above the composer.
    let ledger_top = rows(&buf, rule_x + 1..WIDTH)
        .iter()
        .position(|row| row.contains("CONTEXT LEDGER"))
        .expect("the Ledger is drawn") as u16;
    for y in ledger_top..ledger_top + chat.context_ledger_desired_height(ledger_width) {
        assert_eq!(buf[(rule_x, y)].symbol(), "│", "row {y}\n{screen}");
    }
    if let Some(above) = ledger_top.checked_sub(1) {
        assert_eq!(
            buf[(rule_x, above)].symbol(),
            " ",
            "the rule extends above the Ledger\n{screen}"
        );
    }
    assert!(
        !screen.contains(['┌', '└', '┐', '┘', '┤']),
        "composer box returned\n{screen}"
    );
    Ok(())
}

#[tokio::test]
async fn ledger_keeps_codex_right_margin_and_measures_wide_names() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    configure_ledger_sources(&mut chat, root.path())?;
    // Each of these characters takes two columns, so a count of characters is half the width.
    let wide = root
        .path()
        .join("数据数据数据数据数据数据数据数据数据数据数据数据.md");
    std::fs::write(&wide, "Wide name")?;
    submit(&mut chat, &format!("/add {}", wide.display()));
    seed_ledger_from_disk(&mut chat)?;

    let buf = render_full(&chat.as_renderable());
    let screen = rows(&buf, 0..WIDTH).join("\n");
    // Codex keeps its last two columns free (`FOOTER_INDENT_COLS`); so does the Ledger.
    for row in rows(&buf, WIDTH - 2..WIDTH) {
        assert_eq!(
            row.trim(),
            "",
            "the Ledger wrote into Codex's right margin\n{screen}"
        );
    }
    let ledger_width = chat.context_ledger_width(WIDTH);
    let source_rows = rows(&buf, WIDTH - ledger_width..WIDTH)
        .into_iter()
        .filter(|row| row.contains("est. tokens"))
        .collect::<Vec<_>>();
    assert!(source_rows.len() >= 6, "{screen}");
    for row in &source_rows {
        let row = row.trim_end();
        assert!(
            row.ends_with("INCLUDED") || row.ends_with("EXCLUDED"),
            "a source row lost its state word: {row:?}\n{screen}"
        );
    }
    assert!(
        // A wide character's second cell reads as a space here.
        source_rows
            .iter()
            .any(|row| row.replace(' ', "").contains("…据数据")),
        "the wide name is shortened from the left\n{screen}"
    );
    Ok(())
}

#[tokio::test]
async fn ledger_shortcuts_focus_and_hide_without_touching_the_draft() {
    for key in [
        KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT),
        KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL),
    ] {
        let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
        show_context_ledger(&mut chat);
        chat.last_rendered_width.set(Some(WIDTH));
        chat.bottom_pane
            .set_composer_text("Keep this draft".into(), Vec::new(), Vec::new());
        assert!(chat.context_ledger_width(WIDTH) > 0, "visible by default");

        chat.handle_key_event(key);
        assert!(chat.context_ledger_has_focus());
        let area = Rect::new(0, 0, WIDTH, 40);
        assert_eq!(chat.as_renderable().cursor_pos(area), None);

        chat.handle_key_event(key);
        assert_eq!(chat.context_ledger_width(WIDTH), 0);
        chat.handle_key_event(key);
        assert!(chat.context_ledger_width(WIDTH) > 0);

        assert_eq!(chat.bottom_pane.composer_text(), "Keep this draft");
        assert!(op_rx.try_recv().is_err(), "nothing was submitted");
    }
}

#[tokio::test]
async fn ctrl_x_preserves_custom_editor_binding_after_live_keymap_update() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
    let config = toml::from_str("[editor]\nkill_line_end = 'ctrl-x'").unwrap();
    let runtime = crate::keymap::RuntimeKeymap::from_config(&config).unwrap();
    chat.apply_keymap_update(config, &runtime);
    chat.bottom_pane
        .set_composer_text("Cut this draft".into(), Vec::new(), Vec::new());
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL));
    assert_eq!(chat.bottom_pane.composer_text(), "");
    assert!(!chat.context_ledger_has_focus());
    assert!(op_rx.try_recv().is_err());
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT));
    assert!(chat.context_ledger_has_focus(), "Alt+C remains available");
}

#[tokio::test]
async fn ctrl_x_preserves_custom_vim_search_after_live_keymap_update() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
    let config =
        toml::from_str("[chat]\ntoggle_voice_mute = []\n[vim_search]\nforward = 'ctrl-x'").unwrap();
    let runtime = crate::keymap::RuntimeKeymap::from_config(&config).unwrap();
    chat.apply_keymap_update(config, &runtime);
    chat.toggle_vim_mode_and_notify();
    chat.bottom_pane
        .set_composer_text("Find this draft".into(), Vec::new(), Vec::new());
    chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
    assert!(chat.bottom_pane.no_modal_or_popup_active());
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL));
    assert!(
        !chat.bottom_pane.no_modal_or_popup_active(),
        "Vim search must open"
    );
    assert!(!chat.context_ledger_has_focus());
    assert_eq!(chat.bottom_pane.composer_text(), "Find this draft");
    assert!(op_rx.try_recv().is_err());
}

#[tokio::test]
async fn ctrl_x_leaves_menus_and_completions_in_control() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
    chat.dispatch_command(SlashCommand::Feedback);
    let before = render_bottom_popup(&chat, 80);
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL));
    assert_eq!(render_bottom_popup(&chat, 80), before);
    assert!(!chat.context_ledger_has_focus());
    chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
    chat.bottom_pane
        .set_composer_text("/com".into(), Vec::new(), Vec::new());
    chat.bottom_pane.pre_draw_tick();
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL));
    assert!(!chat.context_ledger_has_focus());
    assert_eq!(chat.bottom_pane.composer_text(), "/com");
    chat.handle_key_event(KeyEvent::from(KeyCode::Tab));
    assert_eq!(chat.bottom_pane.composer_text(), "/compact ");
    assert!(op_rx.try_recv().is_err());
}

#[tokio::test]
async fn plain_x_and_repeated_ctrl_x_do_not_toggle_the_ledger() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
    for kind in [KeyEventKind::Repeat, KeyEventKind::Release] {
        chat.handle_key_event(KeyEvent::new_with_kind(
            KeyCode::Char('x'),
            KeyModifiers::CONTROL,
            kind,
        ));
        assert!(!chat.context_ledger_has_focus());
    }
    chat.handle_key_event(KeyEvent::from(KeyCode::Char('x')));
    assert!(!chat.context_ledger_has_focus());
    // A normal non-character key flushes the composer's held first character.
    chat.handle_key_event(KeyEvent::from(KeyCode::Right));
    assert_eq!(chat.composer_text_with_pending(), "x");
    assert!(!chat.context_ledger_has_focus());
    assert!(op_rx.try_recv().is_err());
}

/// Typing, Alt+C, then Backspace: Backspace must edit the draft, not act on a
/// Ledger row. Only Tab, arrows and the Ledger's own keys belong to the panel.
#[tokio::test]
async fn backspace_in_the_focused_ledger_edits_the_draft() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    configure_ledger_sources(&mut chat, root.path())?;
    chat.bottom_pane
        .set_composer_text("Keep this draft".into(), Vec::new(), Vec::new());
    let ledger_before = ledger_alone(&chat);

    chat.handle_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT));
    assert!(chat.context_ledger_has_focus());
    chat.handle_key_event(KeyEvent::from(KeyCode::Backspace));
    chat.handle_key_event(KeyEvent::from(KeyCode::Backspace));

    assert_eq!(chat.bottom_pane.composer_text(), "Keep this dra");
    assert!(
        !chat.context_ledger_has_focus(),
        "typing returns to the composer"
    );
    assert_eq!(ledger_alone(&chat), ledger_before, "no Ledger row changed");
    assert!(op_rx.try_recv().is_err(), "nothing was submitted");
    Ok(())
}

#[tokio::test]
async fn tab_completes_a_slash_command_before_touching_the_ledger() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
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
    show_context_ledger(&mut chat);
    configure_ledger_sources(&mut chat, root.path())?;
    let before = row_state(&chat, "ES.md");

    chat.handle_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT));
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
    show_context_ledger(&mut chat);
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
    show_context_ledger(&mut chat);
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
    show_context_ledger(&mut chat);
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
    show_context_ledger(&mut chat);
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
    show_context_ledger(&mut chat);

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
    show_context_ledger(&mut chat);
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

#[tokio::test]
async fn smart_prune_row_says_what_it_does_on_claude_and_antigravity_chats() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    chat.last_rendered_width.set(Some(WIDTH));
    chat.smart_prune_synced = true;
    chat.smart_prune.enabled = true;

    // Negative: a GPT chat keeps the usual Smart Prune line.
    let ledger = ledger_words(&chat);
    assert!(ledger.contains("Before first main-model send"), "{ledger}");
    assert!(
        !ledger.contains("Does not apply to Claude or Antigravity chats"),
        "{ledger}"
    );

    // A Claude chat's tool results shrink in the bridge's Claude proxy while the switch is on.
    chat.set_model("claude/opus");
    let ledger = ledger_words(&chat);
    assert!(ledger.contains("through the Claude proxy"), "{ledger}");
    assert!(!ledger.contains("Does not apply"), "{ledger}");

    // An Antigravity chat's requests go to Google: the switch skips them.
    chat.set_model("agy/gemini-3.8-flash-high");
    let ledger = ledger_words(&chat);
    assert!(
        ledger.contains("Does not apply to Antigravity chats"),
        "{ledger}"
    );
    assert!(!ledger.contains("Before first main-model send"), "{ledger}");
}

/// One `thread/tokenUsage/updated`, as the app server sends it after a sampled response.
fn token_usage_update(
    chat: &mut ChatWidget,
    context_attribution: Option<codex_app_server_protocol::ThreadContextAttribution>,
) {
    let breakdown = codex_app_server_protocol::TokenUsageBreakdown {
        total_tokens: 1_000,
        input_tokens: 900,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 100,
        reasoning_output_tokens: 0,
    };
    chat.handle_server_notification(
        ServerNotification::ThreadTokenUsageUpdated(
            codex_app_server_protocol::ThreadTokenUsageUpdatedNotification {
                thread_id: "thread-1".to_string(),
                turn_id: "turn-1".to_string(),
                token_usage: codex_app_server_protocol::ThreadTokenUsage {
                    total: breakdown.clone(),
                    last: breakdown,
                    model_context_window: Some(258_400),
                    context_attribution,
                },
            },
        ),
        /*replay_kind*/ None,
    );
}

/// The ledger's words in reading order, without its left border or line wrapping.
fn ledger_words(chat: &ChatWidget) -> String {
    ledger_alone(chat)
        .iter()
        .map(|row| row.chars().skip(1).collect::<String>())
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn planted_attribution() -> codex_app_server_protocol::ThreadContextAttribution {
    codex_app_server_protocol::ThreadContextAttribution {
        system_instructions: 560,
        developer_messages: 141,
        user_messages: 41,
        agent_messages: 6,
        tool_definitions: 252,
        estimated_total: 1_000,
        ..Default::default()
    }
}

#[tokio::test]
async fn context_window_shows_category_shares_once_the_server_sends_them() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    chat.last_rendered_width.set(Some(WIDTH));

    token_usage_update(&mut chat, Some(planted_attribution()));

    let ledger = ledger_words(&chat);
    for category in ["User messages", "Agent messages", "System instructions"] {
        assert!(ledger.contains(category), "missing {category}:\n{ledger}");
    }
    assert!(
        !ledger.contains("category attribution unavailable"),
        "{ledger}"
    );

    // A later update without shares (a replay) keeps the last known ones.
    token_usage_update(&mut chat, /*context_attribution*/ None);
    let ledger = ledger_words(&chat);
    assert!(ledger.contains("User messages"), "{ledger}");
}

#[tokio::test]
async fn context_window_says_attribution_is_unavailable_until_shares_arrive() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    chat.last_rendered_width.set(Some(WIDTH));

    token_usage_update(&mut chat, /*context_attribution*/ None);

    let ledger = ledger_words(&chat);
    assert!(
        ledger.contains("category attribution unavailable"),
        "{ledger}"
    );
    assert!(!ledger.contains("User messages"), "{ledger}");
}
