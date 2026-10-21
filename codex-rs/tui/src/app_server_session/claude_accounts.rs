//! Use the same account RPCs and payloads as desktop Settings → Models & accounts.

use super::*;
use crate::app_event::AppEvent;
use codex_app_server_protocol::ClaudeAccountsReadParams;
use codex_app_server_protocol::ClaudeAccountsReadResponse;
use codex_app_server_protocol::ClaudeAccountsWriteParams;

impl AppServerSession {
    pub(crate) fn fetch_claude_accounts(&self, request_id: Uuid, app_event_tx: AppEventSender) {
        let request_handle = self.request_handle();
        tokio::spawn(async move {
            let result = tokio::time::timeout(
                Duration::from_secs(3),
                request_handle.request_typed::<ClaudeAccountsReadResponse>(
                    ClientRequest::ClaudeAccountsRead {
                        request_id: RequestId::String(format!("claude-accounts-{request_id}")),
                        params: ClaudeAccountsReadParams {},
                    },
                ),
            )
            .await
            .map_err(|err| err.to_string())
            .and_then(|response| response.map_err(|err| err.to_string()));
            app_event_tx.send(AppEvent::ClaudeAccountsLoaded { request_id, result });
        });
    }

    pub(crate) async fn select_claude_account(
        &self,
        id: String,
    ) -> Result<ClaudeAccountsReadResponse> {
        Ok(self
            .request_handle()
            .request_typed::<ClaudeAccountsReadResponse>(ClientRequest::ClaudeAccountsWrite {
                request_id: RequestId::String(format!("claude-account-select-{}", Uuid::new_v4())),
                params: ClaudeAccountsWriteParams::Select { id },
            })
            .await?)
    }
}
