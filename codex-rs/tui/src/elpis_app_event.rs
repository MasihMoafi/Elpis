//! Elpis-owned application events.
//!
//! Upstream `AppEvent` carries every Elpis event in one variant, `AppEvent::Elpis`, so each new
//! Elpis event costs no upstream edit. `App::handle_elpis_event` (app/elpis_events.rs) handles
//! them. Later Elpis slices (the dashboard) add their variants here.

use crate::elpis_ledger_events::ManualMemoryMutationCompletion;
use crate::elpis_ledger_events::ManualMemoryRequestTarget;
use crate::elpis_ledger_events::ManualMemoryStatusCompletion;

#[derive(Debug)]
pub(crate) enum ElpisAppEvent {
    /// `/yolo`: switch this chat to Full Access and save it as the default for future chats.
    EnableYolo,

    /// The provider-aware `/model` picker (chatwidget/elpis_providers.rs,
    /// app/elpis_providers.rs).
    Provider(crate::chatwidget::ElpisProviderEvent),
    /// `/memory-model`: save the background model and use it from now on.
    SaveBackgroundModel(crate::elpis_background_model::BackgroundModelChoice),

    // The Context Ledger (app/elpis_ledger.rs).
    /// Render the `/context` usage report. Requires the App-owned transcript cell list
    /// (checkpoint count, per-category totals), so it cannot be built inside `ChatWidget`.
    RequestContextUsageReport(ManualMemoryRequestTarget),

    /// Refresh the cached manual-memory/source projection after a local write.
    ManualMemoryStatusRefreshRequested(ManualMemoryRequestTarget),

    /// Result of a blocking manual-memory/source read.
    ManualMemoryStatusLoaded(ManualMemoryRequestTarget, ManualMemoryStatusCompletion),

    /// Create the configured manual-memory file on a blocking worker.
    ManualMemoryCreateRequested(ManualMemoryRequestTarget),

    /// Result of a manual-memory create worker.
    ManualMemoryCreateFinished(ManualMemoryRequestTarget, ManualMemoryMutationCompletion),

    /// Persist the configured manual-memory admission state on a blocking worker.
    ManualMemoryAdmissionRequested(ManualMemoryRequestTarget, bool),

    /// Result of a manual-memory admission worker.
    ManualMemoryAdmissionFinished(
        ManualMemoryRequestTarget,
        bool,
        ManualMemoryMutationCompletion,
    ),
}
