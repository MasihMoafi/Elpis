//! Acceptance probes for the approved Demo · List, through real view rendering and keys.

use super::*;
use codex_app_server_protocol::Turn;
use codex_protocol::openai_models::ReasoningEffort;
use pretty_assertions::assert_eq;

fn demo_turn(status: &str, items: serde_json::Value) -> Turn {
    serde_json::from_value(serde_json::json!({
        "id": "demo-turn",
        "status": status,
        "items": items,
        "startedAt": chrono::Utc::now().timestamp() - 12,
    }))
    .unwrap()
}

// Probe actual rendered text, retaining missing evidence in the snapshot diff.
fn evidence(view: &AgentsOverviewView, phrases: &[&str]) -> String {
    let rendered = screen(view, 160, 40);
    let rendered = rendered.split_whitespace().collect::<Vec<_>>().join(" ");
    phrases
        .iter()
        .map(|phrase| {
            if rendered.contains(phrase) {
                (*phrase).to_string()
            } else {
                format!("MISSING: {phrase}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn model_thread(
    id: u128,
    parent: Option<ThreadId>,
    title: &str,
    model: &str,
    provider: &str,
) -> Thread {
    let mut thread = overview_thread(ThreadId::from_u128(id), parent, title, ThreadStatus::Idle);
    thread.model = Some(model.into());
    thread.model_provider = provider.into();
    thread.reasoning_effort = Some(ReasoningEffort::High);
    thread
}

#[tokio::test]
async fn demo_list_model_and_effort_are_visible_with_a_known_model_fallback() {
    let app = make_test_app().await;
    let mut thread = model_thread(42, None, "Inspect usage", "GPT-6.1 Sol", "openai");
    let view = app.agents_overview_view(vec![thread.clone()], None);
    insta::assert_snapshot!(evidence(&view, &["GPT-6.1 Sol · high"]), @"GPT-6.1 Sol · high");

    // Even an unavailable catalog display name must retain the thread's known model.
    thread.model = Some("local/qwen".into());
    let mut view = app.agents_overview_view(vec![thread.clone()], None);
    view.rows[0].model_name = None;
    insta::assert_snapshot!(evidence(&view, &["local/qwen · high"]), @"local/qwen · high");
    thread.model = None;
    let view = app.agents_overview_view(vec![thread], None);
    assert!(!screen(&view, 160, 40).contains("local/qwen"));
}

#[tokio::test]
async fn demo_list_provider_dots_and_models_share_four_distinct_colors() {
    let mut app = make_test_app().await;
    app.local_settings.tui.status_line_use_colors = true;
    let threads = [
        ("Claude Opus 5.5", "anthropic"),
        ("GPT-6.1 Sol", "openai"),
        ("Gemini 3.8 Flash", "google"),
        ("Local Qwen", "local"),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, (model, provider))| model_thread(i as u128 + 42, None, provider, model, provider))
    .collect();
    let view = app.agents_overview_view(threads, Some(ThreadId::from_u128(43)));
    let area = Rect::new(0, 0, 160, 40);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    crate::terminal_palette::with_test_default_colors(
        crate::terminal_probe::DefaultColors {
            fg: (17, 17, 17),
            bg: (255, 255, 255),
        },
        || view.render(area, &mut buf),
    );
    let mut colors = Vec::new();
    let mut probes = Vec::new();
    for (label, provider) in [
        ("Claude Opus", "anthropic"),
        ("GPT-6.1", "openai"),
        ("Gemini", "google"),
        ("Local Qwen", "local"),
    ] {
        let cells = buf
            .content
            .chunks(160)
            .find(|cells| {
                let text = cells
                    .iter()
                    .map(ratatui::buffer::Cell::symbol)
                    .collect::<String>();
                text.contains(label) && text.contains(provider)
            })
            .unwrap();
        let text = cells
            .iter()
            .map(ratatui::buffer::Cell::symbol)
            .collect::<String>();
        let model_x = text[..text.find(label).unwrap()].chars().count();
        let dot = cells.iter().find(|cell| cell.symbol() == "●");
        let model_color = cells[model_x].fg;
        probes.push(format!(
            "{provider}: provider dot matches model = {}",
            dot.is_some_and(
                |dot| dot.fg == model_color && model_color != ratatui::style::Color::Reset
            )
        ));
        colors.push(model_color);
    }
    probes.push(format!(
        "four provider colors = {}",
        colors
            .iter()
            .enumerate()
            .all(|(i, color)| !colors[..i].contains(color))
    ));
    insta::assert_snapshot!(probes.join("\n"), @r###"
    anthropic: provider dot matches model = true
    openai: provider dot matches model = true
    google: provider dot matches model = true
    local: provider dot matches model = true
    four provider colors = true
    "###);
}

#[tokio::test]
async fn demo_list_tree_and_project_counts_include_delegated_children() {
    let app = make_test_app().await;
    let parent = ThreadId::from_u128(42);
    let view = app.agents_overview_view(
        vec![
            model_thread(42, None, "Fix usage", "Claude Opus 5.5", "anthropic"),
            model_thread(43, Some(parent), "Find emitter", "GPT-6.1 Sol", "openai"),
            model_thread(44, Some(parent), "Check receipt", "GPT-6 Luna", "openai"),
        ],
        Some(parent),
    );
    insta::assert_snapshot!(evidence(&view, &["/tmp/project 3", "├─", "└─"]), @r###"
    /tmp/project 3
    ├─
    └─
    "###);
    let view = app.agents_overview_view(
        vec![model_thread(
            42,
            None,
            "Single task",
            "GPT-6.1 Sol",
            "openai",
        )],
        None,
    );
    assert!(!screen(&view, 160, 40).contains("├─"));
    assert!(!screen(&view, 160, 40).contains("└─"));
}

#[tokio::test]
async fn demo_list_status_glyphs_and_filter_counts_distinguish_done_from_ready() {
    let app = make_test_app().await;
    let mut working = model_thread(42, None, "Working task", "GPT-6.1 Sol", "openai");
    working.status = ThreadStatus::Active {
        active_flags: vec![],
    };
    let ready = model_thread(43, None, "Ready task", "GPT-6.1 Sol", "openai");
    let mut done = model_thread(44, None, "Done task", "GPT-6.1 Sol", "openai");
    done.turns
        .push(demo_turn("completed", serde_json::json!([])));
    let mut inactive = model_thread(45, None, "Inactive task", "GPT-6.1 Sol", "openai");
    inactive.status = ThreadStatus::NotLoaded;
    let mut view = app.agents_overview_view(vec![working, ready, done, inactive], None);
    insta::assert_snapshot!(evidence(&view, &[
        "All 4", "Needs you 0", "Working 1", "Ready 1", "Done 1", "Inactive 1",
        "◐ Working", "◇ Ready", "✓ Done", "○ Inactive",
    ]), @r###"
    All 4
    Needs you 0
    Working 1
    Ready 1
    Done 1
    Inactive 1
    ◐ Working
    ◇ Ready
    ✓ Done
    ○ Inactive
    "###);
    for _ in 0..4 {
        view.handle_key_event(KeyCode::Tab.into());
    }
    let filtered = screen(&view, 160, 40);
    assert!(filtered.contains("Done task"));
    assert!(!filtered.contains("Ready task"));
    assert!(!filtered.contains("Inactive task"));
}

#[tokio::test]
async fn demo_list_selected_conversation_shows_delegate_tools_reply_steer_and_live_state() {
    let app = make_test_app().await;
    let parent = model_thread(42, None, "Fix usage", "Claude Opus 5.5", "anthropic");
    let mut child = model_thread(
        43,
        Some(ThreadId::from_u128(42)),
        "Find emitter",
        "GPT-6.1 Sol",
        "openai",
    );
    child.status = ThreadStatus::Active {
        active_flags: vec![],
    };
    child.turns.push(demo_turn("inProgress", serde_json::json!([
        {"type":"userMessage", "id":"ask", "content":[{"type":"text", "text":"Find the usage emitter.", "text_elements":[]}]},
        {"type":"commandExecution", "id":"rg", "command":"rg -n tokenUsage/updated codex-rs/app-server", "cwd":"/tmp/project", "status":"completed", "commandActions":[]},
        {"type":"agentMessage", "id":"reply", "text":"Only run_turn calls it."},
        {"type":"userMessage", "id":"steer", "content":[{"type":"text", "text":"Also check thread/inject_items.", "text_elements":[]}]},
    ])));
    let view = app.agents_overview_view(
        vec![parent.clone(), child.clone()],
        Some(ThreadId::from_u128(43)),
    );
    insta::assert_snapshot!(evidence(&view, &[
        "asked by Claude Opus 5.5", "Claude Opus 5.5 → GPT-6.1 Sol delegate", "Find the usage emitter.",
        "• Ran rg -n", "Only run_turn calls it.", "steer", "Also check thread/inject_items.", "◐ working",
    ]), @r###"
    asked by Claude Opus 5.5
    Claude Opus 5.5 → GPT-6.1 Sol delegate
    Find the usage emitter.
    • Ran rg -n
    Only run_turn calls it.
    steer
    Also check thread/inject_items.
    ◐ working
    "###);
    if let ThreadItem::CommandExecution { status, .. } = &mut child.turns[0].items[1] {
        *status = codex_app_server_protocol::CommandExecutionStatus::Declined;
    }
    let declined = app.agents_overview_view(
        vec![parent.clone(), child.clone()],
        Some(ThreadId::from_u128(43)),
    );
    let rendered = screen(&declined, 160, 40);
    assert!(rendered.contains("• Did not run rg"));
    assert!(!rendered.contains("• Ran rg"));
    // Selecting the parent must not display a child's conversation as its own.
    let view = app.agents_overview_view(vec![parent, child], Some(ThreadId::from_u128(42)));
    assert!(!screen(&view, 160, 40).contains("Only run_turn calls it."));
}

#[tokio::test]
async fn demo_list_refresh_keeps_the_fetched_conversation_on_the_real_projection_path() -> Result<()>
{
    let mut app = make_test_app().await;
    let app_server = crate::start_embedded_app_server_for_picker(&app.config).await?;
    let id = ThreadId::from_u128(42);
    let mut thread = model_thread(42, None, "Inspect usage", "GPT-6.1 Sol", "openai");
    thread.turns.push(demo_turn(
        "completed",
        serde_json::json!([
            {"type":"agentMessage", "id":"planted-reply", "text":"CONVERSATION_ONLY_EVIDENCE_1810"}
        ]),
    ));
    let request_id = Uuid::new_v4();
    app.agents_overview.request_id = Some(request_id);
    app.apply_agents_overview_thread_refresh(
        &app_server,
        request_id,
        Ok(crate::app_event::AgentsOverviewThreadRefresh {
            threads: HashMap::from([(id, Some(thread))]),
            last_messages: HashMap::new(),
            recent_seed_complete: true,
            discovery: None,
            pinned_thread_ids: None,
        }),
    );
    let stored = app
        .agents_overview
        .threads
        .get(&id)
        .unwrap()
        .as_ref()
        .unwrap()
        .clone();
    let view = app.agents_overview_view(vec![stored], Some(id));
    insta::assert_snapshot!(evidence(&view, &["CONVERSATION_ONLY_EVIDENCE_1810"]), @"CONVERSATION_ONLY_EVIDENCE_1810");
    app.remove_agents_overview_thread(id);
    let view = app.agents_overview_view(
        app.agents_overview
            .threads
            .values()
            .flatten()
            .cloned()
            .collect(),
        None,
    );
    assert!(!screen(&view, 160, 40).contains("CONVERSATION_ONLY_EVIDENCE_1810"));
    Ok(())
}

#[tokio::test]
async fn demo_list_header_and_footer_advertise_the_implemented_controls() {
    let app = make_test_app().await;
    let mut thread = model_thread(42, None, "Find emitter", "GPT-6.1 Sol", "openai");
    thread.status = ThreadStatus::Active {
        active_flags: vec![],
    };
    let view = app.agents_overview_view(vec![thread], None);
    insta::assert_snapshot!(evidence(&view, &["View: list", "? help", "esc back", "↑/↓ move", "enter open", "s steer", "x stop", "n new"]), @r###"
    View: list
    ? help
    esc back
    ↑/↓ move
    enter open
    s steer
    x stop
    n new
    "###);
}

#[tokio::test]
async fn demo_list_steer_editor_sends_once_to_its_target_and_cancel_sends_nothing() {
    let mut app = make_test_app().await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.app_event_tx = AppEventSender::new(tx);
    let mut thread = model_thread(42, None, "Find emitter", "GPT-6.1 Sol", "openai");
    thread.status = ThreadStatus::Active {
        active_flags: vec![],
    };
    let mut view = app.agents_overview_view(vec![thread], None);
    view.handle_key_event(KeyCode::Char('s').into());
    view.handle_key_event(KeyCode::Enter.into());
    assert!(rx.try_recv().is_err(), "an empty steer sends nothing");
    view.handle_paste("Also inspect inject_items".into());
    insta::assert_snapshot!(evidence(&view, &["Steer ›", "Also inspect inject_items"]), @r###"
    Steer ›
    Also inspect inject_items
    "###);
    view.handle_key_event(KeyCode::Esc.into());
    assert!(!screen(&view, 160, 40).contains("Steer ›"));
    assert!(rx.try_recv().is_err());
    view.handle_key_event(KeyCode::Char('s').into());
    assert!(view.handle_paste("Also inspect inject_items".into()));
    view.handle_key_event(KeyCode::Enter.into());
    let dispatched = format!(
        "{:?}",
        rx.try_recv().expect("steer must dispatch a message")
    );
    assert!(dispatched.contains("Also inspect inject_items"));
    assert!(dispatched.contains(&ThreadId::from_u128(42).to_string()));
    assert!(rx.try_recv().is_err(), "one Enter sends one steer");
}

#[tokio::test]
async fn demo_list_stop_requires_confirmation_and_cancel_sends_nothing() {
    let mut app = make_test_app().await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    app.app_event_tx = AppEventSender::new(tx);
    let mut thread = model_thread(42, None, "Find emitter", "GPT-6.1 Sol", "openai");
    thread.status = ThreadStatus::Active {
        active_flags: vec![],
    };
    let mut view = app.agents_overview_view(vec![thread.clone()], None);
    view.handle_key_event(KeyCode::Char('x').into());
    insta::assert_snapshot!(evidence(&view, &["Stop", "Find emitter", "enter", "esc"]), @r###"
    Stop
    Find emitter
    enter
    esc
    "###);
    assert!(
        rx.try_recv().is_err(),
        "x must not interrupt before confirmation"
    );
    view.handle_key_event(KeyCode::Esc.into());
    assert!(rx.try_recv().is_err());
    view.handle_key_event(KeyCode::Char('x').into());
    view.handle_key_event(KeyCode::Enter.into());
    assert_matches!(rx.try_recv(), Ok(AppEvent::StopAgentsOverviewThread { thread_id }) if thread_id == ThreadId::from_u128(42));
    assert!(rx.try_recv().is_err());
    thread.status = ThreadStatus::Idle;
    let mut view = app.agents_overview_view(vec![thread], None);
    view.handle_key_event(KeyCode::Char('x').into());
    view.handle_key_event(KeyCode::Esc.into());
    assert!(rx.try_recv().is_err(), "an idle task has nothing to stop");
}

#[tokio::test]
async fn demo_list_conversation_preserves_the_sender_of_human_steers() {
    let app = make_test_app().await;
    let parent = model_thread(42, None, "Parent", "Claude Opus 5.5", "anthropic");
    let mut child = model_thread(
        43,
        Some(ThreadId::from_u128(42)),
        "Child",
        "GPT-6.1 Sol",
        "openai",
    );
    child.turns.push(demo_turn("completed", serde_json::json!([
        {"type":"userMessage", "id":"human-steer", "clientId": format!("{}fixture", crate::app::agents_overview::HUMAN_STEER_ID_PREFIX),
         "content":[{"type":"text", "text":"Human instruction", "text_elements":[]}]}
    ])));
    let view = app.agents_overview_view(
        vec![parent.clone(), child.clone()],
        Some(ThreadId::from_u128(43)),
    );
    insta::assert_snapshot!(evidence(&view, &["you → GPT-6.1 Sol steer"]), @"you → GPT-6.1 Sol steer");
    if let codex_app_server_protocol::ThreadItem::UserMessage { client_id, .. } =
        &mut child.turns[0].items[0]
    {
        *client_id = None;
    }
    let view = app.agents_overview_view(vec![parent, child], Some(ThreadId::from_u128(43)));
    let text = screen(&view, 160, 40)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(!text.contains("you → GPT-6.1 Sol steer"));
    assert!(text.contains("Claude Opus 5.5 → GPT-6.1 Sol delegate"));
}

#[tokio::test]
async fn demo_list_rejected_steer_keeps_the_draft_and_explains_the_failure() -> Result<()> {
    let mut app = make_test_app().await;
    let mut server = crate::start_embedded_app_server_for_picker(&app.config).await?;
    let id = ThreadId::from_u128(42);
    let view = app.agents_overview_view(
        vec![model_thread(
            42,
            None,
            "Unavailable target",
            "GPT-6.1 Sol",
            "openai",
        )],
        Some(id),
    );
    app.chat_widget.show_bottom_pane_view(Box::new(view));
    app.steer_agents_overview_thread(&mut server, id, "KEEP_THIS_DRAFT".into())
        .await;
    {
        let state = app.agents_overview.view_state.lock().unwrap();
        assert_eq!(state.steer_target, Some(id));
        assert_eq!(state.input.text(), "KEEP_THIS_DRAFT");
    }
    let rendered = render_bottom_popup(&app.chat_widget, 96);
    assert!(rendered.contains("Unable to complete action"));
    assert!(rendered.contains("Failed to steer task"));
    Ok(())
}
