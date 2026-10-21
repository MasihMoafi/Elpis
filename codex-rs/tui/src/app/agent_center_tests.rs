//! Dashboard rows, paging, metadata clipping and status-filter regressions.

use super::*;
use assert_matches::assert_matches;
use pretty_assertions::assert_eq;

#[path = "agent_center_demo_tests.rs"]
mod demo;

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
                (index > 0).then_some(current),
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
    app.agents_overview.pinned_thread_ids = Some(vec![current, ThreadId::from_u128(/*value*/ 44)]);
    let mut view = app.agents_overview_view(threads, Some(current));
    insta::assert_snapshot!(screen(&view, /*width*/ 160, /*height*/ 22));
    view.pinned_thread_ranks = None;
    let mut selected_status_styles = Vec::new();
    for _ in 0..fixtures.len() {
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
        let dot = selected_row
            .iter()
            .find(|cell| cell.symbol() == "●")
            .unwrap();
        assert_eq!(dot.bg, selected_row[marker].bg);
        selected_status_styles.push(format!("{} | {:?}", dot.symbol(), dot.style()));
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
            view.handle_key_event(KeyCode::Char('/').into());
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
    for (key, label) in [('r', "Rename › "), ('/', "Search › ")] {
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
            let cursor = view
                .cursor_pos(Rect::new(
                    /*x*/ 0, /*y*/ 0, /*width*/ 24, /*height*/ 18,
                ))
                .unwrap();
            assert!(cursor.0 < 24);
            insta::assert_snapshot!("live_center_narrow_rename", rendered);
        }
        view.handle_key_event(KeyCode::Esc.into());
    }
}

#[tokio::test]
async fn live_center_rename_retains_target_when_status_leaves_filter() -> Result<()> {
    let mut app = make_test_app().await;
    app.chat_widget.toggle_vim_mode_and_notify();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.app_event_tx = AppEventSender::new(tx);
    let id = ThreadId::new();
    let other = ThreadId::new();
    let mut threads = vec![
        overview_thread(
            id,
            /*parent_thread_id*/ None,
            "Tar\nget",
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
        assert_eq!(
            view.cursor_style(Rect::default()),
            crossterm::cursor::SetCursorStyle::SteadyBar
        );
        threads[0].status = ThreadStatus::SystemError;
        view = app.agents_overview_view(threads.clone(), Some(id));
        if key == KeyCode::Enter {
            for edit in [
                KeyCode::Esc,
                KeyCode::Char('0'),
                KeyCode::Char('c'),
                KeyCode::Char('w'),
            ] {
                view.handle_key_event(edit.into());
            }
            view.handle_paste("Target".into());
        }
        view.handle_key_event(KeyCode::Char('!').into());
        view.handle_key_event(key.into());
        if key == KeyCode::Esc {
            assert_eq!(
                view.cursor_style(Rect::default()),
                crossterm::cursor::SetCursorStyle::DefaultUserShape
            );
            view.handle_key_event(KeyCode::Esc.into());
        }
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
    assert!(screen(&view, /*width*/ 40, /*height*/ 24).contains("Tasks"));
    assert!(!view.is_complete());
    view.handle_key_event(KeyCode::Esc.into());
    assert!(view.is_complete());
}

#[tokio::test]
async fn live_center_fixed_shortcuts_yield_to_configured_actions() {
    let mut app = make_test_app().await;
    let config: TuiKeymap = toml::from_str("[list]\ncancel = 'q'").unwrap();
    app.keymap = RuntimeKeymap::from_config(&config).unwrap();
    for editor_key in ['/', 'r'] {
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
            view.handle_key_event(KeyCode::Char('/').into());
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
toggle_pin = 'z p'
"#,
    )
    .unwrap();
    app.keymap = RuntimeKeymap::from_config(&config).unwrap();
    app.agents_overview.pinned_thread_ids = Some(Vec::new());
    let view = app.agents_overview_view(Vec::new(), /*selected_thread_id*/ None);
    insta::assert_snapshot!(
        "live_center_custom_footer",
        screen(&view, /*width*/ 100, /*height*/ 12)
    );
    let thread_id = ThreadId::from_u128(/*value*/ 42);
    let mut view = app.agents_overview_view(
        vec![overview_thread(
            thread_id,
            /*parent_thread_id*/ None,
            "Task",
            ThreadStatus::Idle,
        )],
        Some(thread_id),
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
    let styles =
        ["Tasks", "Status", "Updated"].map(|label| header[text.find(label).unwrap()].style());
    assert_eq!(styles, [styles[0]; 3]);
    let idle = screen(&view, area.width, area.height);
    for key in [KeyCode::Char('/'), KeyCode::F(3)] {
        view.handle_key_event(key.into());
        view.handle_paste("find".into());
        insta::assert_snapshot!(
            "live_center_search_active",
            screen(&view, area.width, area.height)
        );
        view.handle_key_event(KeyCode::Esc.into());
        assert_eq!(screen(&view, area.width, area.height), idle);
    }
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
    for key in ['/', 'r'] {
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
async fn overview_clears_voice_badge_after_async_close() -> Result<()> {
    let (mut app, mut events, _) = crate::app::tests::make_test_app_with_channels().await;
    let owner = ThreadId::new();
    crate::chatwidget::activate_voice_for_thread(&mut app.chat_widget, owner);
    app.chat_widget.park_voice();
    let (visible, _, _, _) = crate::chatwidget::tests::make_chatwidget_manual_with_sender().await;
    app.background_voice = Some(Box::new(std::mem::replace(&mut app.chat_widget, visible)));
    app.primary_thread_id = Some(owner);
    let thread = overview_thread(
        owner,
        /*parent_thread_id*/ None,
        "Voice owner",
        ThreadStatus::Idle,
    );
    app.agents_overview
        .threads
        .insert(owner, Some(thread.clone()));
    let view = app.agents_overview_view(vec![thread], Some(owner));
    app.agents_overview.visible_thread_ids = view.thread_ids();
    app.chat_widget.show_bottom_pane_view(Box::new(view));
    assert!(render_bottom_popup(&app.chat_widget, /*width*/ 100).contains("  voice"));
    let mut server = crate::start_embedded_app_server_for_picker(&app.config).await?;
    let mut tui = crate::tui::test_support::make_test_tui()?;
    app.deliver_background_voice_notification(
        owner,
        &ServerNotification::ThreadRealtimeClosed(
            codex_app_server_protocol::ThreadRealtimeClosedNotification {
                thread_id: owner.to_string(),
                reason: Some("requested".into()),
            },
        ),
    );
    while let Ok(event) = events.try_recv() {
        Box::pin(app.handle_event(&mut tui, &mut server, event)).await?;
    }
    assert!(!render_bottom_popup(&app.chat_widget, /*width*/ 100).contains("  voice"));
    server.shutdown().await?;
    Ok(())
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
    view.handle_key_event(KeyCode::Char('/').into());
    view.handle_paste("Older task".into());
    insta::assert_snapshot!(
        "live_center_show_more_search_retry",
        screen(&view, /*width*/ 80, /*height*/ 12)
    );
    view.handle_key_event(KeyCode::Enter.into());
    assert_matches!(rx.try_recv(), Ok(AppEvent::ShowMoreAgentsOverview));
}

/// Elpis: every row shows its catalog model name in a column between the title and the status,
/// in Codex's row order; narrow layouts share title space and long names end in an ellipsis.
#[tokio::test]
async fn live_center_rows_show_each_model_at_wide_and_narrow_widths() {
    let mut app = make_test_app().await;
    let mut preset = crate::test_support::TEST_MODEL_PRESETS[0].clone();
    preset.model = String::from("claude/opus");
    preset.display_name = String::from("Opus 5.5 (Claude subscription)");
    app.model_catalog = std::sync::Arc::new(crate::model_catalog::ModelCatalog::new(vec![preset]));
    let threads = [
        ("First task", Some("claude/opus")),
        ("Second task", Some("model-a")),
        ("Third task", None),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (name, model))| {
        let mut thread = overview_thread(
            ThreadId::from_u128(index as u128 + 1),
            /*parent_thread_id*/ None,
            name,
            ThreadStatus::Idle,
        );
        thread.model = model.map(str::to_string);
        thread.updated_at -= index as i64;
        thread
    })
    .collect();
    let view = app.agents_overview_view(threads, /*selected_thread_id*/ None);

    let wide = screen(&view, /*width*/ 160, /*height*/ 18);
    let lines = wide
        .lines()
        .map(|line| line.split('│').next().unwrap())
        .collect::<Vec<_>>();
    let header = lines
        .iter()
        .find(|line| line.contains("Tasks") && line.contains("Model"))
        .unwrap();
    let column = |line: &str, needle: &str| line[..line.find(needle).unwrap()].chars().count();
    let model_column = column(header, "Model");
    let status_column = column(header, "Status");
    assert!(column(header, "Tasks") < model_column && model_column < column(header, "Status"));
    let rows = ["First task", "Second task", "Third task"].map(|title| {
        let position = lines.iter().position(|line| line.contains(title)).unwrap();
        (position, lines[position])
    });
    assert!(rows[0].0 < rows[1].0 && rows[1].0 < rows[2].0);
    let labels = rows.map(|(_, line)| {
        assert_eq!(column(line, "Ready"), status_column + 2);
        let chars = line.chars().collect::<Vec<_>>();
        // The title ends before the model column, and two spaces separate the model from the status.
        assert!(
            chars[..model_column]
                .iter()
                .collect::<String>()
                .contains("task")
        );
        assert!(
            chars[model_column - 2..model_column]
                .iter()
                .all(|c| *c == ' ')
        );
        chars[model_column..status_column]
            .iter()
            .collect::<String>()
            .trim_end()
            .to_owned()
    });
    assert!(labels[0].starts_with("Opus 5.5 (Claude") && labels[0].ends_with('…'));
    assert_eq!(labels[1].trim_end(), "model-a");
    assert_eq!(labels[2].trim_end(), "Unknown");

    // Model labels remain visible as status metadata drops on smaller screens.
    assert!(screen(&view, /*width*/ 80, /*height*/ 18).contains("model-a"));
    for (width, status) in [(79, true), (55, false), (40, false)] {
        let narrow = screen(&view, width, /*height*/ 18);
        assert!(narrow.contains("Second task"));
        assert!(narrow.contains("Model") && narrow.contains("model-a"));
        assert_eq!(narrow.contains("Status"), status);
        assert!(
            narrow
                .lines()
                .all(|line| line.chars().count() <= usize::from(width))
        );
    }
}

#[tokio::test]
async fn agent_details_name_parent_and_direct_children() {
    let app = make_test_app().await;
    let root = ThreadId::from_u128(101);
    let child = ThreadId::from_u128(102);
    let sibling = ThreadId::from_u128(103);
    let grandchild = ThreadId::from_u128(104);
    let threads = vec![
        overview_thread(root, None, "Ada", ThreadStatus::Idle),
        overview_thread(
            child,
            Some(root),
            "Bohr",
            ThreadStatus::Active {
                active_flags: Vec::new(),
            },
        ),
        overview_thread(sibling, Some(root), "Curie", ThreadStatus::Idle),
        overview_thread(grandchild, Some(child), "Dirac", ThreadStatus::Idle),
    ];
    let child_view = app.agents_overview_view(threads.clone(), Some(child));
    let rendered = screen(&child_view, 190, 30);
    // Old details only identify the requester's model, so this assertion fails.
    assert!(rendered.contains("Parent: Ada"), "{rendered}");
    assert!(
        rendered.contains("Children: Dirac · 0 running"),
        "{rendered}"
    );
    assert!(!rendered.contains("Started by you"), "{rendered}");

    let parent_view = app.agents_overview_view(threads, Some(root));
    let rendered = screen(&parent_view, 190, 30);
    // Old details have no children line, so this assertion also fails.
    assert!(
        rendered.contains("Children: Bohr, Curie · 1 running"),
        "{rendered}"
    );
    assert!(!rendered.contains("Children: Bohr, Curie, Dirac"));
    assert!(rendered.contains("Started by you"), "{rendered}");
}

#[tokio::test]
async fn top_level_agent_details_show_you_without_children() {
    let app = make_test_app().await;
    let view = app.agents_overview_view(
        vec![overview_thread(
            ThreadId::new(),
            None,
            "Ada",
            ThreadStatus::Idle,
        )],
        None,
    );
    let rendered = screen(&view, 160, 24);
    // Old code fails Started by you; the absence assertions are negative controls.
    assert!(rendered.contains("Started by you"), "{rendered}");
    assert!(!rendered.contains("Parent:"));
    assert!(!rendered.contains("Children:"));
}

#[tokio::test]
async fn agent_details_do_not_attribute_an_unloaded_parent_to_you() {
    let app = make_test_app().await;
    let parent = ThreadId::from_u128(101);
    let child = overview_thread(ThreadId::new(), None, "Bohr", ThreadStatus::Idle);
    let mut view = app.agents_overview_view(vec![child], None);
    view.rows[0].thread.parent_thread_id = Some(parent.to_string());
    let rendered = screen(&view, 190, 24);
    assert!(
        rendered.contains(&format!("Parent: {parent} (not loaded)")),
        "{rendered}"
    );
    assert!(!rendered.contains("Started by you"));
    assert!(!rendered.contains("asked by you"));
    assert!(!rendered.contains("Children:"));
}

#[tokio::test]
async fn child_rows_stay_with_root_across_groupings_and_open_their_own_chat() {
    let mut app = make_test_app().await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.app_event_tx = AppEventSender::new(tx);
    let root = ThreadId::from_u128(101);
    let child = ThreadId::from_u128(102);
    let grandchild = ThreadId::from_u128(103);
    let other = ThreadId::from_u128(104);
    let mut parent = overview_thread(root, None, "Parent task", ThreadStatus::Idle);
    parent.model = Some("aaa-parent".into());
    let mut worker = overview_thread(child, Some(root), "Worker chat", ThreadStatus::Idle);
    worker.model = Some("zzz-worker".into());
    worker.cwd = test_path_buf("/tmp/other-project").abs();
    let nested = overview_thread(
        grandchild,
        Some(child),
        "Nested worker",
        ThreadStatus::NotLoaded,
    );
    let mut second = overview_thread(other, None, "Separate task", ThreadStatus::Idle);
    second.model = Some("middle-model".into());
    let threads = vec![second, nested, worker, parent];
    for grouping in [
        AgentsOverviewGrouping::Project,
        AgentsOverviewGrouping::Status,
        AgentsOverviewGrouping::Model,
    ] {
        app.agents_overview.view_state.lock().unwrap().grouping = grouping;
        let mut view = app.agents_overview_view(threads.clone(), Some(child));
        let rendered = screen(&view, 160, 24);
        let lines = rendered.lines().collect::<Vec<_>>();
        let parent_line = lines
            .iter()
            .position(|line| line.contains("Parent task"))
            .unwrap();
        assert!(
            lines[parent_line + 1].contains("└─● Worker chat"),
            "{rendered}"
        );
        assert!(
            lines[parent_line + 2].contains("  └─● Nested worker"),
            "{rendered}"
        );
        assert!(rendered.contains("All 4"), "{rendered}");
        view.handle_key_event(KeyCode::Enter.into());
        assert!(
            matches!(rx.try_recv(), Ok(AppEvent::SelectAgentsOverviewThread { thread_id }) if thread_id == child)
        );
    }
    app.agents_overview.view_state.lock().unwrap().search = "Nested worker".into();
    let view = app.agents_overview_view(threads.clone(), Some(child));
    let rendered = screen(&view, 160, 24);
    assert!(rendered.contains("Parent task"));
    assert!(rendered.contains("└─● Worker chat"));
    assert!(!rendered.contains("Separate task"));
    app.agents_overview.hidden_threads.insert(root);
    let view = app.agents_overview_view(threads, None);
    assert_eq!(view.thread_ids(), vec![other]);
}

/// Drive the same app entry point as crossterm mouse events, using painted titles as targets.
#[tokio::test]
async fn tui_pointer_selects_visible_agents_and_updates_the_conversation() -> Result<()> {
    use crate::tui::TuiEvent;
    use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
    use ratatui::layout::Size;

    for (width, height, filtered) in [(190, 40, false), (95, 16, true)] {
        let mut app = make_test_app().await;
        let threads = (0..36)
            .map(|index| {
                let mut thread = overview_thread(
                    ThreadId::from_u128(1000 + index),
                    None,
                    &format!("Pointer task {index:02}"),
                    ThreadStatus::Idle,
                );
                thread.preview = format!("CONVERSATION_ONLY_{index:02}");
                thread.updated_at -= index as i64;
                if index % 2 == 1 {
                    thread.name = Some(format!("Hidden task {index:02}"));
                }
                thread
            })
            .collect();
        let mut view = app.agents_overview_view(threads, Some(ThreadId::from_u128(1000)));
        if filtered {
            view.handle_key_event(KeyCode::Char('/').into());
            view.handle_paste("Pointer".into());
        }
        let ids = view
            .rows
            .iter()
            .map(|row| row.thread_id)
            .collect::<Vec<_>>();
        app.chat_widget.show_bottom_pane_view(Box::new(view));
        let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
        let mut tui = crate::tui::test_support::make_test_tui_with_size(Size::new(width, height))?;
        tui.set_owned_screen(true)?;
        app.render_owned_transcript(&mut tui, Size::new(width, height))?;
        if filtered {
            app.handle_tui_event(
                &mut tui,
                &mut server,
                TuiEvent::Key(KeyCode::PageDown.into()),
            )
            .await?;
            app.render_owned_transcript(&mut tui, Size::new(width, height))?;
        }
        let before = app
            .chat_widget
            .selected_index_for_present_view(AGENTS_OVERVIEW_VIEW_ID)
            .unwrap();
        let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
        let target = buffer
            .content()
            .chunks(usize::from(width))
            .enumerate()
            .find_map(|(y, row)| {
                let text = row
                    .iter()
                    .take(60)
                    .map(ratatui::buffer::Cell::symbol)
                    .collect::<String>();
                let x = text.find("Pointer task ")?;
                if text.trim_start().starts_with('›') {
                    return None;
                }
                let number = text[x + 13..].get(..2)?.parse::<u128>().ok()?;
                Some((
                    x as u16,
                    y as u16,
                    ThreadId::from_u128(1000 + number),
                    number,
                ))
            })
            .expect("a visible unselected row");
        let click = |x, y| {
            TuiEvent::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: x,
                row: y,
                modifiers: KeyModifiers::NONE,
            })
        };
        // Headings, margins and the details column must not choose a task.
        for (x, y) in [(0, 0), (8, 0), (width - 1, target.1)] {
            app.handle_tui_event(&mut tui, &mut server, click(x, y))
                .await?;
            assert_eq!(
                app.chat_widget
                    .selected_index_for_present_view(AGENTS_OVERVIEW_VIEW_ID),
                Some(before)
            );
        }
        app.handle_tui_event(&mut tui, &mut server, click(target.0, target.1))
            .await?;
        let selected = app
            .chat_widget
            .selected_index_for_present_view(AGENTS_OVERVIEW_VIEW_ID)
            .unwrap();
        assert_eq!(
            ids[selected], target.2,
            "click must choose the painted filtered/scrolled task"
        );
        app.render_owned_transcript(&mut tui, Size::new(width, height))?;
        if !filtered {
            let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
            let text = buffer
                .content()
                .iter()
                .map(ratatui::buffer::Cell::symbol)
                .collect::<String>();
            assert!(
                text.contains(&format!("CONVERSATION_ONLY_{:02}", target.3)),
                "preview follows selection"
            );
        }
        // Tabs use the same painted labels, even while a search is active.
        for (label, empty) in [("Working 0", true), ("All 36", false)] {
            let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
            let (x, y) = buffer
                .content()
                .chunks(usize::from(width))
                .enumerate()
                .find_map(|(y, row)| {
                    let line = row
                        .iter()
                        .map(ratatui::buffer::Cell::symbol)
                        .collect::<String>();
                    line.find(label).map(|offset| {
                        (
                            unicode_width::UnicodeWidthStr::width(&line[..offset]) as u16,
                            y as u16,
                        )
                    })
                })
                .expect("visible filter tab");
            app.handle_tui_event(&mut tui, &mut server, click(x, y))
                .await?;
            app.render_owned_transcript(&mut tui, Size::new(width, height))?;
            let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
            let text = buffer
                .content()
                .iter()
                .map(ratatui::buffer::Cell::symbol)
                .collect::<String>();
            assert_eq!(
                text.contains("No matching tasks"),
                empty,
                "painted filter tab {label}"
            );
        }
        if !filtered {
            app.handle_tui_event(
                &mut tui,
                &mut server,
                TuiEvent::Key(KeyCode::Char('r').into()),
            )
            .await?;
            let selected = app
                .chat_widget
                .selected_index_for_present_view(AGENTS_OVERVIEW_VIEW_ID);
            app.handle_tui_event(&mut tui, &mut server, click(target.0, target.1))
                .await?;
            assert_eq!(
                app.chat_widget
                    .selected_index_for_present_view(AGENTS_OVERVIEW_VIEW_ID),
                selected,
                "rename owns pointer input"
            );
            app.handle_tui_event(&mut tui, &mut server, TuiEvent::Key(KeyCode::Esc.into()))
                .await?;
            app.handle_tui_event(
                &mut tui,
                &mut server,
                TuiEvent::Key(KeyCode::Char('?').into()),
            )
            .await?;
            app.handle_tui_event(&mut tui, &mut server, click(target.0, target.1))
                .await?;
            assert_eq!(
                app.chat_widget
                    .selected_index_for_present_view(AGENTS_OVERVIEW_VIEW_ID),
                selected,
                "help hides the row targets"
            );
            app.handle_tui_event(&mut tui, &mut server, TuiEvent::Key(KeyCode::Esc.into()))
                .await?;
            struct BlockingPointerDialog;
            impl crate::render::renderable::Renderable for BlockingPointerDialog {
                fn desired_height(&self, _width: u16) -> u16 {
                    3
                }
                fn render(&self, area: Rect, buffer: &mut ratatui::buffer::Buffer) {
                    buffer.set_string(
                        area.x,
                        area.y,
                        "Confirmation dialog",
                        ratatui::style::Style::default(),
                    );
                }
            }
            impl crate::bottom_pane::BottomPaneView for BlockingPointerDialog {
                fn presentation(&self) -> crate::bottom_pane::ViewPresentation {
                    crate::bottom_pane::ViewPresentation::Centered
                }
            }
            app.chat_widget
                .show_bottom_pane_view(Box::new(BlockingPointerDialog));
            app.handle_tui_event(&mut tui, &mut server, click(target.0, target.1))
                .await?;
            assert_eq!(
                app.chat_widget
                    .selected_index_for_present_view(AGENTS_OVERVIEW_VIEW_ID),
                selected,
                "topmost modal owns pointer input"
            );
        }
        server.shutdown().await?;
        tui.set_owned_screen(false)?;
    }
    Ok(())
}

#[tokio::test]
async fn tui_pointer_provider_names_follow_the_actual_bridge_route() {
    let app = make_test_app().await;
    for (model, provider, expected) in [
        ("claude/opus", "openai", "Claude subscription"),
        ("agy/gemini", "openai", "Antigravity"),
        ("gpt-6-luna", "openai", "OpenAI"),
        ("claude-opus-5-5", "anthropic", "Anthropic"),
        ("claude-opus-5-5", "anthropic-credits", "Anthropic"),
        ("anthropic/claude-opus", "openrouter", "openrouter"),
    ] {
        let mut thread =
            overview_thread(ThreadId::new(), None, "Provider route", ThreadStatus::Idle);
        thread.model = Some(model.into());
        thread.model_provider = provider.into();
        let view = app.agents_overview_view(vec![thread], None);
        assert!(
            screen(&view, 190, 18).contains(&format!(" · {expected} · asked by you")),
            "{model} through {provider} must show {expected}"
        );
    }
}
