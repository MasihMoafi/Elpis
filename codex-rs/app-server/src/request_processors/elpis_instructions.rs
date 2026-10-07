//! Elpis: `thread/elpisInstructions/read`. A client that runs a thread's turns on another
//! engine reads the Elpis instruction text this thread's model would receive.

use super::thread_processor::ThreadRequestProcessor;
use crate::error_code::internal_error;
use crate::error_code::invalid_request;
use codex_app_server_protocol::ClientResponsePayload;
use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::ThreadElpisInstructionsReadParams;
use codex_app_server_protocol::ThreadElpisInstructionsReadResponse;
use codex_protocol::error::CodexErrorDetails;

impl ThreadRequestProcessor {
    pub(crate) async fn thread_elpis_instructions_read(
        &self,
        params: ThreadElpisInstructionsReadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        let (_, thread) = self.load_thread(&params.thread_id).await?;
        let instructions =
            thread
                .elpis_instructions()
                .await
                .map_err(|err| match err.details() {
                    CodexErrorDetails::InvalidRequest(message) => invalid_request(message.clone()),
                    _ => internal_error(format!("failed to read Elpis instructions: {err}")),
                })?;
        Ok(Some(
            ThreadElpisInstructionsReadResponse {
                developer_instructions: instructions.developer_instructions,
                agents_md: instructions.agents_md,
                continuity: instructions.continuity,
            }
            .into(),
        ))
    }
}
