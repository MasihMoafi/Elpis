//! Evals for Smart Prune in the TUI: `/prune`, `/smart-prune`, the Ledger's `p` key,
//! `/pruner-model`, the `thread/smartPrune/updated` notification and the "Smart Prune saved"
//! line (D7).
//!
//! Each behaviour has a positive case and a negative case.

use super::*;
use codex_app_server_protocol::ThreadSmartPruneSnapshot;
use codex_app_server_protocol::ThreadSmartPruneUpdatedNotification;
use codex_features::Feature;
use pretty_assertions::assert_eq;

const WIDTH: u16 = 150;

fn feature_updates(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>,
) -> Vec<(Feature, bool)> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .filter_map(|event| match event {
            AppEvent::UpdateFeatureFlags { updates } => Some(updates),
            _ => None,
        })
        .flatten()
        .collect()
}

fn history(rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>) -> Vec<String> {
    drain_insert_history(rx)
        .iter()
        .map(|lines| lines_to_single_string(lines))
        .collect()
}

fn smart_prune_update(
    thread_id: ThreadId,
    enabled: bool,
    approx_saved_tokens: u64,
) -> ServerNotification {
    ServerNotification::ThreadSmartPruneUpdated(ThreadSmartPruneUpdatedNotification {
        thread_id: thread_id.to_string(),
        smart_prune: ThreadSmartPruneSnapshot {
            enabled,
            examined_outputs: u64::from(approx_saved_tokens > 0),
            admitted_outputs: u64::from(approx_saved_tokens > 0),
            approx_saved_tokens,
            ..ThreadSmartPruneSnapshot::default()
        },
    })
}

#[tokio::test]
async fn prune_asks_to_switch_smart_prune_on_without_a_model_request() {
    let (mut chat, mut rx, mut ops) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.dispatch_command(SlashCommand::Prune);

    assert_eq!(
        feature_updates(&mut rx),
        vec![(Feature::AutomaticContextPruning, true)]
    );
    assert_eq!(chat.context_ledger.pending_smart_prune_enabled, Some(true));
    assert_matches!(ops.try_recv(), Err(TryRecvError::Empty));
}

#[tokio::test]
async fn a_second_switch_waits_for_the_first_write() {
    let (mut chat, mut rx, _ops) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.dispatch_command(SlashCommand::Prune);
    let _ = feature_updates(&mut rx);

    // Negative: a pending write refuses another request.
    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "off".to_string(), Vec::new());
    assert_eq!(feature_updates(&mut rx), Vec::new());

    // Positive: once the write settles, the next request goes out.
    chat.cancel_pending_smart_prune_update();
    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "off".to_string(), Vec::new());
    assert_eq!(
        feature_updates(&mut rx),
        vec![(Feature::AutomaticContextPruning, false)]
    );
}

#[tokio::test]
async fn smart_prune_on_off_sets_it_and_anything_else_prints_the_usage() {
    for (args, expected) in [("on", Some(true)), ("OFF", Some(false)), ("maybe", None)] {
        let (mut chat, mut rx, _ops) = make_chatwidget_manual(/*model_override*/ None).await;

        chat.dispatch_command_with_args(SlashCommand::SmartPrune, args.to_string(), Vec::new());

        let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        let updates = events
            .iter()
            .filter_map(|event| match event {
                AppEvent::UpdateFeatureFlags { updates } => Some(updates.clone()),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();
        match expected {
            Some(enabled) => assert_eq!(
                updates,
                vec![(Feature::AutomaticContextPruning, enabled)],
                "/smart-prune {args}"
            ),
            None => {
                assert_eq!(updates, Vec::new(), "/smart-prune {args}");
                let cells = events
                    .iter()
                    .filter_map(|event| match event {
                        AppEvent::InsertHistoryCell(cell) => {
                            Some(lines_to_single_string(&cell.display_lines(/*width*/ 200)))
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                assert!(
                    cells
                        .iter()
                        .any(|cell| cell.contains("Usage: /smart-prune [on|off]")),
                    "{cells:?}"
                );
            }
        }
    }
}

#[tokio::test]
async fn bare_smart_prune_toggles_only_once_the_thread_state_is_known() {
    let (mut chat, mut rx, _ops) = make_chatwidget_manual(/*model_override*/ None).await;

    // Negative: before the thread reports its state there is nothing to toggle from.
    chat.dispatch_command(SlashCommand::SmartPrune);
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, AppEvent::UpdateFeatureFlags { .. })),
        "{events:?}"
    );
    assert!(
        events.iter().any(|event| matches!(
            event,
            AppEvent::InsertHistoryCell(cell)
                if lines_to_single_string(&cell.display_lines(/*width*/ 200))
                    .contains("Smart Prune state is still syncing.")
        )),
        "{events:?}"
    );

    // Positive: a synced OFF toggles to ON.
    chat.smart_prune_synced = true;
    chat.smart_prune.enabled = false;
    chat.dispatch_command(SlashCommand::SmartPrune);
    assert_eq!(
        feature_updates(&mut rx),
        vec![(Feature::AutomaticContextPruning, true)]
    );
}

#[tokio::test]
async fn thread_update_syncs_the_switch_and_flashes_only_new_savings() {
    let (mut chat, mut rx, _ops) = make_chatwidget_manual(/*model_override*/ None).await;
    let thread_id = ThreadId::new();
    chat.thread_id = Some(thread_id);
    chat.last_rendered_width.set(Some(WIDTH));

    // Negative: another thread's state is ignored.
    chat.handle_server_notification(
        smart_prune_update(ThreadId::new(), /*enabled*/ true, 3_300),
        /*replay_kind*/ None,
    );
    assert!(!chat.smart_prune_synced);

    // The first snapshot syncs the switch; it is not a new saving.
    chat.handle_server_notification(
        smart_prune_update(thread_id, /*enabled*/ true, 1_000),
        /*replay_kind*/ None,
    );
    assert!(chat.smart_prune_synced);
    assert!(chat.smart_prune.enabled);
    let screen = render_bottom_popup(&chat, WIDTH);
    assert!(!screen.contains("Smart Prune saved"), "{screen}");

    // Positive: a later snapshot that saved more flashes the difference.
    chat.handle_server_notification(
        smart_prune_update(thread_id, /*enabled*/ true, 4_300),
        /*replay_kind*/ None,
    );
    let screen = render_bottom_popup(&chat, WIDTH);
    assert!(
        screen.contains("✂ Smart Prune saved ~3.3k tokens · snip!"),
        "{screen}"
    );
    let _ = history(&mut rx);
}

#[tokio::test]
async fn ledger_p_toggles_smart_prune() {
    let (mut chat, mut rx, _ops) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.last_rendered_width.set(Some(WIDTH));
    chat.smart_prune_synced = true;
    chat.smart_prune.enabled = true;

    // Negative: `p` typed into the composer is text, not a switch.
    chat.handle_key_event(KeyEvent::from(KeyCode::Char('p')));
    assert_eq!(feature_updates(&mut rx), Vec::new());

    // Positive: with the ledger focused, `p` switches Smart Prune off.
    chat.bottom_pane
        .set_composer_text(String::new(), Vec::new(), Vec::new());
    chat.handle_key_event(KeyEvent::from(KeyCode::Tab));
    chat.handle_key_event(KeyEvent::from(KeyCode::Char('p')));
    assert_eq!(
        feature_updates(&mut rx),
        vec![(Feature::AutomaticContextPruning, false)]
    );
}

#[tokio::test]
async fn pruner_model_saves_the_optimizer_model_and_never_the_chat_model() -> anyhow::Result<()> {
    let home = tempfile::tempdir()?;
    let (mut chat, mut rx, mut ops) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.config.codex_home = AbsolutePathBuf::from_absolute_path(home.path())?;
    let chat_model = chat.config.model.clone();

    chat.dispatch_command_with_args(
        SlashCommand::PrunerModel,
        "gpt-5.6-luna".to_string(),
        Vec::new(),
    );

    let saved = crate::legacy_core::pruner_settings::PrunerSettings::load(home.path())?;
    assert_eq!(saved.model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(chat.config.model, chat_model);
    let cells = history(&mut rx);
    assert!(
        cells
            .iter()
            .any(|cell| cell.contains("Smart Prune model saved: gpt-5.6-luna on")),
        "{cells:?}"
    );
    assert_matches!(ops.try_recv(), Err(TryRecvError::Empty));

    // Negative: an id with whitespace is refused and the saved model stays.
    chat.dispatch_command_with_args(
        SlashCommand::PrunerModel,
        "two words".to_string(),
        Vec::new(),
    );
    let saved = crate::legacy_core::pruner_settings::PrunerSettings::load(home.path())?;
    assert_eq!(saved.model.as_deref(), Some("gpt-5.6-luna"));
    let cells = history(&mut rx);
    assert!(
        cells
            .iter()
            .any(|cell| cell.contains("Pruner model was not changed")),
        "{cells:?}"
    );
    Ok(())
}

#[tokio::test]
async fn bare_pruner_model_opens_the_pruner_picker() {
    let (mut chat, _rx, _ops) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.dispatch_command(SlashCommand::PrunerModel);

    let screen = render_bottom_popup(&chat, WIDTH);
    assert!(screen.contains("Choose pruner model"), "{screen}");
    assert!(screen.contains("Provider default"), "{screen}");
}
