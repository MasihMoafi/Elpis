use super::*;

use crate::render::renderable::Renderable;

fn render_ledger(chat: &ChatWidget, height: u16) -> String {
    let area = ratatui::layout::Rect::new(0, 0, 52, height);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    chat.render_context_ledger(area, &mut buf);

    (0..area.height)
        .map(|y| {
            (0..area.width).fold(String::new(), |mut line, x| {
                line.push_str(&crate::terminal_hyperlinks::strip_osc8(
                    buf[(x, y)].symbol(),
                ));
                line
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_ledger_buffer(chat: &ChatWidget, height: u16) -> ratatui::buffer::Buffer {
    let area = ratatui::layout::Rect::new(0, 0, 52, height);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    chat.render_context_ledger(area, &mut buf);
    buf
}

fn configure_ledger_sources(
    chat: &mut ChatWidget,
    root: &std::path::Path,
) -> anyhow::Result<(PathBuf, PathBuf)> {
    let memories = root.join(".elpis/memories");
    let cwd = root.join("projects/Elpis");
    let dev = root.join("projects/skills/dev");
    let global = root.join("global/AGENTS.md");
    let workspace = crate::legacy_core::elpis_context::workspace_context_dir(Some(&memories), &cwd)
        .expect("workspace path");

    std::fs::create_dir_all(global.parent().expect("global parent"))?;
    std::fs::create_dir_all(&cwd)?;
    std::fs::create_dir_all(&dev)?;
    std::fs::create_dir_all(&workspace)?;
    std::fs::create_dir_all(&memories)?;
    std::fs::write(&global, "Global instructions")?;
    std::fs::write(cwd.join("AGENTS.md"), "Project instructions")?;
    std::fs::write(dev.join("SKILL.md"), "Development instructions")?;
    std::fs::write(workspace.join("GOAL.md"), "Ship the grouped ledger")?;
    std::fs::write(workspace.join("ES.md"), "Command evidence")?;
    std::fs::write(memories.join("MEMORY.md"), "Durable memory")?;

    chat.config.memory_dir = memories.clone().abs();
    chat.config.cwd = cwd.clone().abs();
    // The app server reports global/project instructions. Development rules are
    // discovered from configured roots, because the app server omits them.
    let config_toml_path = root.join("config.toml").abs();
    chat.config.config_layer_stack = ConfigLayerStack::default().with_user_config(
        &config_toml_path,
        toml::from_str::<TomlValue>(&format!(
            "[skills]\ndev_rule_roots = [{}]\n",
            toml::Value::String(dev.display().to_string()).to_string(),
        ))
        .expect("development-rule config"),
    );
    chat.instruction_source_paths = vec![
        codex_utils_path_uri::PathUri::from_abs_path(&global.abs()),
        codex_utils_path_uri::PathUri::from_abs_path(&cwd.join("AGENTS.md").abs()),
    ];
    chat.last_rendered_width.set(Some(120));
    seed_manual_memory_cache_from_disk(chat)?;
    Ok((memories, cwd))
}

#[tokio::test]
async fn manual_memory_create_key_emits_once_and_blocks_same_loop_duplicates(
) -> anyhow::Result<()> {
    let root = tempdir()?;
    let memories = root.path().join("memories");
    let cwd = root.path().join("project");
    std::fs::create_dir_all(&memories)?;
    std::fs::create_dir_all(&cwd)?;
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.config.memory_dir = memories.abs();
    chat.config.cwd = cwd.abs();
    chat.last_rendered_width.set(Some(120));
    seed_manual_memory_cache_from_disk(&mut chat)?;

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('c'))));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('c'))));
    assert_eq!(chat.manual_memory_phase(), ManualMemoryPhase::Creating);
    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::ManualMemoryCreateRequested(_))
    );
    assert!(rx.try_recv().is_err());
    Ok(())
}

#[tokio::test]
async fn manual_memory_focused_ledger_does_not_capture_ctrl_c() -> anyhow::Result<()> {
    let root = tempdir()?;
    let memories = root.path().join("memories");
    let cwd = root.path().join("project");
    std::fs::create_dir_all(&memories)?;
    std::fs::create_dir_all(&cwd)?;
    let (mut chat, mut rx, mut op_rx) = make_chatwidget_manual(None).await;
    chat.config.memory_dir = memories.abs();
    chat.config.cwd = cwd.abs();
    chat.last_rendered_width.set(Some(120));
    chat.thread_id = Some(ThreadId::new());
    seed_manual_memory_cache_from_disk(&mut chat)?;
    handle_turn_started(&mut chat, "turn-1");
    while rx.try_recv().is_ok() {}

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    next_interrupt_op(&mut op_rx);
    assert_eq!(chat.manual_memory_phase(), ManualMemoryPhase::Ready);
    assert_eq!(chat.manual_memory_pending_mutation(), None);
    while let Ok(event) = rx.try_recv() {
        assert!(
            !matches!(event, AppEvent::ManualMemoryCreateRequested(_)),
            "Ctrl-C must stay on the global interrupt/quit path"
        );
    }
    Ok(())
}

#[tokio::test]
async fn manual_memory_mutation_excludes_ordinary_and_add_writers_before_disk_io(
) -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;
    let admission_path = chat
        .manual_memory_bound_target()
        .expect("manual-memory target")
        .storage
        .admission_path
        .clone();
    let admission_before = std::fs::read(&admission_path).ok();
    chat.seed_manual_memory_pending_mutation(Some(ManualMemoryMutation::Create));

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char(' '))));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Delete)));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('g'))));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('e'))));
    let candidate = root.path().join("candidate.md");
    std::fs::write(&candidate, "candidate")?;
    chat.dispatch_command_with_args(
        SlashCommand::Add,
        candidate.display().to_string(),
        Vec::new(),
    );

    assert_eq!(std::fs::read(&admission_path).ok(), admission_before);
    while let Ok(event) = rx.try_recv() {
        assert!(
            !matches!(event, AppEvent::ManualMemoryStatusRefreshRequested(_)),
            "rejected writers must not invalidate an untouched projection"
        );
    }
    Ok(())
}

#[tokio::test]
async fn ledger_groups_real_sources_and_exposes_selected_reason() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;

    let unfocused = render_ledger(&chat, 80);
    assert!(unfocused.contains("Tab focus"));
    assert!(unfocused.contains("Ctrl+click open file"));

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('w'))));
    let rendered = render_ledger(&chat, 80);

    // GOAL.md and ES.md both carry the session forward, so they share one category and
    // there is no separate evidence heading.
    for heading in ["SESSION CONTINUITY", "DURABLE MEMORY", "INSTRUCTIONS"] {
        assert!(rendered.contains(heading), "missing {heading}:\n{rendered}");
    }
    assert!(rendered.contains("≈"), "token estimates must be labeled");
    assert!(rendered.contains("Up/Down move"));
    assert!(rendered.contains("Space/Enter toggle"));
    assert!(rendered.contains("WHY INCLUDED"));
    assert!(rendered.contains("applicable global rules"));
    assert!(
        rendered.contains("dev/SKILL.md"),
        "configured development rule must render as its own row:\n{rendered}"
    );

    let short = render_ledger(&chat, 16);
    assert!(short.contains("Global AGENTS.md"));
    assert!(short.contains("WHY INCLUDED"));
    assert!(short.contains("applicable global rules"));
    Ok(())
}

#[tokio::test]
async fn ledger_disambiguates_similarly_sized_rule_sources() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    let memories = root.path().join(".elpis/memories");
    let cwd = root.path().join("project");
    let global = root.path().join("global/AGENTS.md");
    let configured = root.path().join("configured/dev/AGENTS.md");
    let project = cwd.join("AGENTS.md");
    std::fs::create_dir_all(global.parent().expect("global parent"))?;
    std::fs::create_dir_all(configured.parent().expect("configured parent"))?;
    std::fs::create_dir_all(&cwd)?;
    std::fs::create_dir_all(&memories)?;
    std::fs::write(&global, "g".repeat(4_976))?;
    std::fs::write(&configured, "d".repeat(4_739))?;
    std::fs::write(&project, "p".repeat(4_200))?;

    chat.config.memory_dir = memories.abs();
    chat.config.cwd = cwd.abs();
    let config_toml_path = root.path().join("config.toml").abs();
    chat.config.config_layer_stack = ConfigLayerStack::default().with_user_config(
        &config_toml_path,
        toml::from_str::<TomlValue>(&format!(
            "[skills]\ndev_rule_roots = [{}]\n",
            toml::Value::String(configured.parent().expect("configured root").display().to_string())
                .to_string(),
        ))
        .expect("development-rule config"),
    );
    chat.instruction_source_paths = vec![
        codex_utils_path_uri::PathUri::from_abs_path(&global.abs()),
        codex_utils_path_uri::PathUri::from_abs_path(&project.abs()),
    ];
    chat.last_rendered_width.set(Some(120));
    seed_manual_memory_cache_from_disk(&mut chat)?;

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Down)));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('w'))));
    let rendered = render_ledger(&chat, 100);

    assert!(rendered.contains("≈"), "token estimates must stay labeled");
    for estimate in ["≈1,244 est. tokens", "≈1,185 est. tokens", "≈1,050 est. tokens"] {
        assert!(rendered.contains(estimate), "missing {estimate}:\n{rendered}");
    }
    assert!(rendered.contains("Origin: configured development rules"));
    assert!(rendered.contains(
        "Size: 4,739 bytes · Estimate: ≈1,185 tokens (trimmed characters ÷ 4, capped)"
    ));
    assert!(rendered.contains("› [x]"));
    assert!(rendered.contains("INCLUDED"));
    assert!(rendered.contains("Lifetime: every turn"));
    assert!(rendered.contains(&format!("Source: {}", configured.canonicalize()?.display())));
    Ok(())
}

#[tokio::test]
async fn ledger_file_rows_emit_real_file_hyperlinks() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;

    let rendered = render_ledger_buffer(&chat, 80);
    let hyperlink_prefix = format!("\u{1b}]8;;file://{}", root.path().display());
    assert!(
        rendered
            .content()
            .iter()
            .any(|cell| cell.symbol().contains(&hyperlink_prefix)),
        "underlining alone is not clickable; expected an OSC 8 file link"
    );
    Ok(())
}

#[tokio::test]
async fn manual_memory_ledger_render_stays_on_cached_sources_after_disk_changes(
) -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, _cwd) = configure_ledger_sources(&mut chat, root.path())?;
    let before = render_ledger(&chat, 80);

    std::fs::write(memories.join("MEMORY.md"), "changed memory".repeat(400))?;
    std::fs::write(
        root.path().join("projects/skills/dev/SKILL.md"),
        "changed development rules".repeat(400),
    )?;

    assert_eq!(render_ledger(&chat, 80), before);
    Ok(())
}

#[tokio::test]
async fn ledger_g_sequences_exclude_and_include_all_selectable_sources() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;
    std::fs::remove_file(memories.join("MEMORY.md"))?;
    let custom_memory_source = memories.join("custom-context.md");
    std::fs::write(&custom_memory_source, "custom context inside the memory directory")?;
    crate::legacy_core::elpis_context::add_continuity_source(
        Some(&memories),
        &cwd,
        &custom_memory_source,
    )?;
    seed_manual_memory_cache_from_disk(&mut chat)?;
    let manual_memory_path = chat
        .manual_memory_bound_target()
        .expect("manual-memory target")
        .view
        .memory_path
        .clone();
    let custom_memory_source = custom_memory_source.canonicalize()?;
    assert!(chat.continuity_sources().iter().any(|source| {
        source.path == custom_memory_source
            && source.category
                == crate::legacy_core::elpis_context::ContinuitySourceCategory::Memory
    }));
    let manual_memory_admitted = chat
        .continuity_sources()
        .iter()
        .find(|source| source.path == manual_memory_path)
        .expect("manual-memory row")
        .admitted;
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab));

    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('g')));
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('e')));
    assert_eq!(chat.manual_memory_phase(), ManualMemoryPhase::Loading);
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::ManualMemoryStatusRefreshRequested(_))
    ));
    assert!(rx.try_recv().is_err(), "bulk exclude must refresh exactly once");
    seed_manual_memory_cache_from_disk(&mut chat)?;
    assert!(
        chat.continuity_sources()
            .iter()
            .filter(|source| source.selectable && source.path != manual_memory_path)
            .all(|source| !source.admitted)
    );

    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('g')));
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('i')));
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::ManualMemoryStatusRefreshRequested(_))
    ));
    assert!(rx.try_recv().is_err(), "bulk include must refresh exactly once");
    seed_manual_memory_cache_from_disk(&mut chat)?;
    assert!(
        chat.continuity_sources()
            .iter()
            .filter(|source| source.selectable && source.path != manual_memory_path)
            .all(|source| source.admitted)
    );

    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('i')));
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::ManualMemoryStatusRefreshRequested(_))
    ));
    assert!(rx.try_recv().is_err(), "i must refresh exactly once");
    seed_manual_memory_cache_from_disk(&mut chat)?;
    assert!(
        chat.continuity_sources()
            .iter()
            .filter(|source| source.selectable && source.path != manual_memory_path)
            .all(|source| !source.admitted),
        "i must exclude actionable rows even when the canonical Memory row is not admitted"
    );

    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('i')));
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::ManualMemoryStatusRefreshRequested(_))
    ));
    assert!(rx.try_recv().is_err(), "i must refresh exactly once");
    seed_manual_memory_cache_from_disk(&mut chat)?;
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('g')));
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('i')));
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::ManualMemoryStatusRefreshRequested(_))
    ));
    assert!(rx.try_recv().is_err(), "g i must refresh exactly once");
    seed_manual_memory_cache_from_disk(&mut chat)?;
    assert!(
        chat.continuity_sources()
            .iter()
            .filter(|source| source.selectable && source.path != manual_memory_path)
            .all(|source| !source.admitted),
        "g i must use the same actionable rows as the bulk writer"
    );
    assert_eq!(
        chat.continuity_sources()
            .iter()
            .find(|source| source.path == manual_memory_path)
            .expect("manual-memory row")
            .admitted,
        manual_memory_admitted,
        "a missing canonical Memory row is not an admission action"
    );
    Ok(())
}

#[tokio::test]
async fn manual_memory_bulk_enqueues_memory_last_and_uses_its_mandatory_refresh(
) -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab));

    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('g')));
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('i')));

    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, AppEvent::ManualMemoryAdmissionRequested(_, true)))
            .count(),
        1
    );
    assert!(events.iter().all(|event| !matches!(
        event,
        AppEvent::ManualMemoryStatusRefreshRequested(_)
    )));
    assert_eq!(
        chat.manual_memory_pending_mutation(),
        Some(ManualMemoryMutation::Admission { admitted: true })
    );
    Ok(())
}

#[tokio::test]
async fn manual_memory_bulk_first_error_invalidates_once() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;
    let workspace = crate::legacy_core::elpis_context::workspace_context_dir(
        Some(&memories),
        &cwd,
    )
    .expect("workspace context directory");
    std::fs::write(workspace.join("admission.toml"), "not valid = [")?;
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab));

    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('g')));
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('e')));

    assert_eq!(chat.manual_memory_phase(), ManualMemoryPhase::Loading);
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, AppEvent::ManualMemoryStatusRefreshRequested(_)))
            .count(),
        1,
        "a first-row bulk error must still request exactly one refresh"
    );
    assert!(events.iter().any(|event| matches!(event, AppEvent::InsertHistoryCell(_))));
    Ok(())
}

#[tokio::test]
async fn manual_memory_remove_refreshes_for_custom_memory_dir_source_but_not_discovered_row(
) -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;
    let custom = memories.join("removable-context.md");
    std::fs::write(&custom, "removable custom context")?;
    crate::legacy_core::elpis_context::add_continuity_source(Some(&memories), &cwd, &custom)?;
    seed_manual_memory_cache_from_disk(&mut chat)?;
    let custom = custom.canonicalize()?;
    let selectable_count = chat
        .continuity_sources()
        .iter()
        .filter(|source| source.selectable)
        .count();
    assert!(chat.continuity_sources().iter().any(|source| {
        source.path == custom
            && source.category
                == crate::legacy_core::elpis_context::ContinuitySourceCategory::Memory
    }));

    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab));
    for _ in 1..selectable_count {
        chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Down));
    }
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Delete));
    assert_eq!(chat.manual_memory_phase(), ManualMemoryPhase::Loading);
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::ManualMemoryStatusRefreshRequested(_))
    ));
    assert!(rx.try_recv().is_err());

    seed_manual_memory_cache_from_disk(&mut chat)?;
    assert!(!chat
        .continuity_sources()
        .iter()
        .any(|source| source.path == custom));
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Delete));
    assert_eq!(chat.manual_memory_phase(), ManualMemoryPhase::Ready);
    assert!(
        std::iter::from_fn(|| rx.try_recv().ok()).all(|event| !matches!(
            event,
            AppEvent::ManualMemoryStatusRefreshRequested(_)
        )),
        "remove Ok(false) must not invalidate the cache"
    );

    std::fs::write(&custom, "removable custom context")?;
    crate::legacy_core::elpis_context::add_continuity_source(Some(&memories), &cwd, &custom)?;
    seed_manual_memory_cache_from_disk(&mut chat)?;
    let selectable_count = chat
        .continuity_sources()
        .iter()
        .filter(|source| source.selectable)
        .count();
    for _ in 1..selectable_count {
        chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Down));
    }
    let workspace = crate::legacy_core::elpis_context::workspace_context_dir(
        Some(&memories),
        &cwd,
    )
    .expect("workspace context directory");
    std::fs::write(workspace.join("admission.toml"), "not valid = [")?;
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Delete));
    assert_eq!(chat.manual_memory_phase(), ManualMemoryPhase::Loading);
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, AppEvent::ManualMemoryStatusRefreshRequested(_)))
            .count(),
        1,
        "remove error must request exactly one refresh"
    );
    assert!(events.iter().any(|event| matches!(event, AppEvent::InsertHistoryCell(_))));
    Ok(())
}

#[tokio::test]
async fn ledger_dedupes_manually_added_file_that_is_already_a_rule() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;

    let dev_rule = root.path().join("projects/skills/dev/SKILL.md");
    crate::legacy_core::elpis_context::add_continuity_source(Some(&memories), &cwd, &dev_rule)?;
    seed_manual_memory_cache_from_disk(&mut chat)?;

    let sources = chat.continuity_sources();
    let rows = sources
        .iter()
        .filter(|source| {
            source
                .path
                .canonicalize()
                .ok()
                .zip(dev_rule.canonicalize().ok())
                .is_some_and(|(a, b)| a == b)
        })
        .count();
    assert_eq!(
        rows, 1,
        "a /add-ed file already admitted as a rule must appear exactly once"
    );
    Ok(())
}

#[tokio::test]
async fn ledger_and_status_read_the_same_source_list() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    let (_memories, _cwd) = configure_ledger_sources(&mut chat, root.path())?;

    let sources = chat.continuity_sources();
    // Every runtime instruction and configured development rule must appear as a row.
    for name in ["Global AGENTS.md", "Project AGENTS.md", "dev/SKILL.md"] {
        assert!(
            sources.iter().any(|source| source.name == name),
            "missing row {name}"
        );
    }
    // And the rendered panel shows them all too.
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab));
    let rendered = render_ledger(&chat, 80);
    for name in ["Global AGENTS.md", "Project AGENTS.md", "dev/SKILL.md"] {
        assert!(rendered.contains(name), "panel hides {name}:\n{rendered}");
    }
    Ok(())
}

#[tokio::test]
async fn full_widget_render_keeps_context_ledger_visible() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;

    let area = ratatui::layout::Rect::new(0, 0, 120, 80);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    Renderable::render(&chat, area, &mut buf);
    let rendered = buf
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("CONTEXT LEDGER"));
    Ok(())
}
