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
const LEDGER_THREAD: &str = "019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e10";

const LEDGER_SCREENS: [(u16, u16); 3] = [(80, 24), (120, 40), (200, 60)];

fn ledger_screen(chat: &ChatWidget, width: u16, height: u16) -> Buffer {
    chat.last_rendered_width.set(Some(width));
    let screen = Rect::new(0, 0, width, height);
    let mut buffer = Buffer::empty(screen);
    let ledger_width = chat.context_ledger_width(width);
    chat.render_context_ledger_column(
        Rect::new(width - ledger_width, 0, ledger_width, height),
        &mut buffer,
    );
    chat.render_context_ledger_tab(screen, width, &mut buffer);
    buffer
}

fn ledger_mouse(
    kind: crossterm::event::MouseEventKind,
    x: u16,
    y: u16,
) -> crossterm::event::MouseEvent {
    crossterm::event::MouseEvent {
        kind,
        column: x,
        row: y,
        modifiers: KeyModifiers::NONE,
    }
}

#[tokio::test]
async fn a105_header_toggle_closes_and_half_hexagon_tab_reopens_at_each_size() {
    use crossterm::event::MouseButton::Left;
    use crossterm::event::MouseEventKind::Down;
    let (mut chat, _rx, _ops) = make_chatwidget_manual(None).await;
    for (width, height) in LEDGER_SCREENS {
        show_context_ledger(&mut chat);
        let buffer = ledger_screen(&chat, width, height);
        let lines = rows(&buffer, 0..width);
        let title = lines
            .iter()
            .position(|line| line.contains("CONTEXT LEDGER"))
            .unwrap();
        assert!(lines[title].contains("[━━━●] ON"), "{lines:#?}");
        assert!(!lines.join("\n").contains(['×', '╳', '✕']));
        assert!(!chat.handle_context_ledger_mouse(ledger_mouse(Down(Left), 0, title as u16)));
        assert!(chat.handle_context_ledger_mouse(ledger_mouse(
            Down(Left),
            width - 3,
            title as u16
        )));
        let closed = ledger_screen(&chat, width, height);
        let text = rows(&closed, 0..width).join("\n");
        assert!(!text.contains("CONTEXT LEDGER"));
        assert!(
            text.contains("[●━━━] OFF") && text.contains('╱') && text.contains('╲'),
            "{text}"
        );
        assert!(!chat.handle_context_ledger_mouse(ledger_mouse(Down(Left), width - 1, 0)));
        assert!(chat.handle_context_ledger_mouse(ledger_mouse(Down(Left), width - 2, height / 2)));
        assert!(rows(&ledger_screen(&chat, width, height), 0..width)[title].contains("[━━━●] ON"));
    }
}

#[tokio::test]
async fn a105_tab_clears_its_hitbox_when_the_transcript_has_fewer_than_three_rows() {
    use crossterm::event::MouseButton::Left;
    use crossterm::event::MouseEventKind::Down;
    let (mut chat, _rx, _ops) = make_chatwidget_manual(None).await;
    chat.close_context_ledger();
    let screen = Rect::new(0, 0, 80, 14);
    let mut buffer = Buffer::empty(screen);
    for height in [8, 2, 1, 0] {
        let transcript = Rect::new(0, 0, 79, height);
        buffer.content.iter_mut().for_each(|cell| {
            cell.set_symbol(".");
        });
        chat.render_context_ledger_tab(transcript, 80, &mut buffer);
        let text = rows(&buffer, 0..80);
        assert!(
            text.iter()
                .skip(usize::from(height))
                .all(|row| row == &".".repeat(80))
        );
        assert!(text.iter().all(|row| row.ends_with('.')));
        if height >= 3 {
            assert!(text.join("\n").contains("[●━━━] OFF"));
        } else {
            assert!(!text.join("\n").contains("[●━━━] OFF"));
            assert!(!chat.handle_context_ledger_mouse(ledger_mouse(Down(Left), 77, 3)));
        }
    }
}

#[tokio::test]
async fn a106_wheel_and_keys_reach_the_last_line_without_consuming_outside_wheels()
-> anyhow::Result<()> {
    use crossterm::event::MouseEventKind::{ScrollDown, ScrollUp};
    let root = tempdir()?;
    let (mut chat, _rx, _ops) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;
    let template = chat.manual_memory_cache.sources.last().unwrap().clone();
    for index in 0..70 {
        let mut source = template.clone();
        source.name = format!("tail-{index:02}.md");
        source.category = crate::legacy_core::elpis_context::ContinuitySourceCategory::Instructions;
        source.origin = "fixture".into();
        chat.manual_memory_cache.sources.push(source);
    }
    for (width, height) in LEDGER_SCREENS {
        show_context_ledger(&mut chat);
        let initial = ledger_screen(&chat, width, height);
        assert!(!rows(&initial, 0..width).join("\n").contains("tail-69.md"));
        assert!(rows(&initial, 0..width).join("\n").contains('↓'));
        assert!(!chat.handle_context_ledger_mouse(ledger_mouse(ScrollDown, 0, 3)));
        for _ in 0..300 {
            assert!(chat.handle_context_ledger_mouse(ledger_mouse(ScrollDown, width - 4, 3)));
        }
        let end = rows(&ledger_screen(&chat, width, height), 0..width).join("\n");
        assert!(end.contains("tail-69.md") && end.contains('↑'), "{end}");
        assert!(!end.contains('↓'), "at the end there is nothing below");
        assert!(
            end.lines().last().unwrap().contains("INCLUDED")
                || end.lines().last().unwrap().contains("EXCLUDED"),
            "the final metadata line is reachable: {end}"
        );
        for _ in 0..300 {
            assert!(chat.handle_context_ledger_mouse(ledger_mouse(ScrollUp, width - 4, 3)));
        }
        assert!(
            !rows(&ledger_screen(&chat, width, height), 0..width)
                .join("\n")
                .contains('↑')
        );
        chat.handle_context_ledger_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT));
        for _ in 0..100 {
            assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::PageDown)));
        }
        assert!(
            rows(&ledger_screen(&chat, width, height), 0..width)
                .join("\n")
                .contains("tail-69.md")
        );
        let end_offset = chat.context_ledger_scroll_offset();
        assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Up)));
        assert_eq!(chat.context_ledger_scroll_offset(), end_offset - 1);
        assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Down)));
        assert_eq!(chat.context_ledger_scroll_offset(), end_offset);
        assert!(chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::Home)));
        assert!(
            !rows(&ledger_screen(&chat, width, height), 0..width)
                .join("\n")
                .contains('↑')
        );
        chat.unfocus_context_ledger();
        assert!(!chat.handle_context_ledger_key_event(KeyEvent::from(KeyCode::PageDown)));
    }
    Ok(())
}

#[tokio::test]
async fn a107_details_follow_the_width_and_wrapped_height_budget() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _ops) = make_chatwidget_manual(None).await;
    configure_ledger_sources(&mut chat, root.path())?;
    token_usage_update(&mut chat, Some(planted_attribution()));
    let audit = chat
        .config
        .codex_home
        .join("logs/smart-prune/attempts/layout.json");
    std::fs::create_dir_all(audit.parent().unwrap())?;
    std::fs::write(&audit, "{}")?;
    chat.smart_prune_synced = true;
    chat.smart_prune.latest_attempt =
        Some(codex_app_server_protocol::ThreadSmartPruneAttemptSnapshot {
            attempt_id: "layout-fixture".into(),
            audit_path: Some("smart-prune/attempts/layout.json".into()),
            status: "unchanged".into(),
            failure_reason: None,
            model_slug: "gpt-6-luna".into(),
            reasoning_effort: "low".into(),
            candidate_outputs: 1,
            admitted_outputs: 0,
            approx_saved_tokens: 0,
            latency_ms: 100,
            usage: None,
        });
    for (width, height) in LEDGER_SCREENS {
        show_context_ledger(&mut chat);
        let text = rows(&ledger_screen(&chat, width, height), 0..width).join("\n");
        assert!(
            text.contains("SMART PRUNE")
                && text.contains("SUBAGENTS")
                && text.contains("CONTEXT WINDOW"),
            "{text}"
        );
        // At 120 columns the conversation retains 72 columns and the wrapped details fit
        // in 40 rows. Only the 80-column fixture needs the compact Ledger.
        let details_fit = width >= 120;
        assert_eq!(text.contains("Estimated segments"), details_fit, "{text}");
        assert_eq!(text.contains("User messages"), details_fit, "{text}");
        assert_eq!(text.contains("Last attempt"), details_fit, "{text}");
        assert_eq!(
            text.contains("Read attempt evidence"),
            details_fit,
            "{text}"
        );
    }
    // Height pressure also compacts a wide terminal; growing it restores details.
    let short = rows(&ledger_screen(&chat, 200, 12), 0..200).join("\n");
    assert!(!short.contains("Estimated segments") && !short.contains("User messages"));
    let tall = rows(&ledger_screen(&chat, 200, 60), 0..200).join("\n");
    assert!(tall.contains("Estimated segments") && tall.contains("User messages"));
    Ok(())
}

#[tokio::test]
async fn a106_empty_and_loading_panels_handle_arrows_and_clamp_without_a_source_cursor() {
    for (width, height) in LEDGER_SCREENS {
        let (mut chat, _events, _ops) = make_chatwidget_manual(None).await;
        show_context_ledger(&mut chat);
        chat.manual_memory_cache.sources.clear();
        ledger_screen(&chat, width, height);
        chat.handle_context_ledger_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT));
        for key in [
            KeyCode::Up,
            KeyCode::Down,
            KeyCode::PageDown,
            KeyCode::End,
            KeyCode::PageUp,
            KeyCode::Home,
        ] {
            assert!(chat.handle_context_ledger_key_event(KeyEvent::from(key)));
        }
        assert_eq!(chat.context_ledger_scroll_offset(), 0);
        let screen = rows(&ledger_screen(&chat, width, height), 0..width).join("\n");
        assert!(
            screen.contains("No portable context")
                && !screen.contains('↑')
                && !screen.contains('↓'),
            "{screen}"
        );
    }
}

fn luna_catalog(chat: &mut ChatWidget, max: bool) {
    let mut model = crate::test_support::TEST_MODEL_PRESETS
        .iter()
        .find(|model| model.model == "gpt-5.5")
        .expect("fixture model")
        .clone();
    model.id = "gpt-6-luna".into();
    model.model = "gpt-6-luna".into();
    model.display_name = "GPT-6-Luna".into();
    model.show_in_picker = true;
    model.supported_reasoning_efforts = [ReasoningEffortConfig::Low, ReasoningEffortConfig::Max]
        .into_iter()
        .filter(|effort| max || *effort != ReasoningEffortConfig::Max)
        .map(
            |effort| codex_protocol::openai_models::ReasoningEffortPreset {
                effort,
                description: String::new(),
            },
        )
        .collect();
    Arc::make_mut(&mut chat.model_catalog).models = vec![model];
}

#[tokio::test]
async fn a108_model_click_lists_catalog_efforts_and_saves_max_through_the_real_server()
-> anyhow::Result<()> {
    use codex_app_server_protocol::{
        ClientRequest, PrunerReadParams, PrunerReadResponse, RequestId,
    };
    for (width, height) in LEDGER_SCREENS {
        let root = tempdir()?;
        let (mut chat, mut rx, mut ops) = make_chatwidget_manual(None).await;
        configure_ledger_sources(&mut chat, root.path())?;
        luna_catalog(&mut chat, true);
        let chat_model = chat.config.model.clone();
        let home = chat.config.codex_home.to_path_buf();
        let server = Box::pin(crate::start_embedded_app_server_for_picker(&chat.config))
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let handle = server.request_handle();
        let settings: PrunerReadResponse = handle
            .request_typed(ClientRequest::PrunerRead {
                request_id: RequestId::String(uuid::Uuid::new_v4().to_string()),
                params: PrunerReadParams {},
            })
            .await?;
        show_context_ledger(&mut chat);
        let screen = ledger_screen(&chat, width, height);
        let model_y = rows(&screen, 0..width)
            .iter()
            .position(|line| line.contains("Choose model"))
            .unwrap();
        assert!(chat.handle_context_ledger_mouse(ledger_mouse(
            crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            width - chat.context_ledger_width(width) + 3,
            model_y as u16,
        )));
        let request = chat.context_ledger.pruner_request.get().unwrap();
        chat.finish_pruner_settings(request, true, Ok(settings));
        let mut picker = Buffer::empty(Rect::new(0, 0, width, height));
        chat.render(picker.area, &mut picker);
        let text = rows(&picker, 0..width).join("\n");
        assert!(
            text.contains("gpt-6-luna · low effort") && text.contains("gpt-6-luna · max effort"),
            "{text}"
        );
        // Search must retain the last effort too (the old searchable picker lost every row).
        for ch in "gpt-6-luna max".chars() {
            chat.handle_key_event(KeyEvent::from(KeyCode::Char(ch)));
        }
        assert!(render_bottom_popup(&chat, width).contains("gpt-6-luna · max effort"));
        chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
        let params = std::iter::from_fn(|| rx.try_recv().ok())
            .find_map(|event| match event {
                AppEvent::Elpis(ElpisAppEvent::SavePrunerModel(params)) => Some(params),
                AppEvent::UpdateModel(_) | AppEvent::UpdateReasoningEffort(_) => {
                    panic!("the chat model changed")
                }
                _ => None,
            })
            .expect("selecting Max sends an app-server write");
        assert_eq!(params.model.as_deref(), Some("gpt-6-luna"));
        assert_eq!(params.reasoning_effort, Some(ReasoningEffortConfig::Max));
        let saved: PrunerReadResponse = handle
            .request_typed(ClientRequest::PrunerWrite {
                request_id: RequestId::String(uuid::Uuid::new_v4().to_string()),
                params: params.clone(),
            })
            .await?;
        chat.finish_pruner_model_save(Ok(saved.clone()));
        assert_eq!(
            crate::legacy_core::pruner_settings::PrunerSettings::load(&home)?.reasoning_effort,
            Some(ReasoningEffortConfig::Max)
        );
        assert_eq!(chat.config.model, chat_model);
        assert!(ops.try_recv().is_err());
        let reread: PrunerReadResponse = handle
            .request_typed(ClientRequest::PrunerRead {
                request_id: RequestId::String(uuid::Uuid::new_v4().to_string()),
                params: PrunerReadParams {},
            })
            .await?;
        assert_eq!(reread, saved, "the next client sees the saved effort");
        // A stale picker cannot overwrite a newer setting, and its error is visible.
        let stale = handle
            .request_typed::<PrunerReadResponse>(ClientRequest::PrunerWrite {
                request_id: RequestId::String(uuid::Uuid::new_v4().to_string()),
                params,
            })
            .await
            .expect_err("the old version is rejected");
        chat.finish_pruner_model_save(Err(stale.to_string()));
        let errors = drain_insert_history(&mut rx)
            .iter()
            .map(|lines| lines_to_single_string(lines))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(errors.contains("Pruner model was not changed"), "{errors}");
        assert_eq!(
            crate::legacy_core::pruner_settings::PrunerSettings::load(&home)?.reasoning_effort,
            Some(ReasoningEffortConfig::Max)
        );
        server.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn a108_missing_catalog_unoffered_max_and_cancelled_or_failed_reads_never_invent_choices() {
    for (width, height) in LEDGER_SCREENS {
        let (mut chat, mut rx, _ops) = make_chatwidget_manual(None).await;
        show_context_ledger(&mut chat);
        Arc::make_mut(&mut chat.model_catalog).models.clear();
        ledger_screen(&chat, width, height);
        chat.open_pruner_model_popup();
        assert!(chat.bottom_pane.no_modal_or_popup_active());
        assert!(
            !std::iter::from_fn(|| rx.try_recv().ok())
                .any(|event| matches!(event, AppEvent::Elpis(ElpisAppEvent::SavePrunerModel(_))))
        );
        luna_catalog(&mut chat, false);
        let settings = codex_app_server_protocol::PrunerReadResponse {
            model: None,
            provider: None,
            reasoning_effort: None,
            version: "test-version".into(),
            providers: Vec::new(),
        };
        chat.open_pruner_model_popup();
        let request = chat.context_ledger.pruner_request.get().unwrap();
        chat.finish_pruner_settings(request, true, Ok(settings.clone()));
        let popup = render_bottom_popup(&chat, width);
        assert!(
            popup.contains("gpt-6-luna · low effort") && !popup.contains("max effort"),
            "{popup}"
        );
        chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
        chat.open_pruner_model_popup();
        let request = chat.context_ledger.pruner_request.get().unwrap();
        chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
        chat.finish_pruner_settings(request, true, Ok(settings));
        assert!(
            chat.bottom_pane.no_modal_or_popup_active(),
            "a cancelled read must not reopen the picker"
        );
        chat.open_pruner_model_popup();
        let request = chat.context_ledger.pruner_request.get().unwrap();
        chat.finish_pruner_settings(request, true, Err("fixture read rejected".into()));
        assert!(chat.bottom_pane.no_modal_or_popup_active());
    }
}

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

async fn status_during_ledger_load(has_agents: bool) -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.config.codex_home = AbsolutePathBuf::from_absolute_path(root.path().join("home"))?;
    chat.config.cwd = AbsolutePathBuf::from_absolute_path(root.path().join("project"))?;
    std::fs::create_dir_all(&chat.config.cwd)?;
    chat.instruction_source_paths.clear();
    if has_agents {
        let agents = chat.config.cwd.join("AGENTS.md");
        std::fs::write(&agents, "Follow the admitted project instructions.")?;
        chat.instruction_source_paths
            .push(codex_utils_path_uri::PathUri::from_abs_path(&agents));
        crate::legacy_core::elpis_context::set_continuity_source_admitted(
            Some(&elpis_memory_dir(chat.config_ref())),
            chat.config.cwd.as_path(),
            "Project AGENTS.md",
            true,
        )?;
    }
    let target = seed_ledger_from_disk(&mut chat)?;
    let status = chat
        .manual_memory_cache
        .status
        .clone()
        .expect("loaded status");
    let sources = chat.manual_memory_cache.sources.clone();
    assert_eq!(
        sources.iter().any(|source| source.admitted
            && source
                .path
                .file_name()
                .is_some_and(|name| name == "AGENTS.md")),
        has_agents,
    );
    chat.bind_manual_memory_loading(target.clone(), false, None);
    let cell = chat.status_output_cell(false, None);
    assert!(lines_to_single_string(&cell.display_lines(1_000)).contains("admitted: <none>"));
    assert!(chat.apply_manual_memory_status_completion(
        &target,
        ManualMemoryStatusCompletion::Ready { status, sources },
    ));
    // Inspect the same card that was opened while its sources were still loading.
    let rendered = lines_to_single_string(&cell.display_lines(1_000));
    let agents = rendered
        .lines()
        .find(|line| line.contains("Agents.md"))
        .unwrap();
    if has_agents {
        assert!(agents.contains("admitted: AGENTS.md"), "{agents}");
        assert!(!agents.contains("<none>"), "{agents}");
    } else {
        assert!(agents.contains("admitted: <none>"), "{agents}");
    }
    let copied = chat
        .transcript
        .last_status_copy_targets
        .as_ref()
        .unwrap()
        .handle
        .copy_text();
    let expected = if has_agents {
        "admitted: AGENTS.md"
    } else {
        "admitted: <none>"
    };
    assert!(copied.contains(expected), "{copied}");
    Ok(())
}

#[tokio::test]
async fn status_opened_before_ledger_load_updates_admitted_agents() -> anyhow::Result<()> {
    status_during_ledger_load(true).await
}

#[tokio::test]
async fn status_without_agents_still_reports_none_after_ledger_load() -> anyhow::Result<()> {
    status_during_ledger_load(false).await
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
async fn owned_ledger_title_stays_at_top_with_active_subagents() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    chat.set_agent_ledger(vec![crate::chatwidget::agent_ledger::AgentLedgerEntry {
        task: "Ledger child".to_string(),
        status: "Running",
        activity: Some("read-only fixture".to_string()),
    }]);
    for width in [28, 40, 52] {
        let area = Rect::new(0, 0, width, 160);
        let mut buffer = ratatui::buffer::Buffer::empty(area);
        chat.render_context_ledger_column(area, &mut buffer);
        let lines = rows(&buffer, 0..area.width);
        assert!(
            lines[0].contains("[━━━●] ON"),
            "the shared toggle stays at the top"
        );
        assert!(
            lines[0].contains("CONTEXT LEDGER"),
            "child activity must not displace the Ledger title"
        );
        let toggle = lines
            .iter()
            .position(|line| line.contains("SUBAGENTS"))
            .expect("subagent setting");
        let summary = lines
            .iter()
            .position(|line| line.contains("SUBAGENT LEDGER"))
            .expect("active child summary");
        let task = lines
            .iter()
            .position(|line| line.contains("Ledger child"))
            .expect("child task");
        let activity = lines
            .iter()
            .position(|line| line.contains("read-only fixture"))
            .expect("child activity");
        assert!(summary > toggle, "child summary follows SUBAGENTS");
        assert!(task > summary, "child task follows its summary");
        assert!(activity > task, "child activity follows its task");
    }
}

#[tokio::test]
async fn owned_ledger_without_subagents_omits_the_child_summary() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    let area = Rect::new(0, 0, 52, 160);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    chat.render_context_ledger_column(area, &mut buffer);
    let lines = rows(&buffer, 0..area.width);
    assert!(lines[0].contains("[━━━●] ON"));
    assert!(lines[0].contains("CONTEXT LEDGER"));
    assert!(!lines.iter().any(|line| line.contains("SUBAGENT LEDGER")));
}

#[tokio::test]
async fn owned_ledger_displays_complete_source_names_at_narrow_widths() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    let (memories, cwd) = configure_ledger_sources(&mut chat, root.path())?;
    let long_names = ["dev/CODING_GUIDELINES.md", "docs/数据数据_说明文档.md"];
    for relative in long_names {
        let path = cwd.join(relative);
        std::fs::create_dir_all(path.parent().expect("fixture parent"))?;
        std::fs::write(&path, "Long context filename fixture")?;
        crate::legacy_core::elpis_context::add_continuity_source(
            Some(&memories),
            &cwd,
            std::path::Path::new(relative),
        )?;
    }
    seed_ledger_from_disk(&mut chat)?;
    for width in [28, 32, 48, 52] {
        let area = Rect::new(0, 0, width, 180);
        let mut buffer = ratatui::buffer::Buffer::empty(area);
        chat.render_context_ledger_column(area, &mut buffer);
        let text = rows(&buffer, 0..width).join("\n");
        for name in ["MEMORY.md", "Global AGENTS.md", "Project AGENTS.md"] {
            assert!(
                text.contains(name),
                "complete {name} at width {width}:\n{text}"
            );
        }
        // Reconstruct wrapped file text from the body cells, excluding the decorative rule
        // and margins between rows. Wide-character continuation cells contain only spaces.
        let flattened = rows(&buffer, 2..width - 1)
            .join("")
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .collect::<String>();
        for relative in long_names {
            assert!(
                flattened.contains(relative),
                "wrapped filename stays complete at width {width}: {relative}\n{text}"
            );
            let destination = url::Url::from_file_path(cwd.join(relative))
                .expect("fixture file URL")
                .to_string();
            let escape = format!("\x1b]8;;{destination}\x07");
            let linked_cells = area
                .positions()
                .filter(|&position| buffer[position].symbol().contains(&escape))
                .collect::<Vec<_>>();
            let linked = linked_cells
                .iter()
                .map(|&position| crate::terminal_hyperlinks::strip_osc8(buffer[position].symbol()))
                .collect::<String>()
                .chars()
                .filter(|ch| !ch.is_whitespace())
                .collect::<String>();
            assert!(
                linked.contains(relative),
                "every wrapped filename segment keeps its file destination at width {width}: {linked}"
            );
            assert!(
                linked.contains("est.tokens"),
                "the source metadata still links to its file at width {width}: {linked}"
            );
            let last = *linked_cells.last().expect("linked metadata row");
            assert!(
                linked_cells.first().expect("first linked row").y < last.y,
                "this fixture must actually wrap"
            );
            let path = cwd.join(relative);
            let before = chat
                .continuity_sources()
                .into_iter()
                .find(|source| source.path == path)
                .expect("fixture source")
                .admitted;
            assert!(
                !chat.handle_context_ledger_mouse(crossterm::event::MouseEvent {
                    kind: crossterm::event::MouseEventKind::Down(
                        crossterm::event::MouseButton::Left
                    ),
                    column: last.x,
                    row: last.y,
                    modifiers: KeyModifiers::CONTROL,
                }),
                "Ctrl+click stays with the file link"
            );
            assert!(
                chat.handle_context_ledger_mouse(crossterm::event::MouseEvent {
                    kind: crossterm::event::MouseEventKind::Down(
                        crossterm::event::MouseButton::Left
                    ),
                    column: last.x,
                    row: last.y,
                    modifiers: KeyModifiers::NONE,
                }),
                "the visible wrapped metadata row toggles its source"
            );
            seed_ledger_from_disk(&mut chat)?;
            assert_ne!(
                chat.continuity_sources()
                    .into_iter()
                    .find(|source| source.path == path)
                    .expect("fixture source")
                    .admitted,
                before,
                "the click maps back to {relative}"
            );
        }
        assert!(
            (0..width).all(|x| !buffer[(x, 0)].symbol().contains("\x1b]8;")),
            "the pinned Close row never inherits a file hyperlink"
        );
        let expected_sources = chat.continuity_sources().len();
        assert_eq!(
            text.matches("EXCLUDED").count() + text.matches("INCLUDED").count(),
            expected_sources,
            "estimates and admission states survive filename wrapping at width {width}"
        );
        assert_eq!(text.matches("est. tokens").count(), expected_sources);
    }
    Ok(())
}

#[tokio::test]
async fn owned_ledger_close_stays_above_scrolled_source_links_and_hits() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    configure_ledger_sources(&mut chat, root.path())?;
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
    let selected = chat.selected_continuity_source().expect("selected source");
    assert_eq!(selected.name, "ES.md");
    let path = selected.path.clone();
    let admitted = selected.admitted;
    chat.handle_key_event(KeyEvent::from(KeyCode::Up));
    chat.handle_key_event(KeyEvent::from(KeyCode::Down));
    let destination = url::Url::from_file_path(&path)
        .expect("source file URL")
        .to_string();
    let escape = format!("\x1b]8;;{destination}\x07");
    let area = Rect::new(0, 0, 28, 4);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    chat.render_context_ledger_column(area, &mut buffer);
    let text = rows(&buffer, 0..area.width).join("\n");
    assert!(
        text.contains("CONTEXT LEDGER"),
        "the title stays pinned while the sources scroll: {text}"
    );
    assert!(
        text.contains("ES.md"),
        "the selected source fits below the header: {text}"
    );
    let close_x = (0..area.width)
        .find(|&x| buffer[(x, 0)].symbol() == "[")
        .expect("pinned ON toggle");
    assert!(
        (0..area.width).all(|x| !buffer[(x, 0)].symbol().contains("\x1b]8;")),
        "the Close row has no source file links after scrolling"
    );
    let last = area
        .positions()
        .filter(|&position| buffer[position].symbol().contains(&escape))
        .last()
        .expect("visible linked source metadata");
    assert_eq!(
        last.y,
        area.bottom() - 1,
        "selection scrolling uses the body height, excluding the header"
    );
    assert!(
        chat.handle_context_ledger_mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            column: last.x,
            row: last.y,
            modifiers: KeyModifiers::NONE,
        })
    );
    seed_ledger_from_disk(&mut chat)?;
    assert_ne!(
        chat.continuity_sources()
            .into_iter()
            .find(|source| source.path == path)
            .expect("clicked source")
            .admitted,
        admitted,
        "a scrolled visible metadata click toggles ES.md"
    );
    assert!(
        !chat.handle_context_ledger_mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            column: close_x,
            row: 0,
            modifiers: KeyModifiers::CONTROL,
        })
    );
    assert!(
        chat.handle_context_ledger_mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            column: close_x,
            row: 0,
            modifiers: KeyModifiers::NONE,
        })
    );
    assert_eq!(chat.context_ledger_width(WIDTH), 0);
    Ok(())
}

#[tokio::test]
async fn owned_ledger_tiny_areas_do_not_expose_a_clipped_toggle() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.last_rendered_width.set(Some(WIDTH));
    for width in [0, 1, 2, 3, 5, 6, 28] {
        for height in 0..=2 {
            show_context_ledger(&mut chat);
            let area = Rect::new(7, 5, width, height);
            let mut buffer = Buffer::empty(area);
            chat.render_context_ledger_column(area, &mut buffer);
            let text = area
                .positions()
                .map(|pos| buffer[pos].symbol())
                .collect::<String>();
            assert!(!text.contains(['×', '╳']));
            if width == 28 && height > 0 {
                assert!(text.contains("[━━━●] ON"));
                assert!(chat.handle_context_ledger_mouse(ledger_mouse(
                    crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
                    area.right() - 3,
                    area.y,
                )));
            } else {
                assert!(!text.contains("[━━━●] ON"));
            }
        }
    }
}

#[tokio::test]
async fn source_headings_are_teal_and_included_markers_are_olive() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    configure_ledger_sources(&mut chat, root.path())?;
    // Admission defaults are off; this rendering fixture needs an included row.
    chat.manual_memory_cache
        .sources
        .first_mut()
        .expect("fixture has a ledger source")
        .admitted = true;
    for bg in [(255, 255, 255), (24, 24, 24)] {
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
                    let style = if label == "INCLUDED" {
                        crate::style::context_style()
                    } else {
                        crate::style::section_style()
                    };
                    assert_eq!(Some(buf[(x as u16, y as u16)].fg), style.fg, "{label}");
                }
                assert_ne!(
                    crate::style::section_style().fg,
                    crate::style::context_style().fg
                );
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

    // Overlay suggestions without the full-screen Ledger column keep the Ledger beside the
    // composer; the full screen's own column is checked in `owned_transcript_render_cost_tests`.
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

/// The shared test config binds Tab to queueing; these tests need Elpis's default keymap.
fn use_default_keymap(chat: &mut ChatWidget) {
    chat.bottom_pane
        .set_keymap_bindings(&crate::keymap::RuntimeKeymap::defaults());
}

#[tokio::test]
async fn ledger_shortcuts_focus_and_hide_without_touching_the_draft() {
    for key in [
        KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT),
        KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL),
        KeyEvent::from(KeyCode::Tab),
    ] {
        let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
        use_default_keymap(&mut chat);
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

/// Draws the Ledger at the screen's top-left corner, then clicks the first row that shows
/// `text`, a few columns in. Returns whether the Ledger took the click.
fn click_ledger_row(chat: &mut ChatWidget, text: &str, modifiers: KeyModifiers) -> bool {
    chat.last_rendered_width.set(Some(WIDTH));
    let row = ledger_alone(chat)
        .iter()
        .position(|row| row.contains(text))
        .unwrap_or_else(|| panic!("no ledger row shows {text}"));
    chat.handle_context_ledger_mouse(crossterm::event::MouseEvent {
        kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
        column: 4,
        row: u16::try_from(row).expect("ledger row fits the screen"),
        modifiers,
    })
}

#[tokio::test]
async fn clicking_a_source_row_writes_its_admission() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    configure_ledger_sources(&mut chat, root.path())?;
    let before = row_state(&chat, "ES.md");

    assert!(click_ledger_row(&mut chat, "ES.md", KeyModifiers::NONE));
    seed_ledger_from_disk(&mut chat)?;

    let after = row_state(&chat, "ES.md");
    assert!(
        before.contains("INCLUDED") && after.contains("EXCLUDED")
            || before.contains("EXCLUDED") && after.contains("INCLUDED"),
        "{before:?} -> {after:?}"
    );
    assert!(
        !chat.context_ledger_has_focus(),
        "a click leaves typing in the composer"
    );
    Ok(())
}

#[tokio::test]
async fn ctrl_click_on_a_source_row_leaves_its_admission_to_the_file_link() -> anyhow::Result<()> {
    let root = tempdir()?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    configure_ledger_sources(&mut chat, root.path())?;
    let before = row_state(&chat, "ES.md");

    assert!(!click_ledger_row(&mut chat, "ES.md", KeyModifiers::CONTROL));
    seed_ledger_from_disk(&mut chat)?;

    assert_eq!(row_state(&chat, "ES.md"), before);
    Ok(())
}

#[tokio::test]
async fn clicking_the_subagents_switch_flips_it() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);
    let was_on = chat.config.features.enabled(Feature::Collab);

    assert!(click_ledger_row(&mut chat, "SUBAGENTS", KeyModifiers::NONE));

    assert_eq!(chat.context_ledger.pending_subagents_enabled, Some(!was_on));
    let sent = std::iter::from_fn(|| rx.try_recv().ok()).any(|event| {
        matches!(event, AppEvent::UpdateFeatureFlags { updates }
            if updates == vec![(Feature::Collab, !was_on)])
    });
    assert!(sent, "the new subagent setting was not saved");
}

#[tokio::test]
async fn clicking_a_ledger_heading_does_nothing() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    show_context_ledger(&mut chat);

    assert!(!click_ledger_row(
        &mut chat,
        "CONTEXT WINDOW",
        KeyModifiers::NONE
    ));
    assert_eq!(chat.context_ledger.pending_subagents_enabled, None);
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn tab_during_a_turn_opens_the_ledger_instead_of_queueing() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
    use_default_keymap(&mut chat);
    show_context_ledger(&mut chat);
    chat.last_rendered_width.set(Some(WIDTH));
    chat.bottom_pane.set_task_running(/*running*/ true);
    chat.bottom_pane
        .set_composer_text("Not a queued message".into(), Vec::new(), Vec::new());

    chat.handle_key_event(KeyEvent::from(KeyCode::Tab));

    assert!(chat.context_ledger_has_focus());
    assert!(chat.queued_user_message_texts().is_empty());
    assert_eq!(chat.bottom_pane.composer_text(), "Not a queued message");
    assert!(op_rx.try_recv().is_err(), "nothing was submitted");
}
