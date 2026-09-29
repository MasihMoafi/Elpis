//! Elpis: value types for the Context Ledger's Manual Memory events and `/context` report.
//!
//! Copied from v0.3.0 `app_event.rs` and `app_backtrack.rs`. The events themselves are
//! `ElpisAppEvent` variants (elpis_app_event.rs).

use std::any::TypeId;
use std::path::PathBuf;
use std::sync::Arc;

use codex_protocol::ThreadId;

use crate::history_cell::AgentMessageCell;
use crate::history_cell::SessionInfoCell;
use crate::history_cell::UserHistoryCell;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManualMemoryViewKey {
    pub(crate) epoch: u64,
    pub(crate) primary_root_thread_id: ThreadId,
    pub(crate) displayed_thread_id: ThreadId,
    pub(crate) cwd: PathBuf,
    pub(crate) memory_path: PathBuf,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct ManualMemoryStorageTarget {
    pub(crate) admission_path: PathBuf,
    pub(crate) memory_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManualMemoryRequestTarget {
    pub(crate) view: ManualMemoryViewKey,
    pub(crate) storage: ManualMemoryStorageTarget,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ManualMemoryUnavailableReason {
    AdmissionUnavailable,
    MemoryUnreadable,
    InvalidUtf8,
    MemoryPathNotFile,
    SourcesUnavailable,
    WorkerFailed,
}

impl From<crate::legacy_core::elpis_context::ManualMemoryUnavailableReason>
    for ManualMemoryUnavailableReason
{
    fn from(reason: crate::legacy_core::elpis_context::ManualMemoryUnavailableReason) -> Self {
        use crate::legacy_core::elpis_context::ManualMemoryUnavailableReason as CoreReason;
        match reason {
            CoreReason::AdmissionUnavailable => Self::AdmissionUnavailable,
            CoreReason::MemoryUnreadable => Self::MemoryUnreadable,
            CoreReason::InvalidUtf8 => Self::InvalidUtf8,
            CoreReason::MemoryPathNotFile => Self::MemoryPathNotFile,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ManualMemoryStatusCompletion {
    Ready {
        status: crate::legacy_core::elpis_context::ManualMemoryStatus,
        sources: Vec<crate::legacy_core::elpis_context::ContinuitySource>,
    },
    Unavailable(ManualMemoryUnavailableReason),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ManualMemoryMutation {
    Create,
    Admission { admitted: bool },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ManualMemoryMutationFailure {
    AlreadyExists,
    Missing,
    StorageUnavailable,
    PersistenceFailed,
    WorkerFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ManualMemoryMutationCompletion {
    Succeeded,
    Failed(ManualMemoryMutationFailure),
}

/// Rough transcript composition for the `/context` command's category breakdown.
///
/// This counts what is currently rendered in the transcript, not the model's exact
/// next-request payload: pruned/evicted tool output and the static system prompt/tool
/// schemas are not part of `transcript_cells`. Treat these as an estimate, the same way
/// the Context Ledger already labels its own per-source sizes as estimated tokens.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ContextUsageTranscriptTotals {
    pub(crate) checkpoints: usize,
    pub(crate) user_message_bytes: usize,
    pub(crate) agent_response_bytes: usize,
    pub(crate) tool_activity_bytes: usize,
}

pub(crate) fn context_usage_totals(
    cells: &[Arc<dyn crate::history_cell::HistoryCell>],
) -> ContextUsageTranscriptTotals {
    let session_start_type = TypeId::of::<SessionInfoCell>();
    let type_of = |cell: &Arc<dyn crate::history_cell::HistoryCell>| cell.as_any().type_id();

    let start = cells
        .iter()
        .rposition(|cell| type_of(cell) == session_start_type)
        .map_or(0, |idx| idx + 1);

    let mut totals = ContextUsageTranscriptTotals {
        checkpoints: crate::app_backtrack::user_count(cells),
        user_message_bytes: 0,
        agent_response_bytes: 0,
        tool_activity_bytes: 0,
    };

    fn classify_and_tally(
        cell: &dyn crate::history_cell::HistoryCell,
        totals: &mut ContextUsageTranscriptTotals,
    ) {
        let kind = cell.as_any().type_id();
        if kind == TypeId::of::<SessionInfoCell>() {
            return;
        }
        if kind == TypeId::of::<crate::history_cell::CompositeHistoryCell>() {
            if let Some(composite) = cell
                .as_any()
                .downcast_ref::<crate::history_cell::CompositeHistoryCell>()
            {
                for part in &composite.parts {
                    classify_and_tally(part.as_ref(), totals);
                }
                return;
            }
        }

        let bytes: usize = cell
            .raw_lines()
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.len())
                    .sum::<usize>()
            })
            .sum();

        if bytes == 0 {
            return;
        }

        if kind == TypeId::of::<UserHistoryCell>() {
            totals.user_message_bytes += bytes;
        } else if kind == TypeId::of::<AgentMessageCell>()
            || kind == TypeId::of::<crate::history_cell::AgentMarkdownCell>()
            || kind == TypeId::of::<crate::history_cell::StreamingAgentTailCell>()
            || kind == TypeId::of::<crate::history_cell::ReasoningSummaryCell>()
        {
            totals.agent_response_bytes += bytes;
        } else if kind == TypeId::of::<crate::history_cell::UnifiedExecInteractionCell>()
            || kind == TypeId::of::<crate::history_cell::HookCell>()
            || kind == TypeId::of::<crate::history_cell::McpToolCallCell>()
            || kind == TypeId::of::<crate::history_cell::PatchHistoryCell>()
            || kind == TypeId::of::<crate::history_cell::WebSearchCell>()
        {
            totals.tool_activity_bytes += bytes;
        } else if kind == TypeId::of::<crate::history_cell::PlainHistoryCell>()
            || kind == TypeId::of::<crate::history_cell::FinalMessageSeparator>()
            || kind == TypeId::of::<crate::history_cell::UpdateAvailableHistoryCell>()
        {
            // System UI / Plain output / Separators
        } else {
            totals.tool_activity_bytes += bytes;
        }
    }

    let tally = |totals: &mut ContextUsageTranscriptTotals, start: usize| {
        for cell in cells.iter().skip(start) {
            classify_and_tally(cell.as_ref(), totals);
        }
    };

    tally(&mut totals, start);
    // A resumed session appends its banner AFTER the replayed history, so counting
    // only past the last banner yields an empty conversation. When that happens but
    // earlier cells exist, count the whole transcript instead of reporting zeros.
    if start > 0
        && totals.user_message_bytes == 0
        && totals.agent_response_bytes == 0
        && totals.tool_activity_bytes == 0
    {
        tally(&mut totals, 0);
    }

    totals
}
