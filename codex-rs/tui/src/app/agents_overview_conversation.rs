//! Reads the selected task's recent turns for the details panel, one read at a time.
//! Each frame checks the selection, so a read starts when the selection moves; the result
//! lands in the view's shared state and asks for another frame.

use crate::app::App;
use crate::app::agents_overview::AGENTS_OVERVIEW_VIEW_ID;
use crate::app::agents_overview_view::command_center::RECENT_TURNS;
use crate::app::agents_overview_view::command_center::conversation_entries;
use crate::app_server_session::AppServerSession;
use crate::tui::FrameRequester;
use codex_app_server_client::AppServerRequestHandle;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::SortDirection;
use codex_app_server_protocol::ThreadReadParams;
use codex_app_server_protocol::ThreadReadResponse;
use codex_app_server_protocol::ThreadTurnsListParams;
use codex_app_server_protocol::ThreadTurnsListResponse;
use codex_app_server_protocol::Turn;
use codex_app_server_protocol::TurnItemsView;
use codex_protocol::ThreadId;
use std::time::Duration;
use uuid::Uuid;

const READ_TIMEOUT: Duration = Duration::from_secs(/*secs*/ 10);

impl App {
    pub(in crate::app) fn refresh_agents_overview_conversation(
        &self,
        app_server: &AppServerSession,
        frame_requester: &FrameRequester,
    ) {
        if self.reconnect.offline {
            return;
        }
        let Some(thread_id) = self
            .chat_widget
            .selected_index_for_present_view(AGENTS_OVERVIEW_VIEW_ID)
            .and_then(|index| self.agents_overview.visible_thread_ids.get(index))
            .copied()
        else {
            return;
        };
        let updated_at = self
            .agents_overview
            .threads
            .get(&thread_id)
            .and_then(Option::as_ref)
            .map_or(0, |thread| thread.updated_at);
        let state = std::sync::Arc::clone(&self.agents_overview.view_state);
        if !state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .conversations
            .begin(thread_id, updated_at)
        {
            return;
        }
        let request_handle = app_server.request_handle();
        let frame_requester = frame_requester.clone();
        tokio::spawn(async move {
            let entries =
                tokio::time::timeout(READ_TIMEOUT, recent_turns(request_handle, thread_id))
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .map(conversation_entries);
            state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .conversations
                .finish(thread_id, updated_at, entries);
            frame_requester.schedule_frame();
        });
    }
}

/// The newest turns with their items, newest first. Servers without turn paging answer
/// through `thread/read` with every turn.
async fn recent_turns(
    handle: AppServerRequestHandle,
    thread_id: ThreadId,
) -> Result<Vec<Turn>, String> {
    let listed = handle
        .request_typed::<ThreadTurnsListResponse>(ClientRequest::ThreadTurnsList {
            request_id: RequestId::String(Uuid::new_v4().to_string()),
            params: ThreadTurnsListParams {
                thread_id: thread_id.to_string(),
                cursor: None,
                limit: Some(RECENT_TURNS),
                sort_direction: Some(SortDirection::Desc),
                items_view: Some(TurnItemsView::Full),
            },
        })
        .await;
    if let Ok(page) = listed {
        return Ok(page.data);
    }
    let read = handle
        .request_typed::<ThreadReadResponse>(ClientRequest::ThreadRead {
            request_id: RequestId::String(Uuid::new_v4().to_string()),
            params: ThreadReadParams {
                thread_id: thread_id.to_string(),
                include_turns: true,
            },
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok(read
        .thread
        .turns
        .into_iter()
        .rev()
        .take(RECENT_TURNS as usize)
        .collect())
}
