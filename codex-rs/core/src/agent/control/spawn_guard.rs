//! Owns a spawned child until its initial input is accepted.

use crate::thread_manager::ThreadManagerState;
use codex_agent_graph_store::ThreadSpawnEdgeStatus;
use codex_protocol::ThreadId;
use codex_protocol::error::Result as CodexResult;
use std::sync::Arc;
use tokio::task::JoinHandle;
use tracing::warn;

pub(super) struct PendingSpawn {
    state: Arc<ThreadManagerState>,
    child: Option<ThreadId>,
    edge_write: Option<JoinHandle<CodexResult<()>>>,
}

impl PendingSpawn {
    pub(super) fn new(state: Arc<ThreadManagerState>, child: ThreadId) -> Self {
        Self {
            state,
            child: Some(child),
            edge_write: None,
        }
    }

    pub(super) fn set_edge_write(&mut self, edge_write: JoinHandle<CodexResult<()>>) {
        self.edge_write = Some(edge_write);
    }

    pub(super) async fn wait_for_edge(&mut self) -> CodexResult<()> {
        let mut result = Ok(());
        if let Some(edge_write) = self.edge_write.as_mut() {
            let joined = edge_write.await;
            assert!(joined.is_ok(), "spawn edge write task should complete");
            if let Ok(write) = joined {
                result = write;
            }
        }
        self.edge_write = None;
        result
    }

    pub(super) fn disarm(mut self) {
        self.child = None;
    }
}

impl Drop for PendingSpawn {
    fn drop(&mut self) {
        let Some(child) = self.child.take() else {
            return;
        };
        let state = Arc::clone(&self.state);
        let edge_write = self.edge_write.take();
        drop(tokio::spawn(async move {
            if let Some(thread) = state.remove_thread(&child).await {
                if let Err(error) = thread.shutdown_and_wait().await {
                    warn!("failed to stop cancelled child spawn: {error}");
                }
                if let Some(live_thread) = thread.session.live_thread()
                    && let Err(error) = live_thread.discard().await
                {
                    warn!("failed to discard cancelled child spawn: {error}");
                }
            }
            // A pending Open write must finish before cleanup writes Closed.
            if let Some(edge_write) = edge_write {
                let _ = edge_write.await;
            }
            if let Some(store) = state.agent_graph_store()
                && let Err(error) = store
                    .set_thread_spawn_edge_status(child, ThreadSpawnEdgeStatus::Closed)
                    .await
            {
                warn!("failed to close cancelled child spawn edge: {error}");
            }
        }));
    }
}
