//! Task grouping modes share model labels and group membership across rendering and navigation.

use super::AgentsOverviewView;
use codex_app_server_protocol::Thread;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in super::super) enum AgentsOverviewGrouping {
    #[default]
    Project,
    Status,
    Model,
}

pub(super) fn model_name(thread: &Thread) -> &str {
    thread
        .model
        .as_deref()
        .filter(|model| !model.is_empty())
        .unwrap_or("Unknown")
}

impl AgentsOverviewView {
    pub(super) fn same_group(
        &self,
        grouping: AgentsOverviewGrouping,
        left: usize,
        right: usize,
    ) -> bool {
        // Helpers belong to their top-level task's group, so a tree is never split.
        let (left, right) = (
            &self.rows[self.rows[left].root],
            &self.rows[self.rows[right].root],
        );
        match grouping {
            AgentsOverviewGrouping::Project => {
                self.project_groups[left.root].key == self.project_groups[right.root].key
            }
            AgentsOverviewGrouping::Status => left.tree_group == right.tree_group,
            AgentsOverviewGrouping::Model => model_name(&left.thread) == model_name(&right.thread),
        }
    }
}
