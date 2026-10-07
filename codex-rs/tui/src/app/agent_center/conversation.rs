//! The selected task's recent turns as speaker blocks: who asked, the agent's replies and
//! its tool rows, each speaker labelled with its model in that model's colour.
//! Turns are fetched in the background when the selection changes; until they arrive, or if
//! they cannot be read, the details keep showing the prompt and last message.

use super::colors::agent_style;
use super::colors::thread_model;
use super::*;
use crate::app::agents_overview_details::preview_agent_message;
use crate::app::agents_overview_details::preview_markdown;
use crate::app::agents_overview_details::preview_text;
use crate::chatwidget::ChatWidget;
use crate::line_truncation::truncate_line_with_ellipsis_if_overflow;
use crate::wrapping::RtOptions;
use codex_app_server_protocol::ThreadItem;
use codex_app_server_protocol::Turn;
use std::collections::HashMap;

/// Turns requested for the selected task.
pub(in crate::app) const RECENT_TURNS: u32 = 3;
/// Entries kept from those turns, newest last.
const RECENT_ENTRIES: usize = 24;
/// Wrapped lines shown per message before it is cut with an ellipsis.
const MESSAGE_LINES: usize = 4;
/// Tasks whose conversation stays cached while the selection moves.
const CACHED_CONVERSATIONS: usize = 32;

#[derive(Clone, Debug, PartialEq)]
pub(in crate::app) enum ConversationEntry {
    /// A prompt: from the parent agent for a helper, otherwise from the user.
    Asked(String),
    Replied(String),
    Tool {
        summary: String,
        detail: Option<String>,
    },
}

/// Recent turns per task, keyed by the task's `updated_at` when they were read, so a task
/// that changed since is read again. At most one read runs at a time.
#[derive(Default)]
pub(in crate::app) struct AgentsOverviewConversations {
    /// `None` records a failed read, retried once the task changes.
    loaded: HashMap<ThreadId, (i64, Option<Vec<ConversationEntry>>)>,
    pending: Option<ThreadId>,
}

impl AgentsOverviewConversations {
    /// Claims the next read for `thread_id` when it has none, or one older than `updated_at`.
    pub(in crate::app) fn begin(&mut self, thread_id: ThreadId, updated_at: i64) -> bool {
        let fresh = self
            .loaded
            .get(&thread_id)
            .is_some_and(|(read_at, _)| *read_at >= updated_at);
        if fresh || self.pending.is_some() {
            return false;
        }
        self.pending = Some(thread_id);
        true
    }

    pub(in crate::app) fn finish(
        &mut self,
        thread_id: ThreadId,
        updated_at: i64,
        entries: Option<Vec<ConversationEntry>>,
    ) {
        if self.pending == Some(thread_id) {
            self.pending = None;
        }
        if self.loaded.len() >= CACHED_CONVERSATIONS {
            self.loaded.clear();
        }
        self.loaded.insert(thread_id, (updated_at, entries));
    }

    pub(in crate::app) fn entries(&self, thread_id: ThreadId) -> Option<&[ConversationEntry]> {
        self.loaded
            .get(&thread_id)
            .and_then(|(_, entries)| entries.as_deref())
    }
}

/// Conversation entries from turns listed newest first, oldest entry first.
pub(in crate::app) fn conversation_entries(turns: Vec<Turn>) -> Vec<ConversationEntry> {
    let mut entries = turns
        .into_iter()
        .rev()
        .flat_map(|turn| turn.items)
        .filter_map(|item| match item {
            ThreadItem::UserMessage { content, .. } => {
                let text = ChatWidget::user_message_display_from_inputs(&content).message;
                (!text.trim().is_empty()).then(|| ConversationEntry::Asked(preview_markdown(&text)))
            }
            ThreadItem::AgentMessage { text, .. } => (!text.trim().is_empty())
                .then(|| ConversationEntry::Replied(preview_agent_message(&text))),
            ThreadItem::CommandExecution {
                command,
                aggregated_output,
                ..
            } => Some(ConversationEntry::Tool {
                summary: format!("Ran {command}"),
                detail: aggregated_output.as_deref().and_then(first_line),
            }),
            ThreadItem::McpToolCall { server, tool, .. } => Some(ConversationEntry::Tool {
                summary: format!("Called {server}.{tool}"),
                detail: None,
            }),
            ThreadItem::DynamicToolCall { tool, .. } => Some(ConversationEntry::Tool {
                summary: format!("Called {tool}"),
                detail: None,
            }),
            ThreadItem::FileChange { changes, .. } => Some(ConversationEntry::Tool {
                summary: match changes.as_slice() {
                    [change] => format!("Edited {}", change.path),
                    changes => format!("Edited {} files", changes.len()),
                },
                detail: None,
            }),
            _ => None,
        })
        .collect::<Vec<_>>();
    entries.drain(..entries.len().saturating_sub(RECENT_ENTRIES));
    entries
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(preview_text)
}

impl AgentsOverviewView {
    /// Speaker blocks for `row`, oldest first, each line prefixed with its speaker's bar.
    fn conversation_lines(
        &self,
        row: &AgentsOverviewRow,
        entries: &[ConversationEntry],
        width: usize,
    ) -> Vec<Line<'static>> {
        let colors = self.use_theme_colors;
        let agent_model = thread_model(&row.thread);
        let agent_name = row
            .model_name
            .clone()
            .unwrap_or_else(|| "Agent".to_string());
        let agent = agent_style(agent_model, Style::default(), colors);
        let parent = row.parent.map(|index| &self.rows[index]);
        let mut lines: Vec<Line<'static>> = Vec::new();
        let mut replying = false;
        for entry in entries {
            let (bar, starts_block) = match entry {
                ConversationEntry::Asked(_) => {
                    let asker = parent.and_then(|parent| thread_model(&parent.thread));
                    (agent_style(asker, Style::default(), colors), true)
                }
                ConversationEntry::Replied(_) | ConversationEntry::Tool { .. } => {
                    (agent, !replying)
                }
            };
            let bar = Span::styled("▌ ", bar);
            if starts_block {
                if !lines.is_empty() {
                    lines.push(Line::default());
                }
                let mut label = vec![bar.clone()];
                match (entry, parent) {
                    (ConversationEntry::Asked(_), Some(parent)) => {
                        label.push(Span::styled(
                            parent
                                .model_name
                                .clone()
                                .unwrap_or_else(|| "Parent".to_string()),
                            agent_style(thread_model(&parent.thread), Style::default(), colors)
                                .bold(),
                        ));
                        label.push(" → ".dim());
                        label.push(Span::styled(agent_name.clone(), agent.bold()));
                    }
                    (ConversationEntry::Asked(_), None) => label.push("You".bold()),
                    _ => label.push(Span::styled(agent_name.clone(), agent.bold())),
                }
                lines.push(truncate_line_with_ellipsis_if_overflow(
                    Line::from(label),
                    width,
                ));
            }
            replying = !matches!(entry, ConversationEntry::Asked(_));
            match entry {
                ConversationEntry::Asked(text) | ConversationEntry::Replied(text) => {
                    let indent = Line::from(bar.clone());
                    let mut wrapped = crate::wrapping::word_wrap_lines(
                        text.lines()
                            .filter(|line| !line.trim().is_empty())
                            .map(str::to_owned),
                        RtOptions::new(width)
                            .initial_indent(indent.clone())
                            .subsequent_indent(indent),
                    );
                    if wrapped.len() > MESSAGE_LINES {
                        wrapped.truncate(MESSAGE_LINES);
                        wrapped[MESSAGE_LINES - 1] = Line::from(vec![bar.clone(), "…".dim()]);
                    }
                    lines.extend(wrapped);
                }
                ConversationEntry::Tool { summary, detail } => {
                    lines.push(truncate_line_with_ellipsis_if_overflow(
                        Line::from(vec![bar.clone(), "• ".dim(), summary.clone().into()]),
                        width,
                    ));
                    if let Some(detail) = detail {
                        lines.push(truncate_line_with_ellipsis_if_overflow(
                            Line::from(vec![bar.clone(), "  └ ".dim(), detail.clone().dim()]),
                            width,
                        ));
                    }
                }
            }
        }
        lines
    }

    /// Details for a task whose recent turns have arrived: a short header, then as much of
    /// the conversation as fits, newest at the bottom.
    pub(in crate::app::agents_overview_view) fn render_conversation_details(
        &self,
        row: &AgentsOverviewRow,
        title: Line<'static>,
        model: Span<'static>,
        entries: &[ConversationEntry],
        area: Rect,
        buf: &mut Buffer,
    ) {
        let width = usize::from(area.width);
        let mut status = self.status_spans(row, Style::default(), /*selected*/ false);
        status.extend(["  ".into(), model]);
        if let Some(parent) = row.parent.map(|index| &self.rows[index]) {
            status.extend([
                " · asked by ".dim(),
                Span::styled(
                    parent
                        .model_name
                        .clone()
                        .unwrap_or_else(|| display_title(&parent.thread).to_owned()),
                    self.agent_style(parent, Style::default()),
                ),
            ]);
        }
        let mut header = vec![
            Line::from("Task details".bold()),
            Line::default(),
            title,
            Line::from(status),
        ];
        header.extend(row.details.lines.clone());
        header.extend(row.details.usage_lines.clone());
        header.push(Line::default());
        let mut lines = crate::wrapping::word_wrap_lines(header, width);
        let available = usize::from(area.height).saturating_sub(lines.len());
        let mut conversation = self.conversation_lines(row, entries, width);
        if conversation.len() > available {
            conversation.drain(..conversation.len() - available);
            if let Some(first) = conversation.first_mut() {
                *first = "…".dim().into();
            }
        }
        lines.extend(conversation);
        Paragraph::new(lines).render(area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn reads_wait_for_the_current_one_and_repeat_only_after_a_change() {
        let [first, second] = [1, 2].map(ThreadId::from_u128);
        let mut conversations = AgentsOverviewConversations::default();
        assert!(conversations.begin(first, /*updated_at*/ 10));
        assert!(!conversations.begin(second, /*updated_at*/ 10));
        conversations.finish(first, /*updated_at*/ 10, Some(Vec::new()));
        assert!(!conversations.begin(first, /*updated_at*/ 10));
        assert!(conversations.begin(second, /*updated_at*/ 10));
        conversations.finish(second, /*updated_at*/ 10, /*entries*/ None);
        assert_eq!(conversations.entries(second), None);
        assert!(!conversations.begin(second, /*updated_at*/ 10));
        assert!(conversations.begin(second, /*updated_at*/ 11));
    }
}
