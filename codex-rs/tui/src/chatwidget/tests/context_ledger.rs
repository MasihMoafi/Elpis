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
async fn manual_memory_create_key_emits_once_and_blocks_same_loop_duplicates() -> anyhow::Result<()>
{
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
    assert_matches!(rx.try_recv(), Ok(AppEvent::ManualMemoryCreateRequested(_)));
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

    assert!(
        chat.handle_context_ledger_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT,))
    );
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
async fn manual_memory_mutation_excludes_ordinary_and_add_writers_before_disk_io()
-> anyhow::Result<()> {
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
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;
    let user_file = root.path().join("user-notes.md");
    std::fs::write(&user_file, "Manually selected context")?;
    crate::legacy_core::elpis_context::add_continuity_source(Some(&memories), &cwd, &user_file)?;
    seed_manual_memory_cache_from_disk(&mut chat)?;

    let unfocused = render_ledger(&chat, 80);
    assert!(unfocused.contains("Tab focus"));
    assert!(unfocused.contains("Ctrl+click open file"));

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('w'))));
    let rendered = render_ledger(&chat, 80);

    // GOAL.md and ES.md both carry the session forward, so they share one category and
    // there is no separate evidence heading.
    for heading in [
        "SESSION CONTINUITY",
        "USER FILES",
        "DURABLE MEMORY",
        "INSTRUCTIONS",
    ] {
        assert!(rendered.contains(heading), "missing {heading}:\n{rendered}");
    }
    assert!(rendered.contains("user-notes.md"));
    assert!(rendered.contains("≈"), "token estimates must be labeled");
    assert!(rendered.contains("Up/Down move"));
    assert!(rendered.contains("Space/Enter toggle"));
    assert!(rendered.contains("WHY INCLUDED"));
    assert!(rendered.contains("applicable"), "{rendered}");
    assert!(rendered.contains("global rules"), "{rendered}");
    assert!(
        rendered.contains("dev/SKILL.md"),
        "configured development rule must render as its own row:\n{rendered}"
    );

    let short = render_ledger(&chat, 16);
    assert!(short.contains("Global AGENTS.md"));
    assert!(short.contains("WHY INCLUDED"));
    assert!(short.contains("applicable"));
    assert!(short.contains("global rules"));
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
            toml::Value::String(
                configured
                    .parent()
                    .expect("configured root")
                    .display()
                    .to_string()
            )
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
    let rendered = render_ledger(&chat, 100);

    assert!(rendered.contains("≈"), "token estimates must stay labeled");
    for estimate in [
        "≈1,244 est. tokens",
        "≈1,185 est. tokens",
        "≈1,050 est. tokens",
    ] {
        assert!(
            rendered.contains(estimate),
            "missing {estimate}:\n{rendered}"
        );
    }
    assert!(rendered.contains("Global AGENTS.md"));
    assert!(rendered.contains("Project AGENTS.md"));
    assert!(rendered.contains("dev/AGENTS.md"));
    assert!(rendered.contains("INCLUDED"));
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
async fn clicking_es_toggles_es_instead_of_the_row_above() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;
    crate::legacy_core::elpis_context::set_continuity_source_admitted(
        Some(&memories),
        &cwd,
        "GOAL.md",
        true,
    )?;
    crate::legacy_core::elpis_context::set_continuity_source_admitted(
        Some(&memories),
        &cwd,
        "ES.md",
        true,
    )?;
    seed_manual_memory_cache_from_disk(&mut chat)?;

    let buffer = render_ledger_buffer(&chat, 80);
    let es_row = (0..80)
        .find(|row| {
            (0..52)
                .map(|column| buffer[(column, *row)].symbol())
                .collect::<String>()
                .contains("ES.md")
        })
        .expect("rendered ES.md row");
    assert!(chat.handle_context_ledger_mouse_click(es_row, 8));
    seed_manual_memory_cache_from_disk(&mut chat)?;

    let sources = chat.continuity_sources();
    assert!(
        sources
            .iter()
            .find(|source| source.name == "GOAL.md")
            .expect("GOAL.md")
            .admitted
    );
    assert!(
        !sources
            .iter()
            .find(|source| source.name == "ES.md")
            .expect("ES.md")
            .admitted
    );
    Ok(())
}

#[tokio::test]
async fn active_turn_exclusion_waits_for_boundary_without_inflating_conversation_context()
-> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;
    crate::legacy_core::elpis_context::set_continuity_source_admitted(
        Some(&memories),
        &cwd,
        "GOAL.md",
        true,
    )?;
    crate::legacy_core::elpis_context::set_continuity_source_admitted(
        Some(&memories),
        &cwd,
        "ES.md",
        true,
    )?;
    let admission_path =
        crate::legacy_core::elpis_context::workspace_context_dir(Some(&memories), &cwd)
            .expect("workspace context")
            .join("admission.toml");
    let admission_before_toggle = std::fs::read(&admission_path)?;
    seed_manual_memory_cache_from_disk(&mut chat)?;
    for source in &mut chat.manual_memory_cache.sources {
        source.estimated_tokens = match source.name.as_str() {
            "GOAL.md" => 600,
            "ES.md" => 400,
            _ => 0,
        };
    }
    chat.turn_lifecycle.last_turn_id = Some("turn-1".to_string());
    chat.set_token_info(Some(make_token_info(10_000, 20_000)));
    chat.bottom_pane.set_task_running(/*running*/ true);

    let before = render_ledger(&chat, 80);
    assert!(before.contains("≈10.0k tokens in context"));
    assert!(before.contains("Conversation + built-in context"));
    assert!(before.contains("≈9.0k tokens"), "{before}");

    let buffer = render_ledger_buffer(&chat, 80);
    let es_row = (0..80)
        .find(|row| {
            (0..52)
                .map(|column| buffer[(column, *row)].symbol())
                .collect::<String>()
                .contains("ES.md")
        })
        .expect("rendered ES.md row");
    assert!(chat.handle_context_ledger_mouse_click(es_row, 8));

    let after = render_ledger(&chat, 80);
    assert!(
        after.contains("≈10.0k tokens now · changes queued"),
        "{after}"
    );
    assert!(after.contains("Conversation + built-in context"));
    assert!(after.contains("≈9.0k tokens"), "{after}");
    assert!(
        !chat
            .continuity_sources()
            .iter()
            .find(|source| source.name == "ES.md")
            .expect("ES.md")
            .admitted
    );
    assert_eq!(
        std::fs::read(&admission_path)?,
        admission_before_toggle,
        "an active-turn toggle must not alter the context captured by that turn"
    );

    // A usage update from the already-running turn still reflects the old
    // admission policy. It may add real conversation/runtime tokens, but it must not
    // pretend the queued exclusion has already changed this request.
    chat.reconcile_context_projection_for_turn("turn-1");
    chat.set_token_info(Some(make_token_info(10_200, 20_000)));
    let during_old_turn = render_ledger(&chat, 80);
    assert!(
        during_old_turn.contains("≈10.2k tokens now · changes queued"),
        "{during_old_turn}"
    );
    assert!(
        during_old_turn.contains("≈9.2k tokens"),
        "{during_old_turn}"
    );

    handle_turn_completed(&mut chat, "turn-1", /*duration_ms*/ None);
    assert_ne!(std::fs::read(&admission_path)?, admission_before_toggle);
    let after_boundary = render_ledger(&chat, 80);
    assert!(
        after_boundary.contains("next request ≈9.8k tokens"),
        "{after_boundary}"
    );
    assert!(after_boundary.contains("≈9.2k tokens"), "{after_boundary}");

    chat.reconcile_context_projection_for_turn("turn-2");
    chat.set_token_info(Some(make_token_info(9_800, 20_000)));
    let next_exact_snapshot = render_ledger(&chat, 80);
    assert!(
        next_exact_snapshot.contains("≈9.8k tokens in context"),
        "{next_exact_snapshot}"
    );
    assert!(
        next_exact_snapshot.contains("≈9.2k tokens"),
        "{next_exact_snapshot}"
    );
    Ok(())
}

#[tokio::test]
async fn active_turn_toggle_back_to_original_cancels_the_queued_write() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;
    crate::legacy_core::elpis_context::set_continuity_source_admitted(
        Some(&memories),
        &cwd,
        "ES.md",
        true,
    )?;
    seed_manual_memory_cache_from_disk(&mut chat)?;
    let admission_path =
        crate::legacy_core::elpis_context::workspace_context_dir(Some(&memories), &cwd)
            .expect("workspace context")
            .join("admission.toml");
    let before = std::fs::read(&admission_path)?;
    chat.bottom_pane.set_task_running(/*running*/ true);
    chat.last_rendered_width.set(Some(120));
    assert!(
        chat.handle_context_ledger_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT,))
    );
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Down)));

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char(' '))));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char(' '))));

    assert!(chat.context_ledger.pending_context_admissions.is_empty());
    assert_eq!(std::fs::read(&admission_path)?, before);
    assert!(
        chat.continuity_sources()
            .iter()
            .find(|source| source.name == "ES.md")
            .expect("ES.md")
            .admitted
    );
    Ok(())
}

#[tokio::test]
async fn grouped_project_rules_project_as_one_admission_key() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;
    let override_path = cwd.join("AGENTS.override.md");
    std::fs::write(&override_path, "More project instructions")?;
    chat.instruction_source_paths
        .push(codex_utils_path_uri::PathUri::from_abs_path(
            &override_path.abs(),
        ));
    crate::legacy_core::elpis_context::set_continuity_source_admitted(
        Some(&memories),
        &cwd,
        "Project AGENTS.md",
        true,
    )?;
    seed_manual_memory_cache_from_disk(&mut chat)?;

    let mut project_tokens = [600, 900].into_iter();
    for source in &mut chat.manual_memory_cache.sources {
        source.estimated_tokens = if source.name == "Project AGENTS.md" {
            project_tokens.next().expect("two project-rule rows")
        } else {
            0
        };
    }
    assert!(
        project_tokens.next().is_none(),
        "expected two project-rule rows"
    );
    chat.set_token_info(Some(make_token_info(10_000, 20_000)));
    chat.bottom_pane.set_task_running(/*running*/ true);

    let rendered = render_ledger(&chat, 200);
    assert!(rendered.contains("Project AGENTS.md"), "{rendered}");
    let buffer = render_ledger_buffer(&chat, 200);
    let project_row = (0..200)
        .find(|row| {
            (0..52)
                .fold(String::new(), |mut line, column| {
                    line.push_str(&crate::terminal_hyperlinks::strip_osc8(
                        buffer[(column, *row)].symbol(),
                    ));
                    line
                })
                .contains("Project AGENTS.md")
        })
        .expect("rendered project-rule row");
    assert!(chat.handle_context_ledger_mouse_click(project_row, 8));
    assert!(render_ledger(&chat, 200).contains("≈8.5k tokens"));

    handle_turn_completed(&mut chat, "turn-1", /*duration_ms*/ None);
    let after_boundary = render_ledger(&chat, 200);
    assert!(
        after_boundary.contains("next request ≈8.5k tokens"),
        "{after_boundary}"
    );
    assert!(
        chat.manual_memory_cache
            .sources
            .iter()
            .filter(|source| source.name == "Project AGENTS.md")
            .all(|source| !source.admitted)
    );

    let buffer = render_ledger_buffer(&chat, 200);
    let project_row = (0..200)
        .find(|row| {
            (0..52)
                .fold(String::new(), |mut line, column| {
                    line.push_str(&crate::terminal_hyperlinks::strip_osc8(
                        buffer[(column, *row)].symbol(),
                    ));
                    line
                })
                .contains("Project AGENTS.md")
        })
        .expect("rendered project-rule row");
    assert!(chat.handle_context_ledger_mouse_click(project_row, 8));
    assert_eq!(chat.context_ledger.projected_token_delta, 0);
    assert!(
        chat.manual_memory_cache
            .sources
            .iter()
            .filter(|source| source.name == "Project AGENTS.md")
            .all(|source| source.admitted)
    );
    Ok(())
}

#[tokio::test]
async fn durable_memory_is_counted_and_its_toggle_projects_free_space() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;
    crate::legacy_core::elpis_context::set_continuity_source_admitted(
        Some(&memories),
        &cwd,
        "MEMORY.md",
        true,
    )?;
    seed_manual_memory_cache_from_disk(&mut chat)?;
    chat.manual_memory_cache
        .sources
        .iter_mut()
        .find(|source| source.name == "MEMORY.md")
        .expect("MEMORY.md")
        .estimated_tokens = 800;
    chat.set_token_info(Some(make_token_info(10_000, 20_000)));

    let before = render_ledger(&chat, 80);
    assert!(
        before.contains("DURABLE MEMORY  ≈800 tokens admitted"),
        "{before}"
    );
    assert!(
        before.contains("Conversation + built-in context"),
        "{before}"
    );
    assert!(before.contains("≈9.2k tokens"), "{before}");
    while rx.try_recv().is_ok() {}

    chat.last_rendered_width.set(Some(120));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));
    let buffer = render_ledger_buffer(&chat, 80);
    let memory_row = (0..80)
        .find(|row| {
            (0..52)
                .map(|column| buffer[(column, *row)].symbol())
                .collect::<String>()
                .contains("MEMORY.md")
        })
        .expect("rendered MEMORY.md row");
    assert!(chat.handle_context_ledger_mouse_click(memory_row, 8));

    let queued = render_ledger(&chat, 80);
    assert!(
        queued.contains("≈10.0k tokens now · saving change"),
        "{queued}"
    );
    assert!(queued.contains("≈9.2k tokens"), "{queued}");
    let target = std::iter::from_fn(|| rx.try_recv().ok())
        .find_map(|event| match event {
            AppEvent::ManualMemoryAdmissionRequested(target, false) => Some(target),
            _ => None,
        })
        .expect("manual-memory exclusion request");
    crate::legacy_core::elpis_context::set_continuity_source_admitted(
        Some(&memories),
        &cwd,
        "MEMORY.md",
        false,
    )?;
    let status = crate::legacy_core::elpis_context::manual_memory_status(
        Some(memories.as_path()),
        cwd.as_path(),
    )?
    .expect("manual-memory status");
    let mut sources =
        crate::legacy_core::elpis_context::continuity_sources_from_manual_memory_status(
            Some(memories.as_path()),
            cwd.as_path(),
            &chat.instruction_source_paths_as_path_bufs(),
            &chat.config_ref().dev_rule_roots(),
            Some(&status),
        )?;
    sources
        .iter_mut()
        .find(|source| source.name == "MEMORY.md")
        .expect("MEMORY.md")
        .estimated_tokens = 800;
    assert!(chat.apply_manual_memory_status_completion(
        &target,
        ManualMemoryStatusCompletion::Ready { status, sources },
    ));
    chat.clear_manual_memory_pending_mutation();

    let after = render_ledger(&chat, 80);
    assert!(after.contains("next request ≈9.2k tokens"), "{after}");
    assert!(after.contains("Conversation + built-in context"), "{after}");
    assert!(after.contains("≈9.2k tokens"), "{after}");
    Ok(())
}

#[tokio::test]
async fn manual_memory_ledger_render_stays_on_cached_sources_after_disk_changes()
-> anyhow::Result<()> {
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
    std::fs::write(
        &custom_memory_source,
        "custom context inside the memory directory",
    )?;
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
    assert!(
        rx.try_recv().is_err(),
        "bulk exclude must refresh exactly once"
    );
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
    assert!(
        rx.try_recv().is_err(),
        "bulk include must refresh exactly once"
    );
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
async fn manual_memory_bulk_enqueues_memory_last_and_uses_its_mandatory_refresh()
-> anyhow::Result<()> {
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
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, AppEvent::ManualMemoryStatusRefreshRequested(_)))
    );
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
    let workspace = crate::legacy_core::elpis_context::workspace_context_dir(Some(&memories), &cwd)
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
    assert!(
        events
            .iter()
            .any(|event| matches!(event, AppEvent::InsertHistoryCell(_)))
    );
    Ok(())
}

#[tokio::test]
async fn manual_memory_remove_refreshes_for_custom_memory_dir_source_but_not_discovered_row()
-> anyhow::Result<()> {
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
    assert!(
        !chat
            .continuity_sources()
            .iter()
            .any(|source| source.path == custom)
    );
    chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Delete));
    assert_eq!(chat.manual_memory_phase(), ManualMemoryPhase::Ready);
    assert!(
        std::iter::from_fn(|| rx.try_recv().ok())
            .all(|event| !matches!(event, AppEvent::ManualMemoryStatusRefreshRequested(_))),
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
    let workspace = crate::legacy_core::elpis_context::workspace_context_dir(Some(&memories), &cwd)
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
    assert!(
        events
            .iter()
            .any(|event| matches!(event, AppEvent::InsertHistoryCell(_)))
    );
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

#[tokio::test]
async fn ledger_renders_smart_prune_switch_in_both_states() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;

    let syncing = render_ledger(&chat, 30);
    assert!(syncing.contains("SMART PRUNE"));
    assert!(syncing.contains("SYNC"));
    assert!(syncing.contains("Reading current thread state"));
    assert!(!syncing.contains(" OFF"));

    chat.smart_prune_synced = true;
    let off = render_ledger(&chat, 30);
    assert!(off.contains("[●━━━] OFF"));
    assert!(off.contains("Tool results pass through unchanged"));

    assert!(chat.set_feature_enabled(Feature::AutomaticContextPruning, true));
    let pending = render_ledger(&chat, 30);
    assert!(
        pending.contains("[●━━━] OFF"),
        "a persisted user-layer request must not be shown as the core-effective state"
    );

    chat.smart_prune.enabled = true;
    let on = render_ledger(&chat, 30);
    assert!(on.contains("[━━━●] ON"));
    assert!(on.contains("Before first main-model send"));

    chat.smart_prune.examined_outputs = 3;
    chat.smart_prune.admitted_outputs = 2;
    chat.smart_prune.failed_batches = 1;
    chat.smart_prune.approx_source_tokens = 4_000;
    chat.smart_prune.approx_admitted_tokens = 700;
    chat.smart_prune.approx_saved_tokens = 3_300;
    chat.smart_prune.latest = Some(
        codex_app_server_protocol::ThreadSmartPruneAdmissionSnapshot {
            admission_id: "019d0000-example".to_string(),
            audit_path: "smart-prune/admissions/019d0000-example".to_string(),
            examined_outputs: 3,
            admitted_outputs: 2,
            approx_source_tokens: 4_000,
            approx_admitted_tokens: 700,
            approx_saved_tokens: 3_300,
            request_sequence: Some(2),
            request_input_sha256: Some("abc123".to_string()),
            request_linkage_verified: true,
            response_id: Some("response-2".to_string()),
            response_usage: None,
            response_linkage_verified: true,
        },
    );
    let evidenced = render_ledger(&chat, 30);
    assert!(evidenced.contains("2 of 3 eligible outputs shortened"));
    assert!(evidenced.contains("≈3.3k"));
    assert!(evidenced.contains("saved"));
    assert!(!evidenced.contains("failed"));
    assert!(!evidenced.contains("≈4.0k→≈700"));
    assert!(evidenced.contains("Latest 019d0000 · response linked"));

    chat.bottom_pane.set_task_running(/*running*/ true);
    let busy = render_ledger(&chat, 30);
    assert!(busy.contains("active turn unchanged"));
}

#[tokio::test]
async fn focused_ledger_p_requests_next_turn_toggle_even_without_sources() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.last_rendered_width.set(Some(120));
    chat.smart_prune_synced = true;
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('p'))));
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::UpdateFeatureFlags { updates })
            if updates == vec![(Feature::AutomaticContextPruning, true)]
    ));
    assert!(
        !chat
            .config
            .features
            .enabled(Feature::AutomaticContextPruning),
        "the switch must wait for durable persistence before changing"
    );
}

#[tokio::test]
async fn focused_ledger_p_toggles_from_authoritative_snapshot_when_layers_differ() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.last_rendered_width.set(Some(120));
    assert!(
        !chat
            .config
            .features
            .enabled(Feature::AutomaticContextPruning),
        "the fixture must exercise a higher-precedence effective state"
    );
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('p'))));
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, AppEvent::UpdateFeatureFlags { .. }))
    );
    assert!(events.iter().any(|event| matches!(
        event,
        AppEvent::InsertHistoryCell(cell)
            if lines_to_single_string(&cell.display_lines(/*width*/ 80))
                .contains("still syncing")
    )));

    let thread_id = ThreadId::new();
    chat.thread_id = Some(thread_id);
    let mut smart_prune = codex_app_server_protocol::ThreadSmartPruneSnapshot::default();
    smart_prune.enabled = true;
    chat.handle_server_notification(
        codex_app_server_protocol::ServerNotification::ThreadSmartPruneUpdated(
            codex_app_server_protocol::ThreadSmartPruneUpdatedNotification {
                thread_id: thread_id.to_string(),
                smart_prune,
            },
        ),
        /*replay_kind*/ None,
    );
    let _ = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('p'))));
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::UpdateFeatureFlags { updates })
            if updates == vec![(Feature::AutomaticContextPruning, false)]
    ));
}

#[tokio::test]
async fn focused_ledger_p_updates_immediately_during_active_turn() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.last_rendered_width.set(Some(120));
    chat.smart_prune_synced = true;
    chat.bottom_pane.set_task_running(/*running*/ true);
    assert!(
        chat.handle_context_ledger_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT,))
    );

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('p'))));
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::UpdateFeatureFlags { updates })
            if updates == vec![(Feature::AutomaticContextPruning, true)]
    ));
    let rendered = render_ledger(&chat, 30);
    assert!(rendered.contains("[━━━●] ON"), "{rendered}");
    assert!(rendered.contains("applies next turn"), "{rendered}");
    assert!(rendered.contains("active turn unchanged"), "{rendered}");
}

#[tokio::test]
async fn focused_ledger_p_ignores_repeat_while_setting_is_saving() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.last_rendered_width.set(Some(120));
    chat.smart_prune_synced = true;
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('p'))));
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::UpdateFeatureFlags { updates })
            if updates == vec![(Feature::AutomaticContextPruning, true)]
    ));

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('p'))));
    assert!(rx.try_recv().is_err());
    assert_eq!(chat.context_ledger.pending_smart_prune_enabled, Some(true));
    assert!(render_ledger(&chat, 30).contains("Saving"));
}

#[tokio::test]
async fn focused_ledger_p_updates_immediately_while_turn_start_is_pending() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.last_rendered_width.set(Some(120));
    chat.smart_prune_synced = true;
    chat.input_queue.user_turn_pending_start = true;
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));

    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('p'))));
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::UpdateFeatureFlags { updates })
            if updates == vec![(Feature::AutomaticContextPruning, true)]
    ));
    let rendered = render_ledger(&chat, 30);
    assert!(rendered.contains("[━━━●] ON"), "{rendered}");
    assert!(rendered.contains("applies next turn"), "{rendered}");
}

#[tokio::test]
async fn ledger_switch_mouse_hitbox_only_covers_the_switch() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.smart_prune_synced = true;
    let buffer = render_ledger_buffer(&chat, 30);
    let switch_cell = buffer
        .content()
        .iter()
        .enumerate()
        .find(|(_, cell)| cell.symbol() == "●")
        .map(|(index, _)| ((index / 52) as u16, (index % 52) as u16))
        .expect("switch knob");

    assert!(!chat.handle_context_ledger_mouse_click(switch_cell.0, 2));
    assert!(rx.try_recv().is_err());
    assert!(chat.handle_context_ledger_mouse_click(switch_cell.0, switch_cell.1));
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::UpdateFeatureFlags { updates })
            if updates == vec![(Feature::AutomaticContextPruning, true)]
    ));
}

#[tokio::test]
async fn ledger_switch_is_not_interactive_after_the_terminal_hides_it() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.smart_prune_synced = true;
    chat.last_rendered_width.set(Some(80));
    assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Tab)));

    let wide_area = ratatui::layout::Rect::new(0, 0, 80, 80);
    let mut wide_buffer = ratatui::buffer::Buffer::empty(wide_area);
    Renderable::render(&chat, wide_area, &mut wide_buffer);
    let switch_cell = wide_buffer
        .content()
        .iter()
        .enumerate()
        .find(|(_, cell)| cell.symbol() == "●")
        .map(|(index, _)| ((index / 80) as u16, (index % 80) as u16))
        .expect("switch knob");
    assert!(
        switch_cell.1 < 79,
        "test click must remain inside the narrower terminal"
    );

    let narrow_area = ratatui::layout::Rect::new(0, 0, 79, 80);
    let mut narrow_buffer = ratatui::buffer::Buffer::empty(narrow_area);
    Renderable::render(&chat, narrow_area, &mut narrow_buffer);

    assert!(!chat.handle_context_ledger_mouse_click(switch_cell.0, switch_cell.1));
    assert!(!chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Char('p'))));
    assert!(
        std::iter::from_fn(|| rx.try_recv().ok())
            .all(|event| !matches!(event, AppEvent::UpdateFeatureFlags { .. }))
    );
}

#[tokio::test]
async fn enabled_ledger_switch_keeps_textual_state_and_a_bold_knob() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.smart_prune_synced = true;
    chat.smart_prune.enabled = true;
    let buffer = render_ledger_buffer(&chat, 30);
    let switch = buffer
        .content()
        .windows(6)
        .find(|cells| cells.iter().map(|cell| cell.symbol()).collect::<String>() == "[━━━●]")
        .expect("enabled switch");

    assert!(switch[4].modifier.contains(Modifier::BOLD));
}
