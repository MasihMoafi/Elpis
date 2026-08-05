//! `/context` command: a colored context-usage grid with a side-by-side per-category
//! legend (grid left, numbers right), a Checkpoints section backed by Elpis's real
//! backtrack mechanism, and a System files (auto-loaded) section backed by the same
//! admitted-source list the Context Ledger renders.
//!
//! ## The math is anchored to one measured number
//!
//! The current request-context count (`token_info.last_token_usage`) is the only
//! headline number. It is the same snapshot used by the status line and the
//! Context Ledger. Transcript and portable-source byte counts are attribution
//! estimates only: they are scaled to that measured total, and any unaccounted
//! remainder is shown explicitly as "Other (overhead)".

use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use std::time::Duration;
use std::time::Instant;

use super::ChatWidget;
use crate::app_backtrack::ContextUsageTranscriptTotals;
use crate::history_cell::HistoryCell;
use crate::legacy_core::elpis_context::ContinuitySourceCategory;

const GRID_COLUMNS: usize = 26;
const GRID_ROWS: usize = 10;
const GRID_CELLS: usize = GRID_COLUMNS * GRID_ROWS;

#[derive(Clone, Debug)]
struct CategoryUsage {
    label: &'static str,
    tokens: u64,
    saved_tokens: u64,
    color: Color,
}

#[derive(Debug)]
struct ContextUsageHistoryCell {
    before_chart: Vec<Line<'static>>,
    categories: Vec<CategoryUsage>,
    used: u64,
    window: u64,
    after_chart: Vec<Line<'static>>,
    started_at: Instant,
    animations_enabled: bool,
}

impl ContextUsageHistoryCell {
    const ANIMATION_DURATION: Duration = Duration::from_millis(900);

    fn animation_progress(&self) -> u64 {
        if !self.animations_enabled {
            return 1_000;
        }
        let elapsed = self.started_at.elapsed().as_millis() as u64;
        (elapsed.saturating_mul(1_000) / Self::ANIMATION_DURATION.as_millis() as u64).min(1_000)
    }

    fn rendered_lines(&self) -> Vec<Line<'static>> {
        let mut lines = self.before_chart.clone();
        lines.extend(build_category_bar_chart(
            &self.categories,
            self.used,
            self.window,
            self.animation_progress(),
        ));
        lines.extend(self.after_chart.clone());
        lines
    }
}

impl HistoryCell for ContextUsageHistoryCell {
    fn display_lines(&self, _width: u16) -> Vec<Line<'static>> {
        self.rendered_lines()
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        let mut lines = self.before_chart.clone();
        lines.extend(build_category_bar_chart(
            &self.categories,
            self.used,
            self.window,
            1_000,
        ));
        lines.extend(self.after_chart.clone());
        lines
    }

    fn transcript_animation_tick(&self) -> Option<u64> {
        (self.animations_enabled && self.started_at.elapsed() < Self::ANIMATION_DURATION)
            .then(|| (self.started_at.elapsed().as_millis() / 60) as u64)
    }
}

impl ChatWidget {
    pub(super) fn begin_context_prune_tracking(&mut self) {
        self.context_prune_report_pending = true;
    }

    pub(super) fn finish_context_prune_tracking(&mut self) {
        if !std::mem::take(&mut self.context_prune_report_pending) {
            return;
        }
        self.app_event_tx
            .send(crate::app_event::AppEvent::RequestContextUsageReport);
    }

    pub(super) fn update_context_prune_savings(&mut self, saved_tokens: u64, from_replay: bool) {
        if saved_tokens == 0 {
            return;
        }
        let newly_saved = newly_reclaimed_tokens(self.last_prune_saved_tokens, saved_tokens);
        self.last_prune_saved_tokens = Some(saved_tokens);
        if !from_replay && let Some(line) = saved_context_flash_line(newly_saved) {
            self.bottom_pane.show_saved_context_flash(line);
        }
    }

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
        // The one measured number: current context occupancy (not the
        // session-cumulative total, which can exceed the window). Before a provider
        // response exists, the core emits the same pre-request snapshot used for
        // pruning and the hard-limit check; zero means no snapshot exists yet.
        let default_usage = crate::token_usage::TokenUsage::default();
        let last_usage = self
            .token_info
            .as_ref()
            .map(|info| &info.last_token_usage)
            .unwrap_or(&default_usage);
        let has_request_snapshot = self.token_info.is_some();
        let window = self
            .status_line_context_window_size()
            .unwrap_or(258_400)
            .max(1) as u64;
        let exact_used = last_usage.tokens_in_context_window().max(0) as u64;
        let used = exact_used.min(window);
        let raw_categories = [
            conversation_estimates[0],
            conversation_estimates[1],
            conversation_estimates[2],
            fixed_system,
            fixed_skills,
        ];
        let category_tokens = scale_token_counts(&raw_categories, used);
        let conversation = [category_tokens[0], category_tokens[1], category_tokens[2]];
        let fixed_system = category_tokens[3];
        let fixed_skills = category_tokens[4];
        let other = used.saturating_sub(category_tokens.iter().sum());
        let saved_tokens = self.last_prune_saved_tokens.unwrap_or(0);

        let mut categories = vec![
            CategoryUsage {
                label: "User messages",
                tokens: conversation[0],
                saved_tokens: 0,
                color: Color::Blue,
            },
            CategoryUsage {
                label: "Agent responses",
                tokens: conversation[1],
                saved_tokens: 0,
                color: Color::Green,
            },
            CategoryUsage {
                label: "Tool calls",
                tokens: conversation[2],
                saved_tokens,
                color: Color::Yellow,
            },
            CategoryUsage {
                label: "System prompt",
                tokens: fixed_system,
                saved_tokens: 0,
                color: Color::Magenta,
            },
            CategoryUsage {
                label: "Skills",
                tokens: fixed_skills,
                saved_tokens: 0,
                color: Color::Cyan,
            },
        ];
        if other > 0 {
            categories.push(CategoryUsage {
                label: "Other (overhead)",
                tokens: other,
                saved_tokens: 0,
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
        let used_percent = self.status_line_context_used_percent().unwrap_or(0);
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
        if saved_tokens > 0 {
            legend.push(Line::from(vec![
                Span::styled("✨ ", Style::default().fg(Color::Green)),
                Span::styled(
                    format!(
                        "Saved Context: ~{} tokens reclaimed",
                        fmt_tokens(saved_tokens)
                    ),
                    Style::default().fg(Color::Green).bold(),
                ),
                Span::styled(" (Ace Pass ⚡)", Style::default().fg(Color::Cyan)),
            ]));
        }
        if !has_request_snapshot {
            legend.push("(no measured request snapshot yet)".dim().into());
        }

        let mut before_chart: Vec<Line<'static>> = Vec::new();
        before_chart.push(" Context Usage".bold().into());
        before_chart.extend(build_grid_with_legend(&categories, used, window, legend));
        before_chart.push(Line::default());

        let mut after_chart = vec![Line::default()];
        after_chart.push(" Ace Pruning Audit & Low-level Breakdown".bold().into());
        if self.last_prune_saved_tokens.is_none() {
            after_chart.push(Line::from(
                "   No Ace pruning passes run yet — context is below trigger floor.".dim(),
            ));
        } else {
            after_chart.push(Line::from(vec![
                Span::from("   Status: "),
                Span::styled(
                    "latest pass applied",
                    Style::default().fg(Color::Cyan).bold(),
                ),
                Span::from(" · "),
                Span::styled(
                    format!("~{} tokens saved", fmt_tokens(saved_tokens)),
                    Style::default().fg(Color::Green).bold(),
                ),
                Span::styled(" ⚡", Style::default().fg(Color::Yellow)),
            ]));
            after_chart.push(
                "   Ace only rewrites completed tool-call evidence; the 0-saved rows were not touched."
                    .dim()
                    .into(),
            );
        }
        after_chart.push(Line::default());

        after_chart.push(" Checkpoints · Esc Esc to backtrack".bold().into());
        if totals.checkpoints == 0 {
            after_chart.push(
                "   No backtrack points yet — send a message first."
                    .dim()
                    .into(),
            );
        } else {
            after_chart.push(
                format!(
                    "   {} backtrack point(s) available — Esc Esc jumps to a prior message and forks from it.",
                    totals.checkpoints
                )
                .dim()
                .into(),
            );
        }
        let cell = ContextUsageHistoryCell {
            before_chart,
            categories,
            used,
            window,
            after_chart,
            started_at: Instant::now(),
            animations_enabled: self.config.animations,
        };
        self.flush_active_cell();
        self.transcript.active_cell = Some(Box::new(cell));
        self.bump_active_cell_revision();
        if self.config.animations {
            for tick in 1..=15 {
                self.bottom_pane
                    .request_redraw_in(Duration::from_millis(60 * tick));
            }
        }
        self.request_redraw();
    }
}

/// Scale attribution estimates down when they exceed the measured request
/// context. If the estimates are smaller, keep them raw and let the caller show
/// the unassigned remainder as an explicit overhead bucket.
fn scale_token_counts(values: &[u64], target: u64) -> Vec<u64> {
    let source_total = values.iter().copied().sum::<u64>();
    if source_total == 0 || target >= source_total {
        return values.to_vec();
    }

    let mut scaled = values
        .iter()
        .map(|value| ((*value as u128 * target as u128) / source_total as u128) as u64)
        .collect::<Vec<_>>();
    let assigned = scaled.iter().copied().sum::<u64>();
    let remainder = target.saturating_sub(assigned);
    if remainder > 0 {
        if let Some(value) = scaled.iter_mut().rev().find(|value| **value > 0) {
            *value = value.saturating_add(remainder);
        } else if let Some(value) = scaled.last_mut() {
            *value = remainder;
        }
    }
    scaled
}

fn build_category_bar_chart(
    categories: &[CategoryUsage],
    used: u64,
    window: u64,
    savings_progress: u64,
) -> Vec<Line<'static>> {
    let bar_width = 24usize;
    let mut lines = Vec::new();
    lines.push(Line::from(
        " Category Breakdown · retained █  reclaimed ✨".bold(),
    ));

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

    let largest_before = categories
        .iter()
        .map(|category| category.tokens.saturating_add(category.saved_tokens))
        .max()
        .unwrap_or(0)
        .max(1);
    let progress = savings_progress.min(1_000);
    for category in categories {
        let before = category.tokens.saturating_add(category.saved_tokens);
        let retained_cells = ((category.tokens * bar_width as u64) / largest_before) as usize;
        let final_saved_cells =
            ((category.saved_tokens * bar_width as u64) / largest_before) as usize;
        let saved_cells = final_saved_cells * progress as usize / 1_000;
        let empty_cells = bar_width.saturating_sub(retained_cells + saved_cells);
        let animated_saved = category.saved_tokens.saturating_mul(progress) / 1_000;
        let saved_percent = if before > 0 {
            fmt_percent(category.saved_tokens, before)
        } else {
            "0.0%".to_string()
        };
        let sparkle = if progress / 80 % 2 == 0 { "✨" } else { "  " };
        lines.push(Line::from(vec![
            Span::from(format!("   {:16} [", category.label)),
            Span::styled(
                "█".repeat(retained_cells),
                Style::default().fg(category.color),
            ),
            Span::styled(
                "▓".repeat(saved_cells),
                Style::default().fg(Color::LightGreen).bold(),
            ),
            Span::from("░".repeat(empty_cells)).dim(),
            Span::from("] "),
            Span::from(format!(
                "{} → {}",
                fmt_tokens(before),
                fmt_tokens(category.tokens)
            )),
            if category.saved_tokens > 0 {
                Span::styled(
                    format!(
                        "  {sparkle} ~{} saved ({saved_percent})",
                        fmt_tokens(animated_saved)
                    ),
                    Style::default().fg(Color::LightGreen).bold(),
                )
            } else {
                Span::from("  · 0 saved").dim()
            },
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

pub(super) fn saved_context_flash_line(saved_tokens: u64) -> Option<Line<'static>> {
    (saved_tokens > 0).then(|| {
        Line::from(vec![
            Span::styled("✨ ", Style::default().fg(Color::Green)),
            Span::styled(
                format!(
                    "Saved Context: ~{} tokens reclaimed",
                    fmt_tokens(saved_tokens)
                ),
                Style::default().fg(Color::Green).bold(),
            ),
        ])
    })
}

fn newly_reclaimed_tokens(previous_total: Option<u64>, current_total: u64) -> u64 {
    current_total.saturating_sub(previous_total.unwrap_or(0))
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
            saved_tokens: 0,
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
            saved_tokens: 0,
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

    #[test]
    fn saved_context_flash_reports_real_reclaimed_size() {
        let line = saved_context_flash_line(60_400).expect("saved context line");
        let text = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert_eq!(text, "✨ Saved Context: ~60.4k tokens reclaimed");
        assert!(saved_context_flash_line(0).is_none());
    }

    #[test]
    fn newly_reclaimed_tokens_only_reports_growth() {
        assert_eq!(newly_reclaimed_tokens(None, 4_200), 4_200);
        assert_eq!(newly_reclaimed_tokens(Some(4_200), 7_000), 2_800);
        assert_eq!(newly_reclaimed_tokens(Some(7_000), 4_200), 0);
    }

    #[test]
    fn category_attribution_matches_measured_context() {
        let scaled = scale_token_counts(&[70, 30, 10], 25);
        assert_eq!(scaled.iter().copied().sum::<u64>(), 25);
        assert!(
            scaled
                .iter()
                .zip([70, 30, 10])
                .all(|(actual, raw)| *actual <= raw)
        );
    }

    #[test]
    fn category_chart_attributes_and_reveals_saved_tokens() {
        let categories = vec![
            CategoryUsage {
                label: "User messages",
                tokens: 20_000,
                saved_tokens: 0,
                color: Color::Blue,
            },
            CategoryUsage {
                label: "Tool calls",
                tokens: 24_100,
                saved_tokens: 60_400,
                color: Color::Yellow,
            },
        ];

        let initial = build_category_bar_chart(&categories, 44_100, 258_400, 0);
        let complete = build_category_bar_chart(&categories, 44_100, 258_400, 1_000);
        let text = complete
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert!(text.contains("84.5k → 24.1k"));
        assert!(text.contains("~60.4k saved (71.4%)"));
        assert_eq!(
            initial
                .iter()
                .flat_map(|line| line.spans.iter())
                .filter(|span| span.content.contains('▓'))
                .count(),
            0
        );
        assert!(
            complete
                .iter()
                .flat_map(|line| line.spans.iter())
                .any(|span| span.content.contains('▓'))
        );
    }
}
