//! Elpis-owned application events.
//!
//! Upstream `AppEvent` carries every Elpis event in one variant, `AppEvent::Elpis`, so each new
//! Elpis event costs no upstream edit. `App::handle_elpis_event` (app/elpis_events.rs) handles
//! them. Later Elpis slices (the Context Ledger, the dashboard) add their variants here.

#[derive(Debug)]
pub(crate) enum ElpisAppEvent {
    /// `/yolo`: switch this chat to Full Access and save it as the default for future chats.
    EnableYolo,
}
