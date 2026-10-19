use super::thread_processor::ThreadRequestProcessor;
use super::*;
use codex_app_server_protocol::ThreadApprovalReviewDecision;
use codex_app_server_protocol::ThreadApprovalReviewParams;
use codex_app_server_protocol::ThreadApprovalReviewResponse;

impl ThreadRequestProcessor {
    pub(crate) async fn thread_approval_review(
        &self,
        params: ThreadApprovalReviewParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        if params.command.trim().is_empty() {
            return Err(invalid_request("command must not be empty"));
        }
        if !std::path::Path::new(&params.cwd).is_absolute() {
            return Err(invalid_request("review cwd must be absolute"));
        }
        let cwd = AbsolutePathBuf::try_from(params.cwd)
            .map_err(|error| invalid_request(format!("invalid review cwd: {error}")))?;
        let (_, thread) = self.load_thread(&params.thread_id).await?;
        let (approved, rationale) = thread
            .review_bridged_command(params.command, cwd, params.reason)
            .await
            .map_err(|error| internal_error(error.to_string()))?;
        Ok(Some(
            ThreadApprovalReviewResponse {
                decision: if approved {
                    ThreadApprovalReviewDecision::Approved
                } else {
                    ThreadApprovalReviewDecision::Denied
                },
                rationale,
            }
            .into(),
        ))
    }
}
