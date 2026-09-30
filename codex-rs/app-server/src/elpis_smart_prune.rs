//! Elpis: `thread/smartPrune/updated` carries a thread's Smart Prune switch, counters and
//! latest evidence to clients (app-server-protocol v2/elpis_context.rs).
//!
//! v0.3.0 sent it after a config refresh changed the switch and when a connection attached
//! to a thread, and put the same snapshot inside every token-usage update. Here it is its own
//! notification in all three places, so token usage keeps upstream's shape.

use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::ThreadSmartPruneUpdatedNotification;
use codex_core::CodexThread;
use codex_core::ThreadManager;
use codex_protocol::ThreadId;

use crate::outgoing_message::OutgoingMessageSender;

/// The notification for `thread`'s current Smart Prune state.
pub(crate) async fn thread_smart_prune_updated(
    thread_id: ThreadId,
    thread: &CodexThread,
) -> ServerNotification {
    ServerNotification::ThreadSmartPruneUpdated(ThreadSmartPruneUpdatedNotification {
        thread_id: thread_id.to_string(),
        smart_prune: thread.smart_prune_snapshot().await.into(),
    })
}

/// After a config reload: every loaded thread's switch may have changed.
pub(crate) async fn broadcast_for_loaded_threads(
    outgoing: &OutgoingMessageSender,
    thread_manager: &ThreadManager,
) {
    for thread_id in thread_manager.list_thread_ids().await {
        let Ok(thread) = thread_manager.get_thread(thread_id).await else {
            continue;
        };
        outgoing
            .send_server_notification(thread_smart_prune_updated(thread_id, &thread).await)
            .await;
    }
}
