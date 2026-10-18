//! Elpis: the Elpis instruction text this thread's next model request carries, read without
//! running a turn (`thread/elpisInstructions/read`).

use codex_protocol::error::Result as CodexResult;

use super::session::Session;
use crate::elpis_admission;
use crate::elpis_admission::ElpisInstructions;
use crate::elpis_context;
use crate::elpis_context::ContinuitySource;
use codex_protocol::error::CodexErr;
use std::path::Path;

impl Session {
    /// Discover through the runtime's permission-aware instruction loader, then use the
    /// same source and manual-memory readers as the TUI's Ledger.
    pub(crate) async fn elpis_context_files(&self) -> CodexResult<Vec<ContinuitySource>> {
        let config = {
            let state = self.state.lock().await;
            self.build_effective_session_config(&state.session_configuration)
        };
        self.elpis_context_files_for_config(&config).await
    }

    async fn elpis_context_files_for_config(
        &self,
        config: &crate::config::Config,
    ) -> CodexResult<Vec<ContinuitySource>> {
        let environments = self.services.turn_environments.snapshot().await;
        let (loaded, _) = self
            .services
            .agents_md_manager
            .refresh_for_elpis(config, &environments)
            .await;
        loaded?;
        // The manager retains every discovered path, including excluded instruction files.
        let paths = self
            .instruction_sources()
            .await
            .into_iter()
            .map(|path| path.to_path_buf())
            .collect::<Vec<_>>();
        let memories = elpis_admission::memory_dir(config);
        let roots = elpis_admission::dev_rule_roots(config);
        let cwd = config.cwd.clone();
        let thread_id = self.thread_id.to_string();
        tokio::task::spawn_blocking(move || {
            let status =
                elpis_context::manual_memory_status(Some(memories.as_path()), cwd.as_path())
                    .map_err(std::io::Error::other)?;
            elpis_context::continuity_sources_from_manual_memory_status(
                Some(memories.as_path()),
                cwd.as_path(),
                &paths,
                &roots,
                status.as_ref(),
                Some(&thread_id),
            )
            .map_err(CodexErr::from)
        })
        .await
        .map_err(|error| CodexErr::Fatal(format!("context file reader failed: {error}")))?
    }

    pub(crate) async fn set_elpis_context_file_included(
        &self,
        path: &Path,
        included: bool,
    ) -> CodexResult<Vec<ContinuitySource>> {
        let config = {
            let state = self.state.lock().await;
            self.build_effective_session_config(&state.session_configuration)
        };
        let sources = self.elpis_context_files_for_config(&config).await?;
        let source = sources
            .into_iter()
            .find(|source| source.path == path && source.selectable)
            .ok_or_else(|| {
                CodexErr::InvalidRequest(format!("unknown context file: {}", path.display()))
            })?;
        let memories = elpis_admission::memory_dir(&config);
        let cwd = config.cwd.clone();
        tokio::task::spawn_blocking(move || {
            elpis_context::set_continuity_source_admitted(
                Some(memories.as_path()),
                cwd.as_path(),
                &source.name,
                included,
            )
        })
        .await
        .map_err(|error| CodexErr::Fatal(format!("context file writer failed: {error}")))??;
        self.elpis_context_files_for_config(&config).await
    }

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
        // A bridge cannot observe the native instruction cache. Rediscover through the same
        // serialized, permission-aware loader so edits and withdrawals reach its next turn.
        let environments = self.services.turn_environments.snapshot().await;
        let (agents_md, _warnings) = self
            .services
            .agents_md_manager
            .refresh_for_elpis(&config, &environments)
            .await;
        let continuity =
            elpis_admission::thread_continuity(&self.services.thread_extension_data).await;
        let personal = crate::elpis_personal::instructions(config.codex_home.as_path()).await;
        let continuity = match (continuity, personal) {
            (Some(continuity), Some(personal)) => Some(format!("{continuity}\n\n{personal}")),
            (continuity, personal) => continuity.or(personal),
        };
        Ok(ElpisInstructions {
            developer_instructions: developer_instructions.filter(|text| !text.is_empty()),
            agents_md: agents_md?
                .map(|loaded| loaded.text())
                .filter(|text| !text.trim().is_empty()),
            continuity,
        })
    }
}
