//! Provider identity is independent of urgency and remains colored on selected rows.

use super::*;
use ratatui::style::Color;

impl AgentsOverviewView {
    pub(super) fn provider_label(row: &AgentsOverviewRow) -> &str {
        let provider = row.thread.model_provider.to_ascii_lowercase();
        if provider.contains("anthropic") || provider.contains("claude") {
            "Anthropic"
        } else if provider.contains("openai") || provider == "codex" || provider == "chatgpt" {
            "OpenAI"
        } else if provider.contains("google") || provider.contains("gemini") || provider == "agy" {
            "Google"
        } else {
            &row.thread.model_provider
        }
    }

    pub(super) fn surface_background(style: Style) -> Option<(u8, u8, u8)> {
        match style.bg {
            Some(Color::Rgb(r, g, b)) => Some((r, g, b)),
            Some(Color::Indexed(index)) if index >= 16 => {
                Some(crate::terminal_palette::XTERM_COLORS[usize::from(index)])
            }
            _ => crate::terminal_palette::default_bg(),
        }
    }

    pub(super) fn provider_style(&self, row: &AgentsOverviewRow, surface: Style) -> Style {
        if !self.use_theme_colors {
            return Style::default();
        }
        let background = Self::surface_background(surface);
        let light = background.is_some_and(crate::color::is_light);
        let preferred = match (Self::provider_label(row), light) {
            ("Anthropic", true) => (180, 83, 42),
            ("Anthropic", false) => (236, 164, 121),
            ("OpenAI", true) => (11, 122, 94),
            ("OpenAI", false) => (87, 204, 160),
            ("Google", true) => (26, 95, 208),
            ("Google", false) => (117, 173, 255),
            (_, true) => (109, 63, 181),
            (_, false) => (191, 153, 246),
        };
        Style::default()
            .fg(crate::style::readable_color(preferred, background))
            .not_dim()
    }

    pub(super) fn status_style(row: &AgentsOverviewRow, surface: Style) -> Style {
        let background = Self::surface_background(surface);
        let light = background.is_some_and(crate::color::is_light);
        let preferred = match (row.group, light) {
            (AgentsOverviewGroup::NeedsYou, true) => (171, 36, 43),
            (AgentsOverviewGroup::NeedsYou, false) => (255, 132, 132),
            (AgentsOverviewGroup::Working, true) => (137, 91, 0),
            (AgentsOverviewGroup::Working, false) => (235, 198, 75),
            (AgentsOverviewGroup::Done, true) => (11, 122, 94),
            (AgentsOverviewGroup::Done, false) => (87, 204, 160),
            (_, true) => (100, 108, 120),
            (_, false) => (171, 181, 195),
        };
        Style::default()
            .fg(crate::style::readable_color(preferred, background))
            .not_dim()
    }

    pub(super) fn tree_prefix(&self, index: usize) -> String {
        let mut lineage = Vec::new();
        let mut node = index;
        while let Some(parent) = self.parent_index(node) {
            if lineage.len() >= self.rows.len() {
                break;
            }
            let parent_id = self.rows[parent].thread.id.as_str();
            let has_later_sibling = self.rows[node + 1..]
                .iter()
                .any(|candidate| candidate.thread.parent_thread_id.as_deref() == Some(parent_id));
            lineage.push(has_later_sibling);
            node = parent;
        }
        lineage.reverse();
        let depth = lineage.len();
        lineage
            .into_iter()
            .enumerate()
            .map(|(level, later)| {
                if level + 1 == depth {
                    if later { "├─" } else { "└─" }
                } else if later {
                    "│ "
                } else {
                    "  "
                }
            })
            .collect()
    }
}
