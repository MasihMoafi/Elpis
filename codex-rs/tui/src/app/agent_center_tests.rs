//! Dashboard rows, paging, metadata clipping and status-filter regressions.

use super::*;
use assert_matches::assert_matches;
use pretty_assertions::assert_eq;

fn screen(view: &AgentsOverviewView, width: u16, height: u16) -> String {
    let area = Rect::new(/*x*/ 0, /*y*/ 0, width, height);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    view.render(area, &mut buf);
    crate::chatwidget::tests::helpers::normalize_agent_center_snapshot(
        buf.content
            .chunks(usize::from(width))
            .map(|row| {
                row.iter()
                    .map(ratatui::buffer::Cell::symbol)
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

#[tokio::test]
async fn live_center_columns() {
    let mut app = make_test_app().await;
    let current = ThreadId::from_u128(/*value*/ 42);
    app.primary_thread_id = Some(current);
    let now = chrono::Utc::now().timestamp();
    let fixtures = [
        ("Current task", ThreadStatus::Idle, -3600),
        (
            "A longer task title that uses the available column",
            ThreadStatus::Idle,
            330,
        ),
        (
            "Needs an answer",
            ThreadStatus::Active {
                active_flags: vec![ThreadActiveFlag::WaitingOnUserInput],
            },
            7230,
        ),
        ("Unloaded task", ThreadStatus::NotLoaded, 172830),
        (
            "Working task",
            ThreadStatus::Active {
                active_flags: Vec::new(),
            },
            86430,
        ),
        ("Failed task", ThreadStatus::SystemError, 3630),
    ];
    let mut threads = fixtures
        .iter()
        .enumerate()
        .map(|(index, (title, status, age))| {
            let mut thread = overview_thread(
                ThreadId::from_u128(index as u128 + 42),
                /*parent_thread_id*/ None,
                title,
                status.clone(),
            );
            thread.updated_at = now - age;
            thread
        })
        .collect::<Vec<_>>();
    let child = ThreadId::from_u128(/*value*/ 48);
    threads.push(overview_thread(
        child,
        Some(ThreadId::from_u128(/*value*/ 43)),
        "Child",
        ThreadStatus::Idle,
    ));
    crate::chatwidget::activate_voice_for_thread(&mut app.chat_widget, child);
    let mut view = app.agents_overview_view(threads, Some(current));
    insta::assert_snapshot!(screen(&view, /*width*/ 160, /*height*/ 22));
    let mut selected_status_styles = Vec::new();
    // Every row, including the nested child.
    for _ in 0..=fixtures.len() {
        let area = Rect::new(
            /*x*/ 0, /*y*/ 0, /*width*/ 160, /*height*/ 22,
        );
        let mut buf = ratatui::buffer::Buffer::empty(area);
        view.render(area, &mut buf);
        let selected_row = buf
            .content
            .chunks(usize::from(area.width))
            .find(|row| row.iter().any(|cell| cell.symbol() == "›"))
            .unwrap();
        let marker = selected_row
            .iter()
            .position(|cell| cell.symbol() == "›")
            .unwrap();
        // Without a model, the agent's dot keeps the selection's colours.
        assert_eq!(
            selected_row[marker + 2].style(),
            selected_row[marker].style()
        );
        let header = buffer_rows(&buf)
            .into_iter()
            .find(|row| row.contains("Updated"))
            .unwrap();
        let status = usize::from(cell_column(&header, "Status").unwrap());
        selected_status_styles.push(format!(
            "{} | {:?}",
            selected_row[status].symbol(),
            selected_row[status].style()
        ));
        view.handle_key_event(KeyCode::Down.into());
    }
    insta::assert_snapshot!(
        "live_center_selected_status_styles",
        selected_status_styles.join("\n")
    );
}

#[tokio::test]
async fn live_center_pages_visible_rows_without_wrapping() {
    for (count, offline) in [(5, false), (30, true)] {
        let app = make_test_app().await;
        let first = ThreadId::from_u128(/*value*/ 100);
        let threads = (0..count)
            .map(|index| {
                let mut thread = overview_thread(
                    ThreadId::from_u128(100 + index),
                    /*parent_thread_id*/ None,
                    &format!("Paging task {index:02}"),
                    ThreadStatus::Idle,
                );
                thread.updated_at -= index as i64;
                if index >= 10 {
                    thread.cwd = test_path_buf("/tmp/second-project").abs();
                }
                thread
            })
            .collect();
        let mut view = app.agents_overview_view(threads, Some(first));
        if offline {
            app.agents_overview
                .view_state
                .lock()
                .unwrap()
                .connection_notice = Some("Reconnecting…");
            view.handle_key_event(KeyCode::Char('f').into());
            view.handle_paste("Paging".into());
        }
        screen(&view, /*width*/ 110, /*height*/ 18);
        view.handle_key_event(KeyCode::PageDown.into());
        // Eleven visible rows: skip the next heading/gap, or clamp a short list.
        assert_eq!(
            view.rows[view.selected_index().unwrap()].thread_id,
            ThreadId::from_u128(100 + (count - 1).min(10)),
        );
        let page_down = view.selected_index().unwrap();
        view.handle_key_event(KeyCode::PageUp.into());
        assert!(view.selected_index().unwrap() < page_down);
        view.handle_key_event(KeyCode::PageUp.into());
        assert_eq!(view.rows[view.selected_index().unwrap()].thread_id, first);
        // Repeated pages eventually reach the last filtered task and stay there.
        for _ in 0..count {
            view.handle_key_event(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::CONTROL));
            screen(&view, /*width*/ 110, /*height*/ 18);
        }
        let last = view.rows[view.selected_index().unwrap()].thread_id;
        view.handle_key_event(KeyCode::PageDown.into());
        assert_eq!(
            (last, view.rows[view.selected_index().unwrap()].thread_id),
            (ThreadId::from_u128(100 + count - 1), last)
        );
        view.handle_key_event(KeyCode::Down.into());
        assert!(
            screen(&view, /*width*/ 110, /*height*/ 18)
                .lines()
                .any(|line| line.trim_start().starts_with("/tmp/project"))
        );
    }
}

#[tokio::test]
async fn live_center_metadata_clips_at_grapheme_boundaries() {
    let app = make_test_app().await;
    let mut view = app.agents_overview_view(
        vec![overview_thread(
            ThreadId::new(),
            /*parent_thread_id*/ None,
            "Retained task",
            ThreadStatus::Idle,
        )],
        /*selected_thread_id*/ None,
    );
    let input = format!("{}日本語 e\u{301} 👩\u{200d}💻", "界".repeat(/*n*/ 100_000));
    for (key, label) in [('r', "Rename › "), ('f', "Search › ")] {
        view.handle_key_event(KeyCode::Char(key).into());
        view.handle_paste(input.clone());
        let rendered = screen(&view, /*width*/ 40, /*height*/ 18);
        let prompt = rendered.lines().find(|line| line.contains(label)).unwrap();
        assert!(prompt.contains("e\u{301}"));
        assert!(prompt.ends_with("👩\u{200d}💻"));
        assert_eq!(
            view.cursor_pos(Rect::new(
                /*x*/ 0, /*y*/ 0, /*width*/ 40, /*height*/ 18
            )),
            Some((36, 3))
        );
        if key == 'r' {
            insta::assert_snapshot!("live_center_narrow_rename", rendered);
        }
        view.handle_key_event(KeyCode::Esc.into());
    }
}

#[tokio::test]
async fn live_center_rename_retains_target_when_status_leaves_filter() -> Result<()> {
    let mut app = make_test_app().await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.app_event_tx = AppEventSender::new(tx);
    let id = ThreadId::new();
    let other = ThreadId::new();
    let mut threads = vec![
        overview_thread(
            id,
            /*parent_thread_id*/ None,
            "Target",
            ThreadStatus::Idle,
        ),
        overview_thread(
            other,
            /*parent_thread_id*/ None,
            "Other",
            ThreadStatus::Idle,
        ),
    ];
    for key in [KeyCode::Esc, KeyCode::Enter] {
        threads[0].status = ThreadStatus::Idle;
        let mut view = app.agents_overview_view(threads.clone(), Some(id));
        // Reuse the Ready tab after the first iteration.
        if key == KeyCode::Esc {
            for _ in 0..3 {
                view.handle_key_event(KeyCode::Tab.into());
            }
        }
        view.handle_key_event(KeyCode::Char('r').into());
        threads[0].status = ThreadStatus::SystemError;
        view = app.agents_overview_view(threads.clone(), Some(id));
        view.handle_key_event(KeyCode::Char('!').into());
        view.handle_key_event(key.into());
        assert_eq!(view.rows[view.selected_index().unwrap()].thread_id, other);
        if key == KeyCode::Enter {
            let rename = rx.try_recv().unwrap();
            assert!(
                matches!(&rename, AppEvent::RenameAgentsOverviewThread { thread_id, name } if *thread_id == id && name == "Target!")
            );
            app.agents_overview.threads = threads
                .iter()
                .map(|thread| {
                    (
                        ThreadId::from_string(&thread.id).unwrap(),
                        Some(thread.clone()),
                    )
                })
                .collect();
            app.agents_overview.visible_thread_ids = view.thread_ids();
            app.chat_widget.show_bottom_pane_view(Box::new(view));
            let mut server = crate::start_embedded_app_server_for_picker(&app.config).await?;
            let mut tui = crate::tui::test_support::make_test_tui()?;
            // Synthetic IDs have no rollout: the server rejects the rename.
            Box::pin(app.handle_event(&mut tui, &mut server, rename)).await?;
            let mut retry = app.agents_overview_view(threads.clone(), Some(other));
            assert_eq!(retry.rows[retry.selected_index().unwrap()].thread_id, id);
            retry.handle_key_event(KeyCode::Enter.into());
            assert!(std::iter::from_fn(|| rx.try_recv().ok()).any(|event| matches!(event, AppEvent::RenameAgentsOverviewThread { thread_id, name } if thread_id == id && name == "Target!")));
            server.shutdown().await?;
        } else {
            assert!(rx.try_recv().is_err());
        }
    }
    Ok(())
}

#[tokio::test]
async fn live_center_navigation_and_complete_hints() {
    let mut app = make_test_app().await;
    app.config.features.enable(Feature::Worktrees).unwrap();
    let ready = ThreadId::from_u128(/*value*/ 42);
    let needs_you = ThreadId::from_u128(/*value*/ 43);
    let unloaded = ThreadId::from_u128(/*value*/ 44);
    let mut view = app.agents_overview_view(
        vec![
            overview_thread(
                ready,
                /*parent_thread_id*/ None,
                "Ready task",
                ThreadStatus::Idle,
            ),
            overview_thread(
                needs_you,
                /*parent_thread_id*/ None,
                "Needs input",
                ThreadStatus::SystemError,
            ),
            overview_thread(
                unloaded,
                /*parent_thread_id*/ None,
                "Unloaded task",
                ThreadStatus::NotLoaded,
            ),
        ],
        Some(ready),
    );
    let selected = |view: &AgentsOverviewView| view.rows[view.selected_index().unwrap()].thread_id;
    view.handle_key_event(KeyCode::Tab.into());
    assert_eq!(selected(&view), needs_you);
    view.handle_key_event(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT));
    view.handle_key_event(KeyEvent::new(KeyCode::Tab, KeyModifiers::SHIFT));
    assert_eq!(selected(&view), unloaded);
    insta::assert_snapshot!(
        "live_center_status_filter",
        screen(&view, /*width*/ 40, /*height*/ 12)
    );
    view.handle_key_event(KeyCode::Tab.into());

    let repeat_help =
        KeyEvent::new_with_kind(KeyCode::Char('?'), KeyModifiers::NONE, KeyEventKind::Repeat);
    view.handle_key_event(KeyCode::Char('?').into());
    view.handle_key_event(repeat_help);
    for (name, width, height) in [
        ("live_center_help_three_columns", 100, 24),
        ("live_center_help_two_columns", 60, 24),
        ("live_center_help_one_column", 40, 32),
        ("live_center_navigation_and_complete_hints", 40, 24),
    ] {
        insta::assert_snapshot!(name, screen(&view, width, height));
    }
    view.handle_key_event(KeyCode::Esc.into());
    view.handle_key_event(repeat_help);
    let list = screen(&view, /*width*/ 40, /*height*/ 24);
    assert!(list.contains("Task") && !list.contains("Task shortcuts"));
    assert!(!view.is_complete());
    view.handle_key_event(KeyCode::Esc.into());
    assert!(view.is_complete());
}

#[tokio::test]
async fn live_center_fixed_shortcuts_yield_to_configured_actions() {
    let mut app = make_test_app().await;
    let config: TuiKeymap = toml::from_str("[list]\ncancel = 'q'").unwrap();
    app.keymap = RuntimeKeymap::from_config(&config).unwrap();
    for editor_key in ['f', 'r'] {
        let mut view = app.agents_overview_view(
            vec![overview_thread(
                ThreadId::from_u128(/*value*/ 42),
                /*parent_thread_id*/ None,
                "Task",
                ThreadStatus::Idle,
            )],
            /*selected_thread_id*/ None,
        );
        view.handle_key_event(KeyCode::Char(editor_key).into());
        assert!(
            app.agents_overview
                .view_state
                .lock()
                .unwrap()
                .editing_metadata()
        );
        view.handle_key_event(KeyCode::Char('q').into());
        assert!(
            !app.agents_overview
                .view_state
                .lock()
                .unwrap()
                .editing_metadata()
        );
        assert!(!view.is_complete());
    }
    for (binding, key) in [
        ("tab", KeyEvent::from(KeyCode::Tab)),
        ("?", KeyEvent::from(KeyCode::Char('?'))),
        (
            "shift-?",
            KeyEvent::new(KeyCode::Char('?'), KeyModifiers::SHIFT),
        ),
        ("f9", KeyEvent::from(KeyCode::F(9))),
        ("enter", KeyEvent::from(KeyCode::Enter)),
    ] {
        let mut app = make_test_app().await;
        let config: TuiKeymap = toml::from_str(&format!(
            "[list]\ncancel = 'f9'\n[agents]\nresume = '{binding}'"
        ))
        .unwrap();
        app.keymap = RuntimeKeymap::from_config(&config).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        app.app_event_tx = AppEventSender::new(tx);
        let mut view = app.agents_overview_view(Vec::new(), /*selected_thread_id*/ None);
        view.handle_key_event(KeyCode::Esc.into());
        assert!(!view.is_complete());
        if key.code == KeyCode::Char('?') {
            assert!(!screen(&view, /*width*/ 100, /*height*/ 24).contains("? help"));
        }
        if key.code == KeyCode::Enter {
            assert!(!screen(&view, /*width*/ 100, /*height*/ 24).contains("enter open"));
            view.handle_key_event(KeyCode::Char('?').into());
            assert!(!screen(&view, /*width*/ 100, /*height*/ 24).contains("enter open"));
            app.agents_overview
                .view_state
                .lock()
                .unwrap()
                .server_version_notice = Some("Version notice".into());
            assert!(screen(&view, /*width*/ 100, /*height*/ 24).contains("f9 back"));
            view.handle_key_event(KeyCode::Esc.into());
            assert!(screen(&view, /*width*/ 100, /*height*/ 24).contains("Task shortcuts"));
            view.handle_key_event(KeyCode::F(9).into());
            assert!(!screen(&view, /*width*/ 100, /*height*/ 24).contains("Task shortcuts"));
            app.agents_overview
                .view_state
                .lock()
                .unwrap()
                .server_version_notice = None;
            view.handle_key_event(KeyCode::Char('f').into());
            assert!(!screen(&view, /*width*/ 100, /*height*/ 24).contains("enter open"));
        }
        view.handle_key_event(key);
        assert!(!view.is_complete());
        assert!(
            matches!(rx.try_recv(), Ok(AppEvent::OpenResumePicker)),
            "{binding}"
        );
        assert!(rx.try_recv().is_err());
    }
}

#[tokio::test]
async fn live_center_hints_follow_configured_bindings() {
    let mut app = make_test_app().await;
    app.config.features.disable(Feature::Worktrees).unwrap();
    let config: TuiKeymap = toml::from_str(
        r#"
[list]
move_up = 'k'
move_down = 'j'
page_up = []
[agents]
archive = []
rename = 'z r'
"#,
    )
    .unwrap();
    app.keymap = RuntimeKeymap::from_config(&config).unwrap();
    let mut view = app.agents_overview_view(Vec::new(), /*selected_thread_id*/ None);
    insta::assert_snapshot!(
        "live_center_custom_footer",
        screen(&view, /*width*/ 100, /*height*/ 12)
    );
    view.handle_key_event(KeyCode::Char('?').into());
    insta::assert_snapshot!(
        "live_center_custom_help",
        screen(&view, /*width*/ 100, /*height*/ 24)
    );
}

#[tokio::test]
async fn live_center_search_row_appears_only_while_editing() {
    let app = make_test_app().await;
    let mut view = app.agents_overview_view(
        vec![overview_thread(
            ThreadId::from_u128(/*value*/ 42),
            /*parent_thread_id*/ None,
            "Task to find",
            ThreadStatus::Idle,
        )],
        /*selected_thread_id*/ None,
    );
    let area = Rect::new(
        /*x*/ 0, /*y*/ 0, /*width*/ 88, /*height*/ 16,
    );
    let mut buf = ratatui::buffer::Buffer::empty(area);
    view.render(area, &mut buf);
    let header = &buf.content[3 * 88..4 * 88];
    let text = header
        .iter()
        .map(ratatui::buffer::Cell::symbol)
        .collect::<String>();
    let styles = ["Task", "Model", "Status", "Updated"]
        .map(|label| header[text.find(label).unwrap()].style());
    assert_eq!(styles, [styles[0]; 4]);
    let idle = screen(&view, area.width, area.height);
    view.handle_key_event(KeyCode::Char('f').into());
    view.handle_paste("find".into());
    insta::assert_snapshot!(
        "live_center_search_active",
        screen(&view, area.width, area.height)
    );
    view.handle_key_event(KeyCode::Esc.into());
    assert_eq!(screen(&view, area.width, area.height), idle);
}

#[tokio::test]
async fn backspace_edits_search_and_rename_without_deleting_tasks() {
    let mut app = make_test_app().await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.app_event_tx = AppEventSender::new(tx);
    let mut view = app.agents_overview_view(
        vec![overview_thread(
            ThreadId::new(),
            /*parent_thread_id*/ None,
            "Task",
            ThreadStatus::Idle,
        )],
        /*selected_thread_id*/ None,
    );
    for key in ['f', 'r'] {
        view.handle_key_event(KeyCode::Char(key).into());
        let initial = screen(&view, /*width*/ 88, /*height*/ 16);
        view.handle_paste("!".into());
        view.handle_key_event(KeyCode::Backspace.into());
        assert_eq!(screen(&view, /*width*/ 88, /*height*/ 16), initial);
        assert!(rx.try_recv().is_err());
        view.handle_key_event(KeyCode::Esc.into());
    }
}

#[tokio::test]
async fn live_center_show_more_navigation_search_and_loading() {
    let mut app = make_test_app().await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.app_event_tx = AppEventSender::new(tx);
    app.agents_overview.view_state.lock().unwrap().has_more = true;
    let thread = overview_thread(
        ThreadId::new(),
        /*parent_thread_id*/ None,
        "Recent task",
        ThreadStatus::NotLoaded,
    );
    let mut view = app.agents_overview_view(vec![thread], /*selected_thread_id*/ None);
    view.handle_key_event(KeyCode::Down.into());
    insta::assert_snapshot!(
        "live_center_show_more",
        screen(&view, /*width*/ 80, /*height*/ 12)
    );
    view.handle_key_event(KeyCode::Enter.into());
    view.handle_key_event(KeyCode::Enter.into());
    assert_matches!(rx.try_recv(), Ok(AppEvent::ShowMoreAgentsOverview));
    assert!(rx.try_recv().is_err());
    assert!(screen(&view, /*width*/ 80, /*height*/ 12).contains("Loading more"));
    {
        let mut state = app.agents_overview.view_state.lock().unwrap();
        state.loading = false;
        state.refresh_failed = true;
    }
    view.handle_key_event(KeyCode::Char('f').into());
    view.handle_paste("Older task".into());
    insta::assert_snapshot!(
        "live_center_show_more_search_retry",
        screen(&view, /*width*/ 80, /*height*/ 12)
    );
    view.handle_key_event(KeyCode::Enter.into());
    assert_matches!(rx.try_recv(), Ok(AppEvent::ShowMoreAgentsOverview));
}

// TUI-AGENT-CONSOLE-LIST acceptance: one colour per model, nested helpers, and the
// selected agent's recent conversation.

fn render_buffer(view: &AgentsOverviewView, width: u16, height: u16) -> ratatui::buffer::Buffer {
    let area = Rect::new(/*x*/ 0, /*y*/ 0, width, height);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    view.render(area, &mut buf);
    buf
}

fn buffer_rows(buf: &ratatui::buffer::Buffer) -> Vec<String> {
    buf.content
        .chunks(usize::from(buf.area.width))
        .map(|row| row.iter().map(ratatui::buffer::Cell::symbol).collect())
        .collect()
}

/// Cell column of `needle` in a rendered row; every glyph used here is one cell wide.
fn cell_column(row: &str, needle: &str) -> Option<u16> {
    row.find(needle)
        .map(|byte| row[..byte].chars().count() as u16)
}

const DARK_TERMINAL: crate::terminal_probe::DefaultColors = crate::terminal_probe::DefaultColors {
    fg: (230, 230, 230),
    bg: (24, 24, 24),
};

/// A Claude coordinator with GPT, Luna and Gemini helpers, plus an unrelated Claude task.
fn nested_agents_fixture() -> Vec<Thread> {
    use codex_protocol::openai_models::ReasoningEffort;
    let now = chrono::Utc::now().timestamp();
    let working = ThreadStatus::Active {
        active_flags: Vec::new(),
    };
    [
        (
            42,
            None,
            "Fix the dashboard token count",
            "claude/opus",
            Some(ReasoningEffort::XHigh),
            working.clone(),
            120,
        ),
        (
            43,
            Some(42),
            "Find where usage is emitted",
            "gpt-6.1-sol",
            Some(ReasoningEffort::High),
            working,
            180,
        ),
        (
            44,
            Some(43),
            "Check the bridge turns",
            "gpt-6-luna",
            Some(ReasoningEffort::Low),
            ThreadStatus::Idle,
            300,
        ),
        (
            45,
            Some(42),
            "Draft the release note",
            "agy/gemini-3.8-flash-high",
            None,
            ThreadStatus::Idle,
            600,
        ),
        (
            46,
            None,
            "I'm home.",
            "claude/opus",
            Some(ReasoningEffort::XHigh),
            ThreadStatus::NotLoaded,
            2460,
        ),
    ]
    .into_iter()
    .map(|(id, parent, title, model, effort, status, age)| {
        let mut thread = overview_thread(
            ThreadId::from_u128(id),
            parent.map(ThreadId::from_u128),
            title,
            status,
        );
        thread.model = Some(model.to_string());
        thread.reasoning_effort = effort;
        thread.updated_at = now - age;
        thread
    })
    .collect()
}

#[tokio::test]
async fn live_center_rows_show_model_and_effort_in_agent_colour() {
    let mut app = make_test_app().await;
    app.local_settings.tui.status_line_use_colors = true;
    let view = app.agents_overview_view(
        nested_agents_fixture(),
        Some(ThreadId::from_u128(/*value*/ 45)),
    );
    let buf = crate::terminal_palette::with_test_default_colors(DARK_TERMINAL, || {
        render_buffer(&view, /*width*/ 160, /*height*/ 22)
    });
    let rows = buffer_rows(&buf);
    let header = rows
        .iter()
        .find(|row| row.contains("Updated"))
        .expect("column header");
    let columns = ["Task", "Model", "Status", "Updated"].map(|label| cell_column(header, label));
    assert!(
        columns.iter().all(Option::is_some) && columns.is_sorted(),
        "header reads Task / Model / Status / Updated: {header:?}"
    );
    let label =
        |model: &str, effort: &str| format!("{} · {effort}", app.model_catalog.display_name(model));
    let mut colours = HashMap::new();
    for (id, title, model, effort) in [
        (42, "Fix the dashboard token count", "claude/opus", "xhigh"),
        (43, "Find where usage is emitted", "gpt-6.1-sol", "high"),
        (44, "Check the bridge turns", "gpt-6-luna", "low"),
        (46, "I'm home.", "claude/opus", "xhigh"),
    ] {
        let (y, row) = rows
            .iter()
            .enumerate()
            .find(|(_, row)| row.contains(title))
            .unwrap_or_else(|| panic!("row for {title}"));
        let model_label = label(model, effort);
        let title_x = cell_column(row, title).unwrap();
        let model_x = cell_column(row, &model_label)
            .unwrap_or_else(|| panic!("{title} shows {model_label}: {row:?}"));
        assert!(model_x > title_x, "{row:?}");
        assert_eq!(
            row.matches(app.model_catalog.display_name(model)).count(),
            1,
            "the model name appears once: {row:?}"
        );
        let colour = buf[(model_x, y as u16)].fg;
        assert_ne!(colour, ratatui::style::Color::Reset, "{title}");
        // The agent's dot in front of the title shares its colour.
        assert_eq!(buf[(title_x - 2, y as u16)].fg, colour, "{title}");
        colours.insert(id, colour);
    }
    assert_eq!(colours[&42], colours[&46], "same model, same colour");
    assert_ne!(colours[&42], colours[&43], "Claude and Sol differ");
    assert_ne!(colours[&43], colours[&44], "Sol and Luna differ");
    assert_ne!(colours[&42], colours[&44], "Claude and Luna differ");
}

#[tokio::test]
async fn live_center_nests_helpers_under_their_parent() {
    let app = make_test_app().await;
    let view = app.agents_overview_view(
        nested_agents_fixture(),
        Some(ThreadId::from_u128(/*value*/ 42)),
    );
    let rendered = screen(&view, /*width*/ 160, /*height*/ 22);
    // Only the task list counts: the details pane on the right repeats the selected title.
    let divider = rendered
        .lines()
        .find_map(|line| cell_column(line, "│ Task details"))
        .expect("details divider");
    let lines = rendered
        .lines()
        .map(|line| line.chars().take(usize::from(divider)).collect::<String>())
        .collect::<Vec<_>>();
    let line_of = |title: &str| {
        let matches = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.contains(title))
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        assert_eq!(matches.len(), 1, "{title} is listed once:\n{rendered}");
        matches[0]
    };
    let root = line_of("Fix the dashboard token count");
    assert_eq!(
        line_of("Find where usage is emitted"),
        root + 1,
        "{rendered}"
    );
    assert_eq!(line_of("Check the bridge turns"), root + 2, "{rendered}");
    assert_eq!(line_of("Draft the release note"), root + 3, "{rendered}");
    assert!(line_of("I'm home.") > root + 3, "{rendered}");
    for (title, branch) in [
        (
            "Find where usage is emitted",
            "├─● Find where usage is emitted",
        ),
        ("Check the bridge turns", "│ └─● Check the bridge turns"),
        ("Draft the release note", "└─● Draft the release note"),
    ] {
        assert!(
            lines[line_of(title)].contains(branch),
            "{title} hangs from its parent:\n{rendered}"
        );
    }
    insta::assert_snapshot!("live_center_nested_helpers", rendered);
}

#[tokio::test]
async fn live_center_arrows_walk_nested_rows_in_visual_order() {
    let mut app = make_test_app().await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.app_event_tx = AppEventSender::new(tx);
    let mut view = app.agents_overview_view(
        nested_agents_fixture(),
        Some(ThreadId::from_u128(/*value*/ 42)),
    );
    let selected = |view: &AgentsOverviewView| view.rows[view.selected_index().unwrap()].thread_id;
    let order = [42, 43, 44, 45, 46].map(ThreadId::from_u128);
    for expected in &order[1..] {
        view.handle_key_event(KeyCode::Down.into());
        assert_eq!(selected(&view), *expected);
    }
    for expected in order[..4].iter().rev() {
        view.handle_key_event(KeyCode::Up.into());
        assert_eq!(selected(&view), *expected);
    }
    view.handle_key_event(KeyCode::Down.into());
    view.handle_key_event(KeyCode::Down.into());
    view.handle_key_event(KeyCode::Enter.into());
    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::SelectAgentsOverviewThread { thread_id }) if thread_id == order[2]
    );
}

#[tokio::test]
async fn live_center_shows_selected_agents_recent_conversation() -> Result<()> {
    use futures::SinkExt;
    use futures::StreamExt;
    use tokio_tungstenite::tungstenite::Message;
    let mut app = make_test_app().await;
    app.local_settings.tui.status_line_use_colors = true;
    let threads = nested_agents_fixture();
    let helper = ThreadId::from_u128(/*value*/ 43);
    app.agents_overview.threads = threads
        .iter()
        .map(|thread| {
            (
                ThreadId::from_string(&thread.id).unwrap(),
                Some(thread.clone()),
            )
        })
        .collect();
    let user_message = |id: &str, text: &str| {
        serde_json::json!({"type": "userMessage", "id": id, "clientId": null,
            "content": [{"type": "text", "text": text, "textElements": []}]})
    };
    let turn = |id: &str, items: Vec<serde_json::Value>, status: &str| {
        serde_json::json!({"id": id, "items": items, "itemsView": "full", "status": status,
            "error": null, "startedAt": null, "completedAt": null, "durationMs": null})
    };
    // Newest first, as thread/turns/list returns with sortDirection desc.
    let turns = serde_json::json!([
        turn(
            "turn-2",
            vec![user_message(
                "u2",
                "Also check thread/inject_items: does it emit usage?"
            )],
            "inProgress"
        ),
        turn(
            "turn-1",
            vec![
                user_message(
                    "u1",
                    "Find where the engine emits thread/tokenUsage/updated."
                ),
                serde_json::json!({"type": "commandExecution", "id": "c1",
                    "command": "rg -n \"tokenUsage/updated\" codex-rs/app-server",
                    "cwd": "/tmp/project", "processId": null, "status": "completed",
                    "commandActions": [],
                    "aggregatedOutput": "turn_processor.rs:812 notify_token_usage(thread, usage)",
                    "exitCode": 0, "durationMs": 12}),
                serde_json::json!({"type": "agentMessage", "id": "a1",
                    "text": "Only run_turn calls it; bridge turns never reach it."}),
            ],
            "completed"
        ),
    ]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = crate::resolve_remote_addr(&format!("ws://{}", listener.local_addr()?))?;
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let mut socket = tokio_tungstenite::accept_async(stream).await?;
        let mut requested = Vec::new();
        while let Some(Ok(Message::Text(text))) = socket.next().await {
            let codex_app_server_protocol::JSONRPCMessage::Request(request) =
                serde_json::from_str(&text)?
            else {
                continue;
            };
            let params = request.params.unwrap_or_default();
            let result = match request.method.as_str() {
                "initialize" => serde_json::json!({"userAgent": "agent-console-test/1.0"}),
                "thread/turns/list" => {
                    requested.push(params["threadId"].as_str().unwrap_or_default().to_string());
                    assert_eq!(params["itemsView"], "full");
                    serde_json::json!({"data": turns, "nextCursor": null})
                }
                method => serde_json::json!({"unexpected": method}),
            };
            socket
                .send(Message::Text(
                    serde_json::json!({"id": request.id, "result": result})
                        .to_string()
                        .into(),
                ))
                .await?;
        }
        Ok::<_, color_eyre::Report>(requested)
    });
    let session = AppServerSession::new(
        crate::connect_remote_app_server(endpoint).await?,
        crate::app_server_session::ThreadParamsMode::Remote,
    );
    let view = app.agents_overview_view(threads.clone(), Some(helper));
    app.agents_overview.visible_thread_ids = view.thread_ids();
    app.chat_widget.show_bottom_pane_view(Box::new(view));
    let tui = crate::tui::test_support::make_test_tui()?;
    // Each frame asks for the selected task's conversation; it arrives asynchronously.
    app.refresh_agents_overview_usage(&session, tui.frame_requester());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(/*secs*/ 5);
    let (buf, rows) = loop {
        let view = app.agents_overview_view(threads.clone(), Some(helper));
        let buf = crate::terminal_palette::with_test_default_colors(DARK_TERMINAL, || {
            render_buffer(&view, /*width*/ 160, /*height*/ 30)
        });
        let rows = buffer_rows(&buf);
        if rows
            .iter()
            .any(|row| row.contains("bridge turns never reach it"))
            || std::time::Instant::now() > deadline
        {
            break (buf, rows);
        }
        tokio::time::sleep(std::time::Duration::from_millis(/*millis*/ 20)).await;
    };
    let details_x = rows
        .iter()
        .find_map(|row| cell_column(row, "│"))
        .expect("details divider")
        + 2;
    let details = rows
        .iter()
        .map(|row| row.chars().skip(usize::from(details_x)).collect::<String>())
        .collect::<Vec<_>>();
    let line_of = |needle: &str| {
        details
            .iter()
            .position(|line| line.contains(needle))
            .unwrap_or_else(|| panic!("conversation shows {needle:?}:\n{}", details.join("\n")))
    };
    let claude = app.model_catalog.display_name("claude/opus").to_string();
    let sol = app.model_catalog.display_name("gpt-6.1-sol").to_string();
    let asked = line_of(&format!("{claude} → {sol}"));
    let question = line_of("Find where the engine emits");
    let ran = line_of("Ran rg -n");
    let reply = line_of("bridge turns never reach it");
    let steer = line_of("Also check thread/inject_items");
    assert!(asked < question && question < ran && ran < reply && reply < steer);
    let replier = details[question + 1..ran]
        .iter()
        .position(|line| line.contains(&sol) && !line.contains('→'))
        .map(|offset| question + 1 + offset)
        .expect("the reply is labelled with the helper's model");
    // Speakers carry their model's colour, the same as that model's row.
    let colour_at = |line: usize, needle: &str| {
        let x = details_x + cell_column(&details[line], needle).unwrap();
        buf[(x, line as u16)].fg
    };
    let root_row = rows
        .iter()
        .position(|row| row.contains("Fix the dashboard token count"))
        .unwrap();
    let root_label_x = cell_column(&rows[root_row], &claude).unwrap();
    assert_eq!(
        colour_at(asked, &claude),
        buf[(root_label_x, root_row as u16)].fg
    );
    assert_ne!(colour_at(replier, &sol), colour_at(asked, &claude));
    session.shutdown().await?;
    assert_eq!(server.await??, vec![helper.to_string()]);
    Ok(())
}

#[tokio::test]
async fn dashboard_map_gets_the_lists_tree_titles_models_and_colours() {
    let app = make_test_app().await;
    let view = app.agents_overview_view(nested_agents_fixture(), /*selected_thread_id*/ None);
    let agents = crate::app::agents_overview_view::dashboard_agents(&view.rows);
    let summary = agents
        .iter()
        .map(|agent| {
            let parent = agent.parent_id.as_ref().map(|parent| {
                agents
                    .iter()
                    .find(|other| &other.id == parent)
                    .map_or("missing", |other| other.title.as_str())
            });
            (
                agent.title.as_str(),
                parent,
                agent.color.as_deref(),
                agent.status_label.as_str(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        summary,
        vec![
            ("Fix the dashboard token count", None, Some("#b4532a"), "Working"),
            (
                "Find where usage is emitted",
                Some("Fix the dashboard token count"),
                Some("#0b7a5e"),
                "Working",
            ),
            (
                "Check the bridge turns",
                Some("Find where usage is emitted"),
                Some("#6d3fb5"),
                "Ready",
            ),
            (
                "Draft the release note",
                Some("Fix the dashboard token count"),
                Some("#1a5fd0"),
                "Ready",
            ),
            ("I'm home.", None, Some("#b4532a"), "Inactive"),
        ]
    );
    let sol = agents
        .iter()
        .find(|agent| agent.title == "Find where usage is emitted")
        .expect("the helper is on the map");
    assert_eq!(sol.model, view.rows[1].model_label());
    assert_eq!(sol.status, crate::dashboard_server::DashboardAgentStatus::Working);
}
