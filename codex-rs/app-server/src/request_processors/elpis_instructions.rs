//! Elpis: `thread/elpisInstructions/read`. A client that runs a thread's turns on another
//! engine reads the Elpis instruction text this thread's model would receive.

use super::thread_processor::ThreadRequestProcessor;
use crate::error_code::internal_error;
use crate::error_code::invalid_request;
use codex_app_server_protocol::ClientResponsePayload;
use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::ThreadContextFile;
use codex_app_server_protocol::ThreadContextFileGroup;
use codex_app_server_protocol::ThreadContextFilesListParams;
use codex_app_server_protocol::ThreadContextFilesListResponse;
use codex_app_server_protocol::ThreadContextFilesSetParams;
use codex_app_server_protocol::ThreadContextFilesSetResponse;
use codex_app_server_protocol::ThreadElpisInstructionsReadParams;
use codex_app_server_protocol::ThreadElpisInstructionsReadResponse;
use codex_core::elpis_context::ContinuitySource;
use codex_core::elpis_context::ContinuitySourceCategory;
use codex_protocol::error::CodexErrorDetails;
use std::path::Path;

impl ThreadRequestProcessor {
    pub(crate) async fn thread_context_files_list(
        &self,
        params: ThreadContextFilesListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        let (_, thread) = self.load_thread(&params.thread_id).await?;
        let sources = thread
            .elpis_context_files()
            .await
            .map_err(context_files_error)?;
        Ok(Some(
            ThreadContextFilesListResponse {
                files: sources.into_iter().map(context_file).collect(),
            }
            .into(),
        ))
    }

    pub(crate) async fn thread_context_files_set(
        &self,
        params: ThreadContextFilesSetParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        let (_, thread) = self.load_thread(&params.thread_id).await?;
        let sources = thread
            .set_elpis_context_file_included(Path::new(&params.path), params.included)
            .await
            .map_err(context_files_error)?;
        Ok(Some(
            ThreadContextFilesSetResponse {
                files: sources.into_iter().map(context_file).collect(),
            }
            .into(),
        ))
    }

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

fn context_files_error(error: codex_protocol::error::CodexErr) -> JSONRPCErrorError {
    match error.details() {
        CodexErrorDetails::InvalidRequest(message) => invalid_request(message.clone()),
        _ => internal_error(format!("failed to access context files: {error}")),
    }
}

fn context_file(source: ContinuitySource) -> ThreadContextFile {
    ThreadContextFile {
        name: source.name,
        path: source.path.to_string_lossy().into_owned(),
        group: match source.category {
            ContinuitySourceCategory::Files => ThreadContextFileGroup::SessionContinuity,
            ContinuitySourceCategory::Memory => ThreadContextFileGroup::DurableMemory,
            ContinuitySourceCategory::Instructions => ThreadContextFileGroup::Instructions,
        },
        estimated_tokens: source.estimated_tokens,
        included: source.admitted,
        reason: source.reason.to_string(),
        selectable: source.selectable,
    }
}
