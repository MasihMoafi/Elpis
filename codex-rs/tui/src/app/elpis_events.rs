//! App-side handling of Elpis-owned events (`AppEvent::Elpis`).

use super::*;
use crate::elpis_app_event::ElpisAppEvent;
use crate::legacy_core::config::edit::ConfigEdit;
use codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS;

impl App {
    pub(super) async fn handle_elpis_event(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        event: ElpisAppEvent,
    ) -> Result<()> {
        match event {
            ElpisAppEvent::EnableYolo => self.enable_yolo(app_server).await,
            ElpisAppEvent::Provider(event) => {
                self.handle_elpis_provider_event(tui, app_server, event)
                    .await;
            }
            ledger_event => self.handle_elpis_ledger_event(tui, ledger_event)?,
        }
        Ok(())
    }

    /// `/yolo`: Full Access (no sandbox, never ask) for this chat, saved as the default for
    /// future chats.
    ///
    /// The per-chat switch goes through the upstream permission-selection path, which reports
    /// its own outcome. Unlike v0.3.0, approvals that are already pending are not accepted.
    async fn enable_yolo(&mut self, app_server: &mut AppServerSession) {
        if self.reject_pending_permission_change() {
            return;
        }
        self.select_permission_profile(
            app_server,
            PermissionProfileSelection {
                profile_id: BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS.to_string(),
                approval_policy: Some(AskForApproval::Never),
                approvals_reviewer: Some(ApprovalsReviewer::User),
                display_label: "Full Access".to_string(),
            },
        )
        .await;
        match self.persist_full_access_default().await {
            Ok(()) => self.chat_widget.add_info_message(
                "Full Access saved as the default for future chats.".to_string(),
                /*hint*/ None,
            ),
            Err(err) => self
                .chat_widget
                .add_error_message(format!("Full Access default could not be saved: {err}")),
        }
    }

    /// Save Full Access as the config.toml default, as v0.3.0 did.
    async fn persist_full_access_default(&self) -> anyhow::Result<()> {
        let mut edits = vec![ConfigEdit::ClearPath {
            segments: vec!["sandbox_mode".into()],
        }];
        for (key, value) in [
            (
                "default_permissions",
                BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS,
            ),
            ("approval_policy", "never"),
            ("approvals_reviewer", "user"),
        ] {
            edits.push(ConfigEdit::SetPath {
                segments: vec![key.into()],
                value: value.into(),
            });
        }
        ConfigEditsBuilder::for_config(&self.config)
            .with_edits(edits)
            .apply()
            .await
    }
}

#[cfg(test)]
#[path = "elpis_events_tests.rs"]
mod tests;
