//! Test helper for code that runs while a voice session owns a thread.

use super::RealtimeConversationPhase;
use crate::chatwidget::ChatWidget;
use codex_protocol::ThreadId;

pub(crate) fn activate_voice_for_thread(chat: &mut ChatWidget, thread_id: ThreadId) {
    chat.thread_id = Some(thread_id);
    chat.realtime_conversation.phase = RealtimeConversationPhase::Active;
    chat.realtime_conversation.thread_id = Some(thread_id);
    chat.realtime_conversation.backend_started = true;
    chat.realtime_conversation.latest_input_was_voice = true;
}
