//! Elpis: the App mirrors `/goal` into GOAL.md and checkpoints each finished turn into ES.md.
//!
//! Both files live under `<home>/context/workspaces/<workspace>/` (`crate::elpis_context`)
//! and feed the Context Ledger's SESSION CONTINUITY row, which refreshes after each write.
//! Copied from v0.3.0 `app/app_server_events.rs` (`mirror_elpis_context_notification`,
//! `goal_status_label`) and `app/background_requests.rs`
//! (`request_manual_memory_refresh_for_paths`).

use std::path::Path;

use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::ThreadGoalStatus;
use codex_protocol::ThreadId;

use super::App;
use super::app_server_event_targets::ServerNotificationThreadTarget;
use super::app_server_event_targets::server_notification_thread_target;
use crate::chatwidget::elpis_memory_dir;
use crate::elpis_ledger_events::ManualMemoryStorageTarget;

impl App {
    /// Buffers the primary thread's completed items, writes ES.md when its turn completes,
    /// and mirrors goal updates into GOAL.md. Other threads leave the workspace files alone.
    pub(super) async fn mirror_elpis_context_notification(
        &mut self,
        notification: &ServerNotification,
    ) {
        if let Some(primary_thread_id) = self.primary_thread_id
            && let ServerNotificationThreadTarget::Thread(thread_id) =
                server_notification_thread_target(notification)
            && thread_id != primary_thread_id
        {
            return;
        }
        if let ServerNotification::ItemCompleted(notification) = notification {
            self.elpis_turn_items
                .entry(notification.thread_id.clone())
                .or_default()
                .push((notification.turn_id.clone(), notification.item.clone()));
            return;
        }
        let memories_root = elpis_memory_dir(self.chat_widget.config_ref());
        if let ServerNotification::TurnCompleted(notification) = notification {
            let cwd = self.elpis_thread_cwd(&notification.thread_id).await;
            let buffered = self
                .elpis_turn_items
                .remove(&notification.thread_id)
                .unwrap_or_default();
            let turn = crate::elpis_context::turn_with_buffered_items(&notification.turn, buffered);
            let result = crate::elpis_context::write_session_checkpoint(
                Some(memories_root.as_path()),
                cwd.as_path(),
                &notification.thread_id,
                &turn,
            )
            .await;
            match result {
                Ok(_) => {
                    self.request_manual_memory_refresh_for_paths(
                        memories_root.as_path(),
                        cwd.as_path(),
                    );
                }
                Err(err) => {
                    tracing::warn!(error = %err, "failed to save Elpis session checkpoint");
                    self.chat_widget.add_error_message(format!(
                        "Turn completed, but Elpis could not save ES.md: {err}"
                    ));
                }
            }
            return;
        }

        let (thread_id, goal) = match notification {
            ServerNotification::ThreadGoalUpdated(notification) => {
                (&notification.thread_id, Some(&notification.goal))
            }
            ServerNotification::ThreadGoalCleared(notification) => (&notification.thread_id, None),
            _ => return,
        };
        let cwd = self.elpis_thread_cwd(thread_id).await;
        let result = match goal {
            Some(goal) => crate::elpis_context::write_goal(
                Some(memories_root.as_path()),
                cwd.as_path(),
                thread_id,
                &goal.objective,
                goal_status_label(&goal.status),
                goal.updated_at,
            )
            .await
            .map(|_| ()),
            None => crate::elpis_context::clear_goal(
                Some(memories_root.as_path()),
                cwd.as_path(),
                thread_id,
            )
            .await
            .map(|_| ()),
        };
        match result {
            Ok(()) => {
                self.request_manual_memory_refresh_for_paths(
                    memories_root.as_path(),
                    cwd.as_path(),
                );
            }
            Err(err) => {
                tracing::warn!(error = %err, "failed to mirror Elpis goal");
                self.chat_widget.add_error_message(format!(
                    "Goal changed, but Elpis could not save its portable GOAL.md: {err}"
                ));
            }
        }
    }

    /// The thread's working directory, or the current one when the thread is unknown.
    async fn elpis_thread_cwd(&self, thread_id: &str) -> std::path::PathBuf {
        let known = match ThreadId::from_string(thread_id) {
            Ok(thread_id) => self.thread_cwd(thread_id).await,
            Err(_) => None,
        };
        known.map_or_else(
            || self.chat_widget.config_ref().cwd.to_path_buf(),
            |cwd| cwd.to_path_buf(),
        )
    }

    /// Refreshes the Ledger only when the written files belong to the workspace it shows.
    fn request_manual_memory_refresh_for_paths(&mut self, memories_root: &Path, cwd: &Path) {
        let Some((admission_path, memory_path)) =
            crate::legacy_core::elpis_context::manual_memory_storage_paths(
                Some(memories_root),
                cwd,
            )
        else {
            return;
        };
        let storage = ManualMemoryStorageTarget {
            admission_path,
            memory_path,
        };
        if self
            .chat_widget
            .manual_memory_bound_target()
            .is_none_or(|target| target.storage != storage)
        {
            return;
        }
        self.chat_widget.request_manual_memory_status_refresh();
    }
}

fn goal_status_label(status: &ThreadGoalStatus) -> &'static str {
    match status {
        ThreadGoalStatus::Active => "active",
        ThreadGoalStatus::Paused => "paused",
        ThreadGoalStatus::Blocked => "blocked",
        ThreadGoalStatus::UsageLimited => "usage-limited",
        ThreadGoalStatus::BudgetLimited => "budget-limited",
        ThreadGoalStatus::Complete => "complete",
    }
}

#[cfg(test)]
#[path = "elpis_continuity_tests.rs"]
mod tests;
