//! Elpis: what the ChatWidget keeps for the Context Ledger's CONTEXT WINDOW shares.
//!
//! Copied from v0.3.0 `chatwidget/protocol.rs`. Upstream files reach this module through
//! one-line seams marked `Elpis:`.

use codex_app_server_protocol::ThreadContextAttribution;

use super::ChatWidget;

impl ChatWidget {
    /// Keep the latest request's category shares. An update that carries none (a replay, or a
    /// request built before this process started) keeps the last known shares.
    pub(super) fn apply_context_attribution(
        &mut self,
        attribution: Option<ThreadContextAttribution>,
    ) {
        if let Some(attribution) = attribution {
            self.context_attribution = Some(attribution);
        }
    }
}
