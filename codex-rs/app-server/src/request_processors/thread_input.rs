use super::invalid_request;
use codex_app_server_protocol::JSONRPCErrorError;
use codex_core::CodexThread;
use codex_protocol::protocol::MultiAgentVersion;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_protocol::protocol::ThreadSource;

pub(super) const DIRECT_INPUT_TO_MULTI_AGENT_V2_SUBAGENT_ERROR: &str =
    "direct app-server input is not allowed for multi-agent v2 sub-agents";

/// Mirrors the ownership policy in request validation and thread capability responses.
pub(super) fn can_accept_direct_input(
    multi_agent_version: Option<MultiAgentVersion>,
    session_source: &SessionSource,
    thread_source: Option<&ThreadSource>,
) -> bool {
    // Exec workers carry ancestry for navigation, but have no controller-owned agent path.
    let user_worker = matches!(thread_source, Some(ThreadSource::User))
        && matches!(
            session_source,
            SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                agent_path: None,
                ..
            })
        );
    user_worker
        || multi_agent_version != Some(MultiAgentVersion::V2)
        || !matches!(
            session_source,
            SessionSource::SubAgent(SubAgentSource::ThreadSpawn { .. })
        )
}

pub(super) async fn ensure_direct_input_allowed(
    thread: &CodexThread,
) -> Result<(), JSONRPCErrorError> {
    let config_snapshot = thread.config_snapshot().await;
    if !can_accept_direct_input(
        thread.multi_agent_version(),
        &config_snapshot.session_source,
        config_snapshot.thread_source.as_ref(),
    ) {
        return Err(invalid_request(
            DIRECT_INPUT_TO_MULTI_AGENT_V2_SUBAGENT_ERROR,
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::AgentPath;
    use codex_protocol::ThreadId;

    #[test]
    fn v2_exec_worker_accepts_input_without_relaxing_owned_agents() {
        for (agent_path, thread_source, expected) in [
            (None, Some(ThreadSource::User), true),
            (None, None, false),
            (None, Some(ThreadSource::Subagent), false),
            (Some(AgentPath::root()), Some(ThreadSource::User), false),
        ] {
            let source = SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id: ThreadId::new(),
                depth: 1,
                agent_path,
                agent_nickname: None,
                agent_role: None,
            });
            assert_eq!(
                can_accept_direct_input(
                    Some(MultiAgentVersion::V2),
                    &source,
                    thread_source.as_ref()
                ),
                expected,
            );
        }
        assert!(can_accept_direct_input(
            Some(MultiAgentVersion::V2),
            &SessionSource::Exec,
            None
        ));
    }
}
