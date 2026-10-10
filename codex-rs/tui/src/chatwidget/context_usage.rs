//! `/context` command: one category-segmented full-window usage bar, a Checkpoints
//! section backed by Elpis's real backtrack mechanism, and a System files
//! (auto-loaded) section backed by the same admitted-source list the Context Ledger
//! renders.
//!
//! Total occupancy comes from core's current token state. Category proportions are
//! estimated from the exact `Prompt` built for the latest provider attempt and
//! reconciled to that measured total. Every bar and percentage uses the model's full
//! context window as its denominator.

use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;

use super::ChatWidget;
use crate::elpis_ledger_events::ContextUsageTranscriptTotals;
use crate::history_cell::HistoryCell;

// Recognizable hues for category dots and bar segments. Labels keep the terminal
// foreground; charcoal markers retain at least 4.5:1 contrast.
pub(super) const USER_MESSAGES_COLOR: Color = Color::Rgb(111, 181, 253);
pub(super) const AGENT_RESPONSES_COLOR: Color = Color::Rgb(80, 193, 111);
pub(super) const REASONING_COLOR: Color = Color::Rgb(54, 199, 205);
const REASONING_CATEGORY_LABEL: &str = "Reasoning + compaction";
pub(super) const TOOL_CALLS_COLOR: Color = Color::Rgb(244, 153, 61);
pub(super) const TOOL_RESULTS_COLOR: Color = Color::Rgb(235, 208, 60);
pub(super) const SYSTEM_INSTRUCTIONS_COLOR: Color = Color::Rgb(240, 68, 93);
pub(super) const DEVELOPER_MESSAGES_COLOR: Color = Color::Rgb(210, 153, 244);
pub(super) const TOOL_DEFINITIONS_COLOR: Color = Color::Rgb(160, 160, 160);
pub(super) const UNRECOGNIZED_ITEMS_COLOR: Color = Color::Rgb(240, 136, 187);
pub(super) const CONTEXT_CATEGORY_MARKER: &str = "●";

// On paper and white, these graphical markers keep at least 3:1 contrast and
// 25 CIELAB units of separation. Requiring text contrast for the markers made
// yellow and orange look brown. Text does not use this palette.
const LIGHT_USER_MESSAGES_COLOR: Color = Color::Rgb(78, 127, 195);
const LIGHT_AGENT_RESPONSES_COLOR: Color = Color::Rgb(50, 142, 75);
const LIGHT_REASONING_COLOR: Color = Color::Rgb(30, 140, 145);
const LIGHT_TOOL_CALLS_COLOR: Color = Color::Rgb(205, 111, 15);
const LIGHT_TOOL_RESULTS_COLOR: Color = Color::Rgb(168, 138, 0);
const LIGHT_SYSTEM_INSTRUCTIONS_COLOR: Color = Color::Rgb(140, 45, 60);
const LIGHT_DEVELOPER_MESSAGES_COLOR: Color = Color::Rgb(147, 99, 181);
const LIGHT_TOOL_DEFINITIONS_COLOR: Color = Color::Rgb(100, 100, 100);
const LIGHT_UNRECOGNIZED_ITEMS_COLOR: Color = Color::Rgb(173, 86, 132);

fn light_category_color(color: Color) -> Color {
    match color {
        USER_MESSAGES_COLOR => LIGHT_USER_MESSAGES_COLOR,
        AGENT_RESPONSES_COLOR => LIGHT_AGENT_RESPONSES_COLOR,
        REASONING_COLOR => LIGHT_REASONING_COLOR,
        TOOL_CALLS_COLOR => LIGHT_TOOL_CALLS_COLOR,
        TOOL_RESULTS_COLOR => LIGHT_TOOL_RESULTS_COLOR,
        SYSTEM_INSTRUCTIONS_COLOR => LIGHT_SYSTEM_INSTRUCTIONS_COLOR,
        DEVELOPER_MESSAGES_COLOR => LIGHT_DEVELOPER_MESSAGES_COLOR,
        TOOL_DEFINITIONS_COLOR => LIGHT_TOOL_DEFINITIONS_COLOR,
        UNRECOGNIZED_ITEMS_COLOR => LIGHT_UNRECOGNIZED_ITEMS_COLOR,
        Color::Rgb(r, g, b) => {
            let deepen = |v: u8| (u16::from(v) * 45 / 100) as u8;
            Color::Rgb(deepen(r), deepen(g), deepen(b))
        }
        other => other,
    }
}

/// Shared by the Ledger and `/context`; the charcoal palette as-is, its paper
/// counterpart on a light background.
pub(super) fn context_display_color(color: Color) -> Color {
    let Some(background) = crate::terminal_palette::default_bg() else {
        return Color::Reset;
    };
    let color = if crate::color::is_light(background) {
        light_category_color(color)
    } else {
        color
    };
    let Color::Rgb(r, g, b) = color else {
        return color;
    };
    crate::terminal_palette::best_color((r, g, b))
}

pub(super) fn context_free_style() -> Style {
    Style::default().fg(crate::style::adaptive_palette_color(
        crate::terminal_palette::default_bg(),
        (105, 107, 116),
        (145, 147, 156),
    ))
}

#[derive(Clone, Debug)]
pub(super) struct CategoryUsage {
    pub(super) label: &'static str,
    pub(super) tokens: u64,
    pub(super) color: Color,
}

// Elpis: shared with the dashboard (elpis_dashboard.rs).
#[derive(Clone, Debug)]
pub(super) struct ContextUsageSnapshot {
    pub(super) model: String,
    pub(super) used_tokens: Option<u64>,
    pub(super) window_tokens: Option<u64>,
    pub(super) has_request_snapshot: bool,
    pub(super) attributed_tokens: Option<u64>,
    pub(super) categories: Vec<CategoryUsage>,
    pub(super) saved_tokens: u64,
    pub(super) backtrack_points: usize,
}

#[derive(Debug)]
struct ContextUsageHistoryCell {
    before_chart: Vec<Line<'static>>,
    has_request_snapshot: bool,
    categories: Vec<CategoryUsage>,
    used: u64,
    window: Option<u64>,
    after_chart: Vec<Line<'static>>,
}

impl ContextUsageHistoryCell {
    fn rendered_lines(&self, width: u16) -> Vec<Line<'static>> {
        let mut lines = self.before_chart.clone();
        if self.has_request_snapshot {
            if let Some(window) = self.window {
                lines.extend(build_category_bar_chart(
                    &self.categories,
                    self.used,
                    window,
                    width,
                ));
            } else {
                lines.push(
                    format!(" {} tokens used · capacity unknown", fmt_tokens(self.used)).into(),
                );
            }
        } else {
            lines.push(" Context measurement unavailable.".not_dim().into());
        }
        lines.extend(self.after_chart.clone());
        lines
    }
}

/// Convert the latest core-built request snapshot into the one category list
/// shared by `/context`, the dashboard, and the persistent Context Ledger.
pub(super) fn run_built_context_categories(
    attribution: &codex_app_server_protocol::ThreadContextAttribution,
) -> Vec<CategoryUsage> {
    let mut categories = vec![
        CategoryUsage {
            label: "User messages",
            tokens: attribution.user_messages,
            color: USER_MESSAGES_COLOR,
        },
        CategoryUsage {
            label: "Agent messages",
            tokens: attribution.agent_messages,
            color: AGENT_RESPONSES_COLOR,
        },
        CategoryUsage {
            label: REASONING_CATEGORY_LABEL,
            tokens: attribution.reasoning,
            color: REASONING_COLOR,
        },
        CategoryUsage {
            label: "Tool calls",
            tokens: attribution.tool_calls,
            color: TOOL_CALLS_COLOR,
        },
        CategoryUsage {
            label: "Tool results",
            tokens: attribution.tool_results,
            color: TOOL_RESULTS_COLOR,
        },
        CategoryUsage {
            label: "System instructions",
            tokens: attribution.system_instructions,
            color: SYSTEM_INSTRUCTIONS_COLOR,
        },
        CategoryUsage {
            label: "Developer messages",
            tokens: attribution.developer_messages,
            color: DEVELOPER_MESSAGES_COLOR,
        },
        CategoryUsage {
            label: "Tool definitions + schema",
            tokens: attribution
                .tool_definitions
                .saturating_add(attribution.output_schema),
            color: TOOL_DEFINITIONS_COLOR,
        },
        CategoryUsage {
            label: "Unrecognized request items",
            tokens: attribution.unrecognized_items,
            color: UNRECOGNIZED_ITEMS_COLOR,
        },
    ];
    categories.retain(|category| category.tokens > 0);
    // The split comes from the server (for Claude and Antigravity chats, the bridge's estimates);
    // a total that disagrees is drawn scaled to the measured context, never a crash.
    let summed = categories
        .iter()
        .map(|category| category.tokens)
        .sum::<u64>();
    if summed != attribution.estimated_total {
        tracing::warn!(
            summed,
            estimated_total = attribution.estimated_total,
            "context categories do not sum to the request estimate"
        );
    }
    categories
}

/// Preserve the locally estimated category proportions while making their total
/// equal the measured active-context total. Largest-remainder allocation keeps the
/// result deterministic and prevents a fabricated catch-all gap.
pub(super) fn reconcile_context_categories(
    categories: &[CategoryUsage],
    measured_total: u64,
) -> Vec<CategoryUsage> {
    let estimated_total = categories
        .iter()
        .map(|category| u128::from(category.tokens))
        .sum::<u128>();
    if estimated_total == 0 || measured_total == 0 {
        return Vec::new();
    }
    if estimated_total == u128::from(measured_total) {
        return categories.to_vec();
    }

    let mut remainders = Vec::with_capacity(categories.len());
    let mut reconciled = categories
        .iter()
        .enumerate()
        .map(|(index, category)| {
            let scaled = u128::from(category.tokens) * u128::from(measured_total);
            remainders.push((index, scaled % estimated_total));
            let mut category = category.clone();
            category.tokens = (scaled / estimated_total) as u64;
            category
        })
        .collect::<Vec<_>>();
    let allocated = reconciled
        .iter()
        .map(|category| category.tokens)
        .sum::<u64>();
    let remaining = measured_total.saturating_sub(allocated);
    remainders.sort_by(|(left_index, left), (right_index, right)| {
        right.cmp(left).then_with(|| left_index.cmp(right_index))
    });
    for (index, _) in remainders.into_iter().take(remaining as usize) {
        reconciled[index].tokens += 1;
    }
    reconciled.retain(|category| category.tokens > 0);
    debug_assert_eq!(
        reconciled
            .iter()
            .map(|category| category.tokens)
            .sum::<u64>(),
        measured_total,
    );
    reconciled
}

impl HistoryCell for ContextUsageHistoryCell {
    fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
        self.rendered_lines(width)
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        self.rendered_lines(100)
    }

    fn display_hyperlink_lines(
        &self,
        width: u16,
    ) -> Vec<crate::terminal_hyperlinks::HyperlinkLine> {
        crate::terminal_hyperlinks::annotate_web_urls(self.rendered_lines(width))
    }

    fn transcript_hyperlink_lines(
        &self,
        width: u16,
    ) -> Vec<crate::terminal_hyperlinks::HyperlinkLine> {
        self.display_hyperlink_lines(width)
    }
}

impl ChatWidget {
    pub(super) fn context_usage_snapshot(
        &self,
        totals: &ContextUsageTranscriptTotals,
    ) -> ContextUsageSnapshot {
        // The one measured number: current context occupancy (not the
        // session-cumulative total, which can exceed the window). Before a provider
        // response exists, the core emits the same pre-request snapshot used for
        // pruning and the hard-limit check. A missing snapshot differs from zero
        // measured usage, and above-capacity usage must remain visible in text.
        let default_usage = crate::token_usage::TokenUsage::default();
        let last_usage = self
            .token_info
            .as_ref()
            .map(|info| &info.last_token_usage)
            .unwrap_or(&default_usage);
        let has_request_snapshot = self.token_info.is_some();
        let window = self
            .status_line_context_window_size()
            .map(|window| window as u64);
        let used_tokens = self
            .token_info
            .as_ref()
            .map(|_| last_usage.tokens_in_context_window().max(0) as u64);
        let saved_tokens = self.last_prune_saved_tokens.unwrap_or(0);
        let categories = self
            .context_attribution
            .as_ref()
            .zip(used_tokens)
            .map(|(attribution, used)| {
                reconcile_context_categories(&run_built_context_categories(attribution), used)
            })
            .unwrap_or_default();
        let attributed_tokens = self.context_attribution.as_ref().and(used_tokens);
        ContextUsageSnapshot {
            model: self.model_display_name().to_string(),
            used_tokens,
            window_tokens: window,
            has_request_snapshot,
            attributed_tokens,
            categories,
            saved_tokens,
            backtrack_points: totals.checkpoints,
        }
    }

    fn build_context_usage_cell(
        &mut self,
        totals: ContextUsageTranscriptTotals,
    ) -> ContextUsageHistoryCell {
        let snapshot = self.context_usage_snapshot(&totals);
        let used = snapshot.used_tokens.unwrap_or(0);
        let window = snapshot.window_tokens;
        let categories = snapshot.categories.clone();
        let saved_tokens = snapshot.saved_tokens;
        let model = snapshot.model.clone();
        let before_chart = vec![
            Span::styled(
                " Context Usage · active context",
                crate::style::brand_style(),
            )
            .into(),
            format!(
                " {model} · {}",
                if window.is_some() {
                    "one full-window scale"
                } else {
                    "capacity unknown"
                }
            )
            .bold()
            .into(),
            if snapshot.attributed_tokens.is_some() {
                " Measured total · estimated category attribution from the latest built request"
                    .not_dim()
                    .into()
            } else if snapshot.has_request_snapshot {
                " Measured total available · category attribution unavailable"
                    .not_dim()
                    .into()
            } else {
                " No request snapshot yet · send a provider request to measure context"
                    .not_dim()
                    .into()
            },
            Line::default(),
        ];

        let mut after_chart = vec![Line::default()];
        after_chart.push(Span::styled(" Smart Prune Audit", crate::style::brand_style()).into());
        if !self.smart_prune_synced {
            after_chart.push(
                "   status unavailable · syncing with current thread state"
                    .not_dim()
                    .into(),
            );
        } else {
            let admitted = self.smart_prune.admitted_outputs;
            let examined = self.smart_prune.examined_outputs;
            let failed = self.smart_prune.failed_batches;
            let state = if self.smart_prune.enabled {
                "ON"
            } else {
                "OFF"
            };
            let mut summary = format!(
                "   Smart Prune {state} · {admitted} admitted / {examined} examined · {failed} failed batches"
            );
            if admitted > 0 && self.smart_prune.approx_saved_tokens > 0 {
                summary.push_str(&format!(
                    " · ≈{} tokens estimated one-time source reduction",
                    fmt_tokens(self.smart_prune.approx_saved_tokens)
                ));
            }
            after_chart.push(summary.into());
            if self.smart_prune.optimizer_requests > self.smart_prune.optimizer_usage_reports {
                after_chart.push("   optimizer usage unreported".not_dim().into());
            } else if self.smart_prune.optimizer_usage_reports > 0 {
                after_chart.push(
                    format!(
                        "   optimizer usage · ~{} tokens",
                        fmt_tokens(self.smart_prune.optimizer_usage.total_tokens.max(0) as u64)
                    )
                    .not_dim()
                    .into(),
                );
            }
        }
        after_chart.push(Line::default());

        after_chart
            .push(Span::styled(" History Rewrite Audit", crate::style::brand_style()).into());
        if self.last_prune_saved_tokens.is_none() {
            after_chart.push(
                "   No history rewrites recorded this thread"
                    .not_dim()
                    .into(),
            );
        } else {
            after_chart.push(Line::from(vec![
                Span::from("   Status: "),
                Span::styled("cumulative thread history", crate::style::brand_style()),
                Span::from(" · "),
                Span::styled(
                    format!("~{} tokens removed earlier", fmt_tokens(saved_tokens)),
                    Style::default().fg(Color::Green).bold(),
                ),
                Span::styled(" ⚡", Style::default().fg(Color::Yellow)),
            ]));
            after_chart.push(
                "   History rewrites replace completed tool-result history; category estimates exclude saved totals."
                    .not_dim()
                    .into(),
            );
        }
        after_chart.push(Line::default());

        after_chart.push(
            Span::styled(
                " Checkpoints · Esc Esc to backtrack",
                crate::style::brand_style(),
            )
            .into(),
        );
        if snapshot.backtrack_points == 0 {
            after_chart.push(
                "   No backtrack points yet — send a message first."
                    .not_dim()
                    .into(),
            );
        } else {
            after_chart.push(
                format!(
                    "   {} backtrack point(s) available — Esc Esc jumps to a prior message and forks from it.",
                    snapshot.backtrack_points
                )
                .not_dim()
                .into(),
            );
        }
        // Elpis: local evidence the dashboard server opens as readable reports.
        let evidence_lines = self.local_evidence_lines();
        if !evidence_lines.is_empty() {
            after_chart.push(Line::default());
            after_chart.extend(evidence_lines);
        }
        ContextUsageHistoryCell {
            before_chart,
            has_request_snapshot: snapshot.has_request_snapshot,
            categories,
            used,
            window,
            after_chart,
        }
    }

    pub(crate) fn add_context_usage_output(&mut self, totals: ContextUsageTranscriptTotals) {
        let cell = self.build_context_usage_cell(totals);
        self.flush_active_cell();
        self.transcript.active_cell = Some(Box::new(cell));
        self.bump_active_cell_revision();
        self.request_redraw();
    }

    /// The same report as [`Self::add_context_usage_output`], handed back instead
    /// of appended, so an explicit `/context` can open it as a dismissible pager.
    pub(crate) fn context_usage_cell(
        &mut self,
        totals: ContextUsageTranscriptTotals,
    ) -> Box<dyn HistoryCell> {
        Box::new(self.build_context_usage_cell(totals))
    }
}

fn build_category_bar_chart(
    categories: &[CategoryUsage],
    used: u64,
    window: u64,
    width: u16,
) -> Vec<Line<'static>> {
    let narrow = width < 80;
    // Spend the available terminal width on the only chart. A 24-cell bar made
    // low-occupancy contexts collapse to one or two visible category colours.
    // The cap keeps wide terminals readable while preserving enough resolution
    // for small-but-material request categories.
    let bar_width = usize::from(width)
        .saturating_sub(if narrow { 13 } else { 20 })
        .max(1)
        .min(96);
    let mut lines = Vec::new();
    lines.push(Line::from(
        " Context Accounting · history savings excluded".bold(),
    ));
    let categories = reconcile_context_categories(categories, used);
    let used_cells = ((u128::from(used.min(window)) * bar_width as u128
        + u128::from(window.max(1)) / 2)
        / u128::from(window.max(1))) as usize;
    let counts = category_grid_cell_counts(&categories, used_cells);
    let mut bar = vec![Span::from(if narrow {
        "   Context ["
    } else {
        "   Context Window ["
    })];
    if categories.is_empty() && used_cells > 0 {
        bar.push(Span::styled(
            "█".repeat(used_cells),
            crate::style::context_style(),
        ));
    } else {
        for (category, cells) in categories.iter().zip(counts) {
            if cells > 0 {
                bar.push(Span::styled(
                    "█".repeat(cells),
                    Style::default().fg(context_display_color(category.color)),
                ));
            }
        }
    }
    if used_cells < bar_width {
        bar.push(Span::styled(
            "░".repeat(bar_width - used_cells),
            context_free_style(),
        ));
    }
    bar.push(Span::from("]"));
    lines.push(Line::from(bar));
    lines.push(Line::from(format!(
        "   {}/{} · {} used",
        fmt_tokens(used),
        fmt_tokens(window),
        fmt_percent(used, window)
    )));

    lines.push(Line::from(Span::styled(
        format!(
            "   Free capacity · {} · {} of window",
            fmt_tokens(window.saturating_sub(used)),
            fmt_percent(window.saturating_sub(used), window)
        ),
        context_free_style(),
    )));

    for category in &categories {
        if narrow {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("   {CONTEXT_CATEGORY_MARKER} "),
                    Style::default().fg(context_display_color(category.color)),
                ),
                Span::from(format!(
                    "{} · {} · {} of window",
                    category.label,
                    fmt_tokens(category.tokens),
                    fmt_percent(category.tokens, window),
                )),
            ]));
        } else {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("   {CONTEXT_CATEGORY_MARKER} "),
                    Style::default().fg(context_display_color(category.color)),
                ),
                Span::from(format!("{:<27}", category.label)),
                Span::from(format!(
                    "{} · {} of context window",
                    fmt_tokens(category.tokens),
                    fmt_percent(category.tokens, window),
                )),
            ]));
        }
    }
    lines.push(if categories.is_empty() {
        "   Category attribution unavailable; neutral fill is measured context."
            .not_dim()
            .into()
    } else if narrow {
        "   Estimated segments · measured total.".not_dim().into()
    } else {
        "   Segment proportions are estimated from the latest built request; total width is measured active context."
            .not_dim()
            .into()
    });
    if categories
        .iter()
        .any(|category| category.label == REASONING_CATEGORY_LABEL)
    {
        let note = if narrow {
            "   Estimates, not the effort setting."
        } else {
            "   Includes retained history estimates, not the effort setting."
        };
        lines.push(note.not_dim().into());
    }
    lines
}

fn category_grid_cell_counts(categories: &[CategoryUsage], used_cells: usize) -> Vec<usize> {
    weighted_cell_counts(
        &categories
            .iter()
            .map(|category| category.tokens)
            .collect::<Vec<_>>(),
        used_cells,
    )
}

pub(super) fn weighted_cell_counts(weights: &[u64], used_cells: usize) -> Vec<usize> {
    let total = weights
        .iter()
        .map(|tokens| u128::from(*tokens))
        .sum::<u128>();
    if total == 0 || used_cells == 0 {
        return vec![0; weights.len()];
    }

    let mut remainders = Vec::with_capacity(weights.len());
    let mut counts = weights
        .iter()
        .enumerate()
        .map(|(index, tokens)| {
            let scaled = u128::from(*tokens) * used_cells as u128;
            remainders.push((index, scaled % total));
            (scaled / total) as usize
        })
        .collect::<Vec<_>>();
    let remaining = used_cells.saturating_sub(counts.iter().sum());
    remainders.sort_by(|(left_index, left), (right_index, right)| {
        right.cmp(left).then_with(|| left_index.cmp(right_index))
    });
    for (index, _) in remainders.into_iter().take(remaining) {
        counts[index] += 1;
    }

    let positive_count = weights.iter().filter(|tokens| **tokens > 0).count();
    if used_cells >= positive_count {
        for recipient in weights
            .iter()
            .enumerate()
            .filter_map(|(index, tokens)| (*tokens > 0 && counts[index] == 0).then_some(index))
            .collect::<Vec<_>>()
        {
            let Some(donor) = counts
                .iter()
                .enumerate()
                .filter(|(_, cells)| **cells > 1)
                .max_by_key(|(index, cells)| (**cells, weights[*index]))
                .map(|(index, _)| index)
            else {
                break;
            };
            counts[donor] -= 1;
            counts[recipient] = 1;
        }
    }
    debug_assert_eq!(counts.iter().sum::<usize>(), used_cells);
    counts
}

/// How long a "Saved N tokens" line stays above the composer, as in v0.3.0.
pub(super) const SAVED_CONTEXT_FLASH_DURATION: std::time::Duration =
    std::time::Duration::from_secs(4);

/// The line shown when Smart Prune admits compact output; `None` when nothing was saved.
pub(super) fn smart_prune_saved_context_flash_line(saved_tokens: u64) -> Option<Line<'static>> {
    (saved_tokens > 0).then(|| {
        Line::from(vec![
            Span::styled("✂ ", Style::default().fg(Color::LightGreen)),
            Span::styled(
                format!(
                    "Smart Prune saved ~{} tokens · snip!",
                    fmt_tokens(saved_tokens)
                ),
                Style::default().fg(Color::LightGreen).bold(),
            ),
        ])
    })
}

/// Exercised by tests only; no production path reaches it today.
#[cfg(test)]
fn no_prune_totals_line() -> Line<'static> {
    "   No history pruning recorded this thread"
        .not_dim()
        .into()
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
    let window = u128::from(window.max(1));
    let tenths = (u128::from(tokens) * 1000 + window / 2) / window;
    format!("{}.{}%", tenths / 10, tenths % 10)
}

pub(super) fn context_used_percent(tokens: u64, window: u64) -> i64 {
    let window = u128::from(window.max(1));
    let percent = (u128::from(tokens) * 100 + window / 2) / window;
    i64::try_from(percent).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {

    use super::*;

    fn plain_text(lines: Vec<Line<'static>>) -> String {
        lines
            .into_iter()
            .map(|line| {
                line.spans
                    .into_iter()
                    .map(|span| span.content.into_owned())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn smart_prune_flash_is_plain_and_specific() {
        let line = smart_prune_saved_context_flash_line(3_300).expect("Smart Prune flash");
        assert_eq!(
            plain_text(vec![line]),
            "✂ Smart Prune saved ~3.3k tokens · snip!"
        );
        assert!(smart_prune_saved_context_flash_line(0).is_none());
    }

    #[test]
    fn single_category_bar_fill_tracks_used_share_of_window() {
        let categories = vec![CategoryUsage {
            label: "User messages",
            tokens: 500,
            color: Color::Blue,
        }];
        let lines = build_category_bar_chart(&categories, 500, 1_000, 100);
        let text = plain_text(lines);

        assert_eq!(text.matches('[').count(), 1);
        assert_eq!(text.matches('█').count(), 40);
        assert_eq!(text.matches('░').count(), 40);
    }

    #[test]
    fn overfull_context_preserves_raw_counts_and_caps_only_the_bar() {
        let categories = vec![
            CategoryUsage {
                label: "User messages",
                tokens: 100_000,
                color: USER_MESSAGES_COLOR,
            },
            CategoryUsage {
                label: "Agent messages",
                tokens: 110_000,
                color: AGENT_RESPONSES_COLOR,
            },
        ];
        let text = plain_text(build_category_bar_chart(&categories, 210_000, 200_000, 100));

        assert!(text.contains("210k/200k · 105.0% used"), "{text}");
        assert!(text.contains("100k · 50.0% of context window"), "{text}");
        assert!(text.contains("110k · 55.0% of context window"), "{text}");
        assert_eq!(text.matches('█').count(), 80);
        assert_eq!(text.matches('░').count(), 0);
    }

    #[test]
    fn context_percentages_handle_large_values_without_saturation_errors() {
        let largest = i64::MAX as u64;
        assert_eq!(fmt_percent(largest, largest), "100.0%");
        assert_eq!(context_used_percent(largest, largest), 100);
        assert_eq!(fmt_percent(210_000, 200_000), "105.0%");
        assert_eq!(context_used_percent(210_000, 200_000), 105);
        assert_eq!(fmt_percent(0, largest), "0.0%");
        assert_eq!(context_used_percent(0, largest), 0);
    }

    #[test]
    fn occupied_bar_keeps_nonzero_categories_visible_when_resolution_allows() {
        let counts = weighted_cell_counts(&[1, 1, 1, 97], 10);

        assert_eq!(counts.iter().sum::<usize>(), 10);
        assert!(counts.into_iter().all(|count| count >= 1));
    }

    #[tokio::test]
    async fn context_capacity_requires_a_reported_or_configured_window() {
        let (mut chat, _sender, _events, _ops) =
            crate::chatwidget::tests::make_chatwidget_manual_with_sender().await;
        let totals = ContextUsageTranscriptTotals::default();
        let usage = crate::token_usage::TokenUsage {
            total_tokens: 106_000,
            ..Default::default()
        };
        for model in ["unknown-model", "custom-gemini", "custom-claude"] {
            chat.config.model = Some(model.to_string());
            for (reported, configured, expected) in [
                (None, None, None),
                (Some(200_000), None, Some(200_000)),
                (None, Some(300_000), Some(300_000)),
                (Some(200_000), Some(300_000), Some(200_000)),
                (Some(0), None, None),
                (None, Some(0), None),
                (None, Some(-1), None),
                (Some(-1), Some(300_000), Some(300_000)),
            ] {
                chat.config.model_context_window = configured;
                chat.set_token_info(Some(crate::token_usage::TokenUsageInfo {
                    total_token_usage: usage.clone(),
                    last_token_usage: usage.clone(),
                    model_context_window: reported,
                }));
                let snapshot = chat.context_usage_snapshot(&totals);
                assert_eq!(
                    serde_json::to_value(snapshot.window_tokens).unwrap(),
                    serde_json::json!(expected),
                    "model={model}, reported={reported:?}, configured={configured:?}",
                );
                if expected.is_none() {
                    assert_eq!(chat.bottom_pane.context_window_percent(), None);
                    assert_eq!(chat.bottom_pane.context_window_used_tokens(), Some(106_000));
                    chat.add_context_usage_output(totals);
                    let text = plain_text(chat.active_cell_transcript_lines(100).unwrap());
                    assert!(text.contains("capacity unknown"), "{text}");
                    assert!(!text.contains("of context window"), "{text}");
                    let area = ratatui::layout::Rect::new(0, 0, 100, 100);
                    let mut buffer = ratatui::buffer::Buffer::empty(area);
                    chat.render_context_ledger(area, &mut buffer);
                    let ledger: String = buffer.content.iter().map(|cell| cell.symbol()).collect();
                    assert!(ledger.contains("capacity unknown"), "{ledger}");
                    assert!(!ledger.contains("of 258.4k"), "{ledger}");
                }
            }
        }
    }

    #[test]
    fn context_report_qualifies_reasoning_and_compaction_estimates() {
        let attribution = codex_app_server_protocol::ThreadContextAttribution {
            reasoning: 600,
            estimated_total: 600,
            ..Default::default()
        };
        let categories = run_built_context_categories(&attribution);
        for width in [40, 100] {
            let text = plain_text(build_category_bar_chart(&categories, 600, 10_000, width));
            assert!(text.contains("Reasoning + compaction"), "{text}");
            assert!(text.contains("not the effort setting"), "{text}");
            assert!(text.contains("600/10k"), "{text}");
        }

        let without_reasoning = codex_app_server_protocol::ThreadContextAttribution {
            tool_results: 600,
            estimated_total: 600,
            ..Default::default()
        };
        let categories = run_built_context_categories(&without_reasoning);
        let text = plain_text(build_category_bar_chart(&categories, 600, 10_000, 100));
        assert!(text.contains("Tool results"), "{text}");
        assert!(!text.contains("Reasoning + compaction"), "{text}");
        assert!(!text.contains("effort setting"), "{text}");
    }

    /// A server's split may disagree with its own total (a bridged chat's estimates did: 4379
    /// against 3210); Elpis draws it, scaled to the measured context, instead of panicking.
    #[test]
    fn run_built_categories_tolerate_a_total_that_disagrees() {
        let attribution = codex_app_server_protocol::ThreadContextAttribution {
            user_messages: 3000,
            tool_results: 1379,
            estimated_total: 3210,
            ..Default::default()
        };

        let categories =
            reconcile_context_categories(&run_built_context_categories(&attribution), 3210);

        assert_eq!(
            categories
                .iter()
                .map(|category| category.tokens)
                .sum::<u64>(),
            3210
        );
    }

    #[test]
    fn run_built_categories_reconcile_to_measured_context_without_a_gap() {
        let attribution = codex_app_server_protocol::ThreadContextAttribution {
            user_messages: 100,
            agent_messages: 200,
            tool_calls: 300,
            estimated_total: 600,
            ..Default::default()
        };

        let categories =
            reconcile_context_categories(&run_built_context_categories(&attribution), 10_000);

        assert_eq!(
            categories
                .iter()
                .map(|category| category.tokens)
                .sum::<u64>(),
            10_000,
            "estimated categories must sum to measured active context",
        );
        assert_eq!(
            categories
                .iter()
                .map(|category| category.tokens)
                .collect::<Vec<_>>(),
            vec![1_667, 3_333, 5_000],
        );
        assert!(
            categories
                .iter()
                .all(|category| !category.label.contains("gap"))
        );
        assert!(reconcile_context_categories(&[], 10_000).is_empty());
    }

    #[test]
    fn fmt_helpers_produce_compact_values() {
        assert_eq!(fmt_tokens(301), "301");
        assert_eq!(fmt_tokens(39_700), "39.7k");
        assert_eq!(fmt_tokens(1_000_000), "1m");
        assert_eq!(fmt_percent(305, 1_000), "30.5%");
        assert_eq!(fmt_percent(11_300, 121_600), "9.3%");
    }

    fn rgb(color: Color) -> (u8, u8, u8) {
        match color {
            Color::Rgb(red, green, blue) => (red, green, blue),
            other => panic!("expected explicit RGB colour, got {other:?}"),
        }
    }

    fn colors_have_minimum_distance(colors: &[Color], minimum: f64) -> bool {
        colors.iter().enumerate().all(|(index, left)| {
            colors
                .iter()
                .skip(index + 1)
                .all(|right| lab_distance(*left, *right) >= minimum)
        })
    }

    fn relative_luminance(color: Color) -> f64 {
        let linear = |channel: u8| {
            let channel = f64::from(channel) / 255.0;
            if channel <= 0.04045 {
                channel / 12.92
            } else {
                ((channel + 0.055) / 1.055).powf(2.4)
            }
        };
        let (red, green, blue) = rgb(color);
        0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    fn contrast_ratio(left: Color, right: Color) -> f64 {
        let left = relative_luminance(left);
        let right = relative_luminance(right);
        let (lighter, darker) = if left >= right {
            (left, right)
        } else {
            (right, left)
        };
        (lighter + 0.05) / (darker + 0.05)
    }

    #[test]
    fn context_category_palette_uses_distinct_high_contrast_hues() {
        const MINIMUM_LAB_DISTANCE: f64 = 25.0;
        const MINIMUM_CONTRAST: f64 = 4.5;
        let terminal_colors = [
            USER_MESSAGES_COLOR,
            AGENT_RESPONSES_COLOR,
            REASONING_COLOR,
            TOOL_CALLS_COLOR,
            TOOL_RESULTS_COLOR,
            SYSTEM_INSTRUCTIONS_COLOR,
            DEVELOPER_MESSAGES_COLOR,
            TOOL_DEFINITIONS_COLOR,
            UNRECOGNIZED_ITEMS_COLOR,
        ];
        let terminal_background = Color::Rgb(30, 30, 30);

        assert!(colors_have_minimum_distance(
            &terminal_colors,
            MINIMUM_LAB_DISTANCE
        ));
        assert!(
            terminal_colors
                .iter()
                .all(|color| contrast_ratio(*color, terminal_background) >= MINIMUM_CONTRAST)
        );

        let near_duplicate = [Color::Rgb(95, 135, 255), Color::Rgb(96, 136, 255)];
        assert!(!colors_have_minimum_distance(
            &near_duplicate,
            MINIMUM_LAB_DISTANCE
        ));
        assert!(contrast_ratio(Color::Rgb(36, 36, 36), terminal_background) < MINIMUM_CONTRAST);
    }

    fn lab(color: Color) -> (f64, f64, f64) {
        let linear = |channel: u8| {
            let channel = f64::from(channel) / 255.0;
            if channel <= 0.04045 {
                channel / 12.92
            } else {
                ((channel + 0.055) / 1.055).powf(2.4)
            }
        };
        let (red, green, blue) = rgb(color);
        let (red, green, blue) = (linear(red), linear(green), linear(blue));
        let x = (0.4124 * red + 0.3576 * green + 0.1805 * blue) / 0.95047;
        let y = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        let z = (0.0193 * red + 0.1192 * green + 0.9505 * blue) / 1.08883;
        let f = |t: f64| {
            if t > 0.008856 {
                t.cbrt()
            } else {
                7.787 * t + 16.0 / 116.0
            }
        };
        let (fx, fy, fz) = (f(x), f(y), f(z));
        (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))
    }

    fn lab_distance(left: Color, right: Color) -> f64 {
        let (l1, a1, b1) = lab(left);
        let (l2, a2, b2) = lab(right);
        ((l1 - l2).powi(2) + (a1 - a2).powi(2) + (b1 - b2).powi(2)).sqrt()
    }

    #[test]
    fn light_category_palette_keeps_every_pair_apart() {
        const MINIMUM_LAB_DISTANCE: f64 = 25.0;
        let colors = [
            USER_MESSAGES_COLOR,
            AGENT_RESPONSES_COLOR,
            REASONING_COLOR,
            TOOL_CALLS_COLOR,
            TOOL_RESULTS_COLOR,
            SYSTEM_INSTRUCTIONS_COLOR,
            DEVELOPER_MESSAGES_COLOR,
            TOOL_DEFINITIONS_COLOR,
            UNRECOGNIZED_ITEMS_COLOR,
        ]
        .map(light_category_color);
        for (index, left) in colors.iter().enumerate() {
            for right in &colors[index + 1..] {
                let distance = lab_distance(*left, *right);
                assert!(
                    distance >= MINIMUM_LAB_DISTANCE,
                    "{left:?} and {right:?} are only {distance:.1} apart on paper"
                );
            }
            for background in [Color::Rgb(248, 246, 239), Color::Rgb(255, 255, 255)] {
                assert!(
                    contrast_ratio(*left, background) >= 3.0,
                    "{left:?} on {background:?}"
                );
            }
        }
        // The uniform darkening this replaces is what made the bar unreadable.
        let darkened = [TOOL_CALLS_COLOR, TOOL_RESULTS_COLOR].map(|color| {
            let (r, g, b) = rgb(color);
            let deepen = |v: u8| (u16::from(v) * 45 / 100) as u8;
            Color::Rgb(deepen(r), deepen(g), deepen(b))
        });
        assert!(lab_distance(darkened[0], darkened[1]) < MINIMUM_LAB_DISTANCE);
    }

    #[test]
    fn context_categories_follow_terminal_foreground_when_palette_is_unknown() {
        assert_eq!(crate::terminal_palette::default_bg(), None);
        assert_eq!(context_display_color(REASONING_COLOR), Color::Reset);
        assert_eq!(context_free_style().fg, Some(Color::Reset));
    }

    #[test]
    fn context_colors_remain_visible_in_both_appearances() {
        for bg in [(17, 18, 20), (248, 246, 239), (255, 255, 255)] {
            crate::terminal_palette::with_test_default_colors(
                crate::terminal_probe::DefaultColors {
                    fg: (220, 220, 220),
                    bg,
                },
                || {
                    for color in [
                        USER_MESSAGES_COLOR,
                        AGENT_RESPONSES_COLOR,
                        REASONING_COLOR,
                        TOOL_CALLS_COLOR,
                        TOOL_RESULTS_COLOR,
                        SYSTEM_INSTRUCTIONS_COLOR,
                        DEVELOPER_MESSAGES_COLOR,
                        TOOL_DEFINITIONS_COLOR,
                        UNRECOGNIZED_ITEMS_COLOR,
                    ] {
                        assert!(
                            contrast_ratio(
                                context_display_color(color),
                                Color::Rgb(bg.0, bg.1, bg.2)
                            ) >= 3.0
                        );
                    }
                    let lines = build_category_bar_chart(&[], 50, 100, 80);
                    let free = lines
                        .iter()
                        .flat_map(|line| &line.spans)
                        .find(|span| span.content.contains('░'))
                        .unwrap();
                    assert!(
                        contrast_ratio(free.style.fg.unwrap(), Color::Rgb(bg.0, bg.1, bg.2)) >= 3.0
                    );
                    assert!(
                        lines
                            .iter()
                            .flat_map(|line| &line.spans)
                            .any(|span| span.content.contains("50.0% of window"))
                    );
                },
            );
        }
    }

    #[test]
    fn tool_results_use_the_same_yellow_in_bar_and_legend() {
        for bg in [(17, 18, 20), (248, 246, 239)] {
            crate::terminal_palette::with_test_default_colors(
                crate::terminal_probe::DefaultColors {
                    fg: (32, 32, 32),
                    bg,
                },
                || {
                    let yellow = context_display_color(TOOL_RESULTS_COLOR);
                    let (r, g, b) = rgb(yellow);
                    assert!(r >= g && g > b.saturating_add(100));
                    assert_ne!(crate::style::context_style().fg, Some(yellow));
                    let categories = [
                        CategoryUsage {
                            label: "Tool results",
                            tokens: 25,
                            color: TOOL_RESULTS_COLOR,
                        },
                        CategoryUsage {
                            label: "User messages",
                            tokens: 25,
                            color: USER_MESSAGES_COLOR,
                        },
                    ];
                    let chart = build_category_bar_chart(&categories, 50, 100, 80);
                    let spans = chart
                        .iter()
                        .flat_map(|line| &line.spans)
                        .collect::<Vec<_>>();
                    assert!(
                        spans
                            .iter()
                            .any(|span| span.content.contains('█') && span.style.fg == Some(yellow))
                    );
                    assert!(
                        spans
                            .iter()
                            .any(|span| span.content.contains('●') && span.style.fg == Some(yellow))
                    );
                    assert!(spans.iter().any(|span| span.content.contains('█')
                        && span.style.fg == Some(context_display_color(USER_MESSAGES_COLOR))));
                    assert_ne!(yellow, context_display_color(USER_MESSAGES_COLOR));
                    let unattributed = build_category_bar_chart(&[], 50, 100, 80);
                    assert!(
                        unattributed
                            .iter()
                            .flat_map(|line| &line.spans)
                            .any(|span| span.content.contains('█')
                                && span.style.fg == crate::style::context_style().fg)
                    );
                },
            );
        }
    }

    #[test]
    #[ignore]
    fn export_context_appearance_review() {
        use ratatui::widgets::Widget;
        let root = std::path::PathBuf::from(std::env::var("ELPIS_VISUAL_DIR").unwrap());
        std::fs::create_dir_all(&root).unwrap();
        let colors = [
            USER_MESSAGES_COLOR,
            AGENT_RESPONSES_COLOR,
            REASONING_COLOR,
            TOOL_CALLS_COLOR,
            TOOL_RESULTS_COLOR,
            SYSTEM_INSTRUCTIONS_COLOR,
            DEVELOPER_MESSAGES_COLOR,
            TOOL_DEFINITIONS_COLOR,
            UNRECOGNIZED_ITEMS_COLOR,
        ];
        let labels = [
            "User messages",
            "Agent messages",
            "Reasoning",
            "Tool calls",
            "Tool results",
            "System instructions",
            "Developer messages",
            "Tool definitions + schema",
            "Unrecognized request items",
        ];
        let categories: Vec<_> = colors
            .into_iter()
            .zip(labels)
            .enumerate()
            .map(|(i, (color, label))| CategoryUsage {
                label,
                color,
                tokens: (i as u64 + 1) * 1_000,
            })
            .collect();
        for (name, bg, fg) in [
            ("dark", (17, 18, 20), (222, 222, 219)),
            ("light", (248, 246, 239), (45, 43, 38)),
        ] {
            let area = ratatui::layout::Rect::new(0, 0, 100, 18);
            let mut buf = ratatui::buffer::Buffer::empty(area);
            crate::terminal_palette::with_test_default_colors(
                crate::terminal_probe::DefaultColors { fg, bg },
                || {
                    ratatui::widgets::Paragraph::new(build_category_bar_chart(
                        &categories,
                        45_000,
                        90_000,
                        100,
                    ))
                    .style(
                        Style::default()
                            .fg(Color::Rgb(fg.0, fg.1, fg.2))
                            .bg(Color::Rgb(bg.0, bg.1, bg.2)),
                    )
                    .render(area, &mut buf);
                },
            );
            let frame = serde_json::json!({"width":area.width,"height":area.height,
                "cells":buf.content.iter().map(|c| serde_json::json!({"s":c.symbol(),
                    "fg":format!("{:?}",c.fg),"bg":format!("{:?}",c.bg)})).collect::<Vec<_>>()});
            std::fs::write(
                root.join(format!("context-{name}.json")),
                serde_json::to_vec(&frame).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn no_prune_totals_copy_is_neutral_about_automatic_triggering() {
        let text = no_prune_totals_line()
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert_eq!(text, "   No history pruning recorded this thread");
        assert!(!text.contains("trigger"));
        assert!(!text.contains("automatic"));
    }

    #[test]
    fn category_chart_excludes_history_savings_and_disclaims_estimate() {
        let categories = vec![
            CategoryUsage {
                label: "User messages",
                tokens: 20_000,
                color: Color::Blue,
            },
            CategoryUsage {
                label: "Tool calls",
                tokens: 24_100,
                color: Color::Yellow,
            },
        ];

        let lines = build_category_bar_chart(&categories, 44_100, 258_400, 100);
        let text = lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert!(text.contains("24.1k"));
        assert!(text.contains("Context Accounting"));
        assert!(text.contains("history savings excluded"));
        assert!(!text.contains("current context only"));
        assert!(!text.contains("removed earlier"));
        assert!(!text.contains('→'));
        assert_eq!(
            text.matches('[').count(),
            1,
            "context accounting must render exactly one capacity bar",
        );
        assert!(!text.contains("Active Occupancy"));
        assert!(!text.contains("Request Composition"));
        assert!(text.contains("9.3% of context window"));
    }
}
