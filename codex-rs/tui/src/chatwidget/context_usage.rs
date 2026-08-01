//! `/context` command: a colored context-usage grid with a side-by-side per-category
//! legend (grid left, numbers right), a Checkpoints section backed by Elpis's real
//! backtrack mechanism, and a System files (auto-loaded) section backed by the same
//! admitted-source list the Context Ledger renders.
//!
//! ## The math is anchored to one exact number
//!
//! The only exact figure available here is total tokens currently in context
//! (`token_info.last_token_usage`, same source the status line uses — the headline
//! percentage is computed with the status line's own formula so the two can never
//! disagree). System prompt and Skills are fixed on-disk costs and are shown at
//! their raw estimates, never scaled. The remaining budget (used − fixed) is split
//! proportionally across the user/agent/tool transcript estimates; whatever cannot
//! be attributed lands in an explicit "Other (overhead)" row instead of silently
//! inflating a named category.

use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;

use super::ChatWidget;
use crate::app_backtrack::ContextUsageTranscriptTotals;
use crate::history_cell::PlainHistoryCell;
use crate::legacy_core::elpis_context::ContinuitySourceCategory;

const GRID_COLUMNS: usize = 26;
const GRID_ROWS: usize = 10;
const GRID_CELLS: usize = GRID_COLUMNS * GRID_ROWS;

struct CategoryUsage {
    label: &'static str,
    tokens: u64,
    color: Color,
}

impl ChatWidget {
    pub(crate) fn add_context_usage_output(&mut self, totals: ContextUsageTranscriptTotals) {
        let sources = self.continuity_sources();
        // Only admitted sources are actually in context; non-admitted discovered
        // files must not inflate the System prompt / Skills buckets.
        let instruction_sources: Vec<_> = sources
            .iter()
            .filter(|source| {
                source.category == ContinuitySourceCategory::Instructions && source.admitted
            })
            .collect();
        let is_skill_path = |path: &std::path::Path| {
            path.components()
                .any(|component| component.as_os_str() == "skills")
        };
        let system_prompt_chars: usize = instruction_sources
            .iter()
            .filter(|source| !is_skill_path(&source.path))
            .map(|source| source.bytes as usize)
            .sum();
        let skills_chars: usize = instruction_sources
            .iter()
            .filter(|source| is_skill_path(&source.path))
            .map(|source| source.bytes as usize)
            .sum();

        let estimate =
            |chars: usize| codex_utils_string::approx_tokens_from_byte_count(chars) as u64;
        // System prompt and Skills are fixed on-disk costs sent as-is with each
        // request — they must NEVER be scaled up to absorb unexplained usage
        // (that is what previously inflated Skills to nonsense figures).
        let fixed_system = estimate(system_prompt_chars);
        let fixed_skills = estimate(skills_chars);
        let conversation_estimates: [u64; 3] = [
            estimate(totals.user_message_chars),
            estimate(totals.agent_response_chars),
            estimate(totals.tool_call_chars),
        ];
        let conversation_estimate_sum: u64 = conversation_estimates.iter().sum();

        // The one exact number: current context occupancy (not the session-cumulative
        // total, which can exceed the window).
        let default_usage = crate::token_usage::TokenUsage::default();
        let last_usage = self
            .token_info
            .as_ref()
            .map(|info| &info.last_token_usage)
            .unwrap_or(&default_usage);
        let window = self
            .status_line_context_window_size()
            .unwrap_or(258_400)
            .max(1) as u64;
        let exact_used = last_usage.tokens_in_context_window().max(0) as u64;
        // Before the first response there is no exact figure yet; fall back to the
        // raw estimates instead of scaling everything to zero.
        let used = if exact_used > 0 {
            exact_used.min(window)
        } else {
            (conversation_estimate_sum + fixed_system + fixed_skills).min(window)
        };

        // Only the conversation share (what's left after the fixed buckets) is
        // split proportionally across user/agent/tool estimates.
        let fixed_total = (fixed_system + fixed_skills).min(used);
        let conversation_budget = used.saturating_sub(fixed_total);
        let mut conversation: [u64; 3] = if conversation_estimate_sum > 0 {
            conversation_estimates
                .map(|tokens| tokens * conversation_budget / conversation_estimate_sum)
        } else {
            [0, 0, 0]
        };
        let mut other = conversation_budget.saturating_sub(conversation.iter().sum());
        if conversation_estimate_sum > 0 {
            let largest = (0..conversation.len())
                .max_by_key(|&i| conversation[i])
                .unwrap_or(0);
            conversation[largest] += other;
            other = 0;
        }

        let mut categories = vec![
            CategoryUsage {
                label: "User messages",
                tokens: conversation[0],
                color: Color::Blue,
            },
            CategoryUsage {
                label: "Agent responses",
                tokens: conversation[1],
                color: Color::Green,
            },
            CategoryUsage {
                label: "Tool calls",
                tokens: conversation[2],
                color: Color::Yellow,
            },
            CategoryUsage {
                label: "System prompt",
                tokens: fixed_system,
                color: Color::Magenta,
            },
            CategoryUsage {
                label: "Skills",
                tokens: fixed_skills,
                color: Color::Cyan,
            },
        ];
        if other > 0 {
            categories.push(CategoryUsage {
                label: "Other (overhead)",
                tokens: other,
                color: Color::DarkGray,
            });
        }
        let free = window.saturating_sub(used);

        // Right-hand legend, one entry per grid row.
        let model = self
            .config
            .model
            .clone()
            .unwrap_or_else(|| "model".to_string());
        let mut legend: Vec<Line<'static>> = Vec::new();
        // Same formula the status line uses, so /context and the "% left" indicator
        // can never disagree.
        let used_percent = if exact_used > 0 {
            (100 - last_usage.percent_of_context_window_remaining(window as i64)).clamp(0, 100)
        } else {
            (used.saturating_mul(100) / window) as i64
        };
        legend.push(
            format!(
                "{model} · {}/{} tokens ({used_percent}% used)",
                fmt_tokens(used),
                fmt_tokens(window),
            )
            .bold()
            .into(),
        );
        legend.push("Token usage by category".bold().into());
        for category in &categories {
            legend.push(Line::from(vec![
                Span::styled("● ", Style::default().fg(category.color)),
                Span::from(format!(
                    "{}: {} tokens ({})",
                    category.label,
                    fmt_tokens(category.tokens),
                    fmt_percent(category.tokens, window),
                )),
            ]));
        }
        legend.push(Line::from(vec![
            Span::from("□ ").dim(),
            Span::from(format!(
                "Free space: {} ({}% left)",
                fmt_tokens(free),
                100 - used_percent,
            ))
            .dim(),
        ]));
        let pruner_saved = crate::legacy_core::context_pruner::saved_chars();
        let saved_tokens = codex_utils_string::approx_tokens_from_byte_count(pruner_saved) as u64;
        if saved_tokens > 0 {
            legend.push(Line::from(vec![
                Span::styled("✨ ", Style::default().fg(Color::Green)),
                Span::styled(
                    format!("Saved Context: ~{} tokens reclaimed", fmt_tokens(saved_tokens)),
                    Style::default().fg(Color::Green).bold(),
                ),
                Span::styled(" (Ace Pass ⚡)", Style::default().fg(Color::Cyan)),
            ]));
        }
        if exact_used == 0 {
            legend.push("(estimated — no request sent yet)".dim().into());
        }

        let mut lines: Vec<Line<'static>> = Vec::new();
        lines.push(" Context Usage".bold().into());
        lines.extend(build_grid_with_legend(&categories, used, window, legend));
        lines.push(Line::default());

        lines.extend(build_category_bar_chart(&categories, used, window));
        lines.push(Line::default());

        lines.push(" Ace Pruning Audit & Low-level Breakdown".bold().into());
        let pruner_passes = crate::legacy_core::context_pruner::pass_count();
        if pruner_passes == 0 && saved_tokens == 0 {
            lines.push(Line::from(
                "   No Ace pruning passes run yet — context is below trigger floor."
                    .dim(),
            ));
        } else {
            lines.push(Line::from(vec![
                Span::from("   Status: "),
                Span::styled(
                    format!("{pruner_passes} pass(es) applied"),
                    Style::default().fg(Color::Cyan).bold(),
                ),
                Span::from(" · "),
                Span::styled(
                    format!("~{} tokens saved", fmt_tokens(saved_tokens)),
                    Style::default().fg(Color::Green).bold(),
                ),
                Span::styled(" ⚡", Style::default().fg(Color::Yellow)),
            ]));
            lines.push(Line::from(
                "   Low-level action: Oldest finished tool outputs distilled to evidence pointers; recent turn preserved verbatim."
                    .dim(),
            ));
        }
        lines.push(Line::default());

        lines.push(" Checkpoints · Esc Esc to backtrack".bold().into());
        if totals.checkpoints == 0 {
            lines.push(
                "   No backtrack points yet — send a message first."
                    .dim()
                    .into(),
            );
        } else {
            lines.push(
                format!(
                    "   {} backtrack point(s) available — Esc Esc jumps to a prior message and forks from it.",
                    totals.checkpoints
                )
                .dim()
                .into(),
            );
        }
        self.add_to_history(PlainHistoryCell::new(lines));
    }
}

fn build_category_bar_chart(
    categories: &[CategoryUsage],
    used: u64,
    window: u64,
) -> Vec<Line<'static>> {
    let bar_width = 24usize;
    let mut lines = Vec::new();
    lines.push(Line::from(" Category Breakdown (Relative Share)".bold()));

    let overall_cells = if window > 0 {
        (((used * bar_width as u64) / window) as usize).min(bar_width)
    } else {
        0
    };
    let filled_overall = "█".repeat(overall_cells);
    let empty_overall = "░".repeat(bar_width - overall_cells);
    lines.push(Line::from(vec![
        Span::from("   Overall Capacity "),
        Span::styled(
            format!("[{filled_overall}{empty_overall}] "),
            Style::default().fg(Color::Cyan),
        ),
        Span::from(format!(
            "{}/{} tokens ({} used)",
            fmt_tokens(used),
            fmt_tokens(window),
            fmt_percent(used, window)
        )),
    ]));

    for cat in categories {
        let cells = if used > 0 {
            (((cat.tokens * bar_width as u64) / used) as usize).min(bar_width)
        } else {
            0
        };
        let filled = "█".repeat(cells);
        let empty = "░".repeat(bar_width - cells);
        let pct_of_used = if used > 0 {
            fmt_percent(cat.tokens, used)
        } else {
            "0%".to_string()
        };
        lines.push(Line::from(vec![
            Span::from(format!("   {:16} ", cat.label)),
            Span::styled(format!("[{filled}{empty}] "), Style::default().fg(cat.color)),
            Span::from(format!(
                "{} ({} of used)",
                fmt_tokens(cat.tokens),
                pct_of_used
            )),
        ]));
    }
    lines
}

/// Grid rows on the left, legend lines to the right of each row — the legend never
/// changes how many cells are filled, only their colors.
fn build_grid_with_legend(
    categories: &[CategoryUsage],
    used: u64,
    window: u64,
    legend: Vec<Line<'static>>,
) -> Vec<Line<'static>> {
    let used_cells = ((used.min(window) as usize) * GRID_CELLS) / window.max(1) as usize;
    let used_total: u64 = categories.iter().map(|c| c.tokens).sum();

    let mut cells: Vec<Option<Color>> = Vec::with_capacity(GRID_CELLS);
    if used_total > 0 {
        let mut remaining = used_cells;
        for (index, category) in categories.iter().enumerate() {
            let share = if index + 1 == categories.len() {
                remaining
            } else {
                (((category.tokens as usize) * used_cells) / used_total as usize).min(remaining)
            };
            cells.extend(std::iter::repeat_n(Some(category.color), share));
            remaining -= share;
        }
    }
    cells.resize(used_cells, None);
    cells.resize(GRID_CELLS, None);

    let mut legend_iter = legend.into_iter();
    let mut lines: Vec<Line<'static>> = cells
        .chunks(GRID_COLUMNS)
        .map(|row| {
            let mut spans: Vec<Span<'static>> = vec![Span::from(" ")];
            spans.extend(row.iter().map(|slot| match slot {
                Some(color) => Span::styled("● ", Style::default().fg(*color)),
                None => Span::from("□ ").dim(),
            }));
            if let Some(legend_line) = legend_iter.next() {
                spans.push(Span::from("  "));
                spans.extend(legend_line.spans);
            }
            Line::from(spans)
        })
        .collect();
    // More legend entries than grid rows: continue below, aligned with the legend column.
    for legend_line in legend_iter {
        let mut spans: Vec<Span<'static>> = vec![Span::from(" ".repeat(1 + GRID_COLUMNS * 2 + 2))];
        spans.extend(legend_line.spans);
        lines.push(Line::from(spans));
    }
    lines
}

fn fmt_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        let value = format!("{:.1}", tokens as f64 / 1_000_000.0);
        format!("{}m", value.trim_end_matches(".0"))
    } else if tokens >= 1_000 {
        let value = format!("{:.1}", tokens as f64 / 1_000.0);
        format!("{}k", value.trim_end_matches(".0"))
    } else {
        tokens.to_string()
    }
}

fn fmt_percent(tokens: u64, window: u64) -> String {
    let tenths = tokens.saturating_mul(1000) / window.max(1);
    format!("{}.{}%", tenths / 10, tenths % 10)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filled_cells(lines: &[Line<'static>]) -> usize {
        lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .filter(|span| span.content.contains('●'))
            .count()
    }

    #[test]
    fn grid_fill_tracks_used_share_of_window() {
        let categories = vec![CategoryUsage {
            label: "User messages",
            tokens: 500,
            color: Color::Blue,
        }];
        let lines = build_grid_with_legend(&categories, 500, 1_000, Vec::new());
        assert_eq!(lines.len(), GRID_ROWS);
        assert_eq!(filled_cells(&lines), GRID_CELLS / 2);
    }

    #[test]
    fn grid_never_exceeds_window_even_with_huge_categories() {
        let categories = vec![CategoryUsage {
            label: "Tool calls",
            tokens: 10_000_000,
            color: Color::Yellow,
        }];
        let lines = build_grid_with_legend(&categories, 120, 1_000, Vec::new());
        assert_eq!(filled_cells(&lines), (120 * GRID_CELLS) / 1_000);
    }

    #[test]
    fn fmt_helpers_produce_compact_values() {
        assert_eq!(fmt_tokens(301), "301");
        assert_eq!(fmt_tokens(39_700), "39.7k");
        assert_eq!(fmt_tokens(1_000_000), "1m");
        assert_eq!(fmt_percent(305, 1_000), "30.5%");
    }
}
