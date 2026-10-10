//! Route session-only permission shortcuts through the shared selection flow.

use super::*;
use codex_utils_approval_presets::builtin_approval_presets;

impl App {
    pub(super) async fn apply_permission_shortcut(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
        selection: PermissionProfileSelection,
    ) {
        if self.current_displayed_thread_id() != Some(thread_id)
            || self.chat_widget.thread_id() != Some(thread_id)
        {
            self.chat_widget.complete_permission_shortcut(thread_id);
            return;
        }
        if selection.profile_id == ":danger-full-access" {
            if let Some(preset) = builtin_approval_presets()
                .into_iter()
                .find(|preset| preset.id == "full-access")
            {
                self.chat_widget.open_full_access_confirmation(
                    preset,
                    /*return_to_permissions*/ true,
                    Some(selection),
                );
            }
        } else {
            self.select_permission_profile(app_server, selection).await;
        }
        // The modal now owns input. Neither Cancel nor Escape submits a selection, so
        // release the shortcut guard here rather than waiting for a settings notification.
        self.chat_widget.complete_permission_shortcut(thread_id);
    }
}
