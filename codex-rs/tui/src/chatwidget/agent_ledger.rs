use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;

use super::ChatWidget;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentLedgerEntry {
    pub(crate) task: String,
    pub(crate) status: &'static str,
    pub(crate) activity: Option<String>,
}

impl ChatWidget {
    pub(crate) fn set_agent_ledger(&mut self, entries: Vec<AgentLedgerEntry>) {
        if self.agent_ledger != entries {
            self.agent_ledger = entries;
            self.request_redraw();
        }
    }

    pub(super) fn agent_ledger_lines(&self, width: usize) -> Vec<Line<'static>> {
        if self.agent_ledger.is_empty() {
            return Vec::new();
        }
        let muted = Style::default().fg(crate::style::adaptive_palette_color(
            crate::terminal_palette::default_bg(),
            (80, 81, 75),
            (160, 162, 155),
        ));
        let mut lines = vec![Line::from(Span::styled(
            format!("SUBAGENT LEDGER · {}", self.agent_ledger.len()),
            crate::style::brand_style().bold(),
        ))];
        lines.push(Line::from(Span::styled(
            "/agent to inspect or switch",
            muted,
        )));
        for entry in self.agent_ledger.iter().take(6) {
            lines.push(Line::from(vec![
                Span::styled(format!("{} · ", entry.status), crate::style::brand_style()),
                Span::raw(crate::text_formatting::truncate_text(
                    &entry.task,
                    width.saturating_sub(entry.status.len() + 3).max(1),
                )),
            ]));
            if let Some(activity) = &entry.activity {
                lines.push(Line::from(Span::styled(
                    crate::text_formatting::truncate_text(activity, width.max(1)),
                    muted,
                )));
            }
        }
        if self.agent_ledger.len() > 6 {
            lines.push(Line::from(Span::styled(
                format!("+{} more · /agent", self.agent_ledger.len() - 6),
                muted,
            )));
        }
        lines.push(Line::default());
        lines
    }
}
