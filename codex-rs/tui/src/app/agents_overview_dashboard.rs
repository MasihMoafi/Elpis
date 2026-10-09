//! Feeds the dashboard's Agents map with the agents this overview knows: each top-level task
//! and the helpers it started. The list on screen is Codex's own; only its data is shared.

use super::agents_overview_group;
use crate::app::App;
use crate::app::agents_overview_view::AgentsOverviewGroup;
use crate::dashboard_server::DashboardAgent;
use crate::dashboard_server::DashboardAgentStatus;
use codex_app_server_protocol::SessionSource;
use codex_app_server_protocol::Thread;
use codex_protocol::ThreadId;
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::SubAgentSource;
use std::collections::HashMap;
use std::collections::HashSet;

const CLAUDE: (u8, u8, u8) = (0xb4, 0x53, 0x2a);
const SOL: (u8, u8, u8) = (0x0b, 0x7a, 0x5e);
const GEMINI: (u8, u8, u8) = (0x1a, 0x5f, 0xd0);
const LUNA: (u8, u8, u8) = (0x6d, 0x3f, 0xb5);
/// Hues for every other model, away from the family hues.
const OTHERS: [(u8, u8, u8); 4] = [
    (0xa3, 0x30, 0x7a),
    (0x5c, 0x7a, 0x0f),
    (0x00, 0x70, 0x8c),
    (0x7a, 0x52, 0x30),
];

/// The model's hue as `#rrggbb`; the Agents map draws each agent with it.
fn agent_hex(model: &str) -> String {
    let model = model.to_ascii_lowercase();
    let (r, g, b) = if model.starts_with("claude/") {
        CLAUDE
    } else if model.starts_with("agy/") {
        GEMINI
    } else if model.starts_with("gpt-6") && model.contains("luna") {
        LUNA
    } else if model.starts_with("gpt-6") && model.contains("sol") {
        SOL
    } else {
        // Explicit FNV-1a, so a model keeps its colour across runs and Rust versions.
        let hash = model.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
        OTHERS[(hash % OTHERS.len() as u64) as usize]
    };
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// `Model · effort`, without repeating an effort the model's name already carries.
fn model_label(name: &str, effort: Option<&ReasoningEffort>) -> String {
    match effort.map(ReasoningEffort::as_str) {
        Some(effort) if !name.to_ascii_lowercase().contains(&format!("({effort})")) => {
            format!("{name} · {effort}")
        }
        _ => name.to_string(),
    }
}

/// The task that started `thread`, whether the server reports it or the session source does.
fn parent_id(thread: &Thread) -> Option<String> {
    thread.parent_thread_id.clone().or_else(|| match &thread.source {
        SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
            parent_thread_id, ..
        }) => Some(parent_thread_id.to_string()),
        _ => None,
    })
}

fn title(thread: &Thread) -> &str {
    let title = thread.name.as_deref().unwrap_or(&thread.preview);
    title.trim().lines().next().unwrap_or("Untitled task")
}

impl App {
    /// Replaces the Agents map's agents while the dashboard is running.
    pub(super) fn publish_dashboard_agents(&self, threads: &[Thread]) {
        if crate::dashboard_server::is_running() {
            crate::dashboard_server::publish_agents(self.dashboard_agents(threads));
        }
    }

    /// Top-level tasks in the list's order, each followed by its helpers, newest first. A
    /// helper whose parent is not known stays out, as it does in the list.
    pub(super) fn dashboard_agents(&self, threads: &[Thread]) -> Vec<DashboardAgent> {
        let threads = threads
            .iter()
            .filter(|thread| !thread.ephemeral)
            .collect::<Vec<_>>();
        let mut children: HashMap<String, Vec<&Thread>> = HashMap::new();
        for thread in threads.iter().copied() {
            if let Some(parent) = parent_id(thread) {
                children.entry(parent).or_default().push(thread);
            }
        }
        for siblings in children.values_mut() {
            siblings.sort_by(|left, right| {
                right
                    .updated_at
                    .cmp(&left.updated_at)
                    .then_with(|| left.id.cmp(&right.id))
            });
        }
        let mut roots = threads
            .iter()
            .copied()
            .filter(|thread| parent_id(thread).is_none())
            .map(|root| (root, agents_overview_group(root, &children)))
            .collect::<Vec<_>>();
        roots.sort_by(|(left, left_group), (right, right_group)| {
            left_group
                .cmp(right_group)
                .then_with(|| right.updated_at.cmp(&left.updated_at))
                .then_with(|| left.id.cmp(&right.id))
        });

        let mut agents = Vec::new();
        let mut placed = HashSet::new();
        for (root, _) in roots {
            let mut pending = vec![root];
            while let Some(thread) = pending.pop() {
                let Ok(thread_id) = ThreadId::from_string(&thread.id) else {
                    continue;
                };
                if self.agents_overview.hidden_threads.contains(&thread_id)
                    || !placed.insert(thread_id)
                {
                    continue;
                }
                agents.push(self.dashboard_agent(thread));
                pending.extend(
                    children
                        .get(&thread.id)
                        .into_iter()
                        .flatten()
                        .rev()
                        .copied(),
                );
            }
        }
        agents
    }

    fn dashboard_agent(&self, thread: &Thread) -> DashboardAgent {
        let model = thread.model.as_deref().filter(|model| !model.is_empty());
        let (status, status_label) = match AgentsOverviewGroup::for_status(&thread.status) {
            AgentsOverviewGroup::NeedsYou => (DashboardAgentStatus::NeedsYou, "Needs input"),
            AgentsOverviewGroup::Working => (DashboardAgentStatus::Working, "Working"),
            AgentsOverviewGroup::Ready => (DashboardAgentStatus::Ready, "Ready"),
            AgentsOverviewGroup::Finished => (DashboardAgentStatus::Inactive, "Inactive"),
        };
        DashboardAgent {
            id: thread.id.clone(),
            parent_id: parent_id(thread),
            title: title(thread).to_string(),
            model: model.map(|model| {
                model_label(
                    self.model_catalog.display_name(model),
                    thread.reasoning_effort.as_ref(),
                )
            }),
            color: model.map(agent_hex),
            status,
            status_label: status_label.to_string(),
        }
    }
}

#[cfg(test)]
#[path = "agents_overview_dashboard_tests.rs"]
mod tests;
