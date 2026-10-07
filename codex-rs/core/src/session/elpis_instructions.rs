//! Elpis: the Elpis instruction text this thread's next model request carries, read without
//! running a turn (`thread/elpisInstructions/read`).

use codex_protocol::error::Result as CodexResult;

use super::session::Session;
use crate::elpis_admission;
use crate::elpis_admission::ElpisInstructions;

impl Session {
    /// Each part comes from the path the next request takes: the session's developer
    /// instructions, the instruction refresh that applies Context Ledger admission, and the
    /// `elpis_continuity` World State section.
    pub(crate) async fn elpis_instructions(&self) -> CodexResult<ElpisInstructions> {
        let (config, developer_instructions) = {
            let state = self.state.lock().await;
            (
                self.build_effective_session_config(&state.session_configuration),
                state.session_configuration.developer_instructions.clone(),
            )
        };
        // The refresh a turn runs: it reuses the cached discovery while the environments are
        // unchanged and re-reads the Ledger's admission record every time.
        let environments = self.services.turn_environments.snapshot().await;
        let (agents_md, _warnings) = self
            .services
            .agents_md_manager
            .refresh(&config, &environments)
            .await;
        let continuity =
            elpis_admission::thread_continuity(&self.services.thread_extension_data).await;
        Ok(ElpisInstructions {
            developer_instructions: developer_instructions.filter(|text| !text.is_empty()),
            agents_md: agents_md?
                .map(|loaded| loaded.text())
                .filter(|text| !text.trim().is_empty()),
            continuity,
        })
    }
}
