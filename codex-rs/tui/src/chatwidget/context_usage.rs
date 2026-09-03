//! `/context` command: a colored context-usage grid with a side-by-side per-category
//! legend (grid left, numbers right), a Checkpoints section backed by Elpis's real
//! backtrack mechanism, and a System files (auto-loaded) section backed by the same
//! admitted-source list the Context Ledger renders.
//!
//! ## The math is anchored to one measured number
//!
//! The current request-context count (`token_info.last_token_usage`) is the only
//! headline number. It is the same snapshot used by the status line and the
//! Context Ledger. Transcript and portable-source sizes are attribution estimates
//! only: they are scaled to that measured total, and the request context
//! not represented by the visible transcript is shown as a built-in/estimate gap.

use codex_features::Feature;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;

use super::ChatWidget;
use super::context_ledger::LedgerSourceGroup;
use crate::app_backtrack::ContextUsageTranscriptTotals;
use crate::history_cell::HistoryCell;
use crate::legacy_core::elpis_context::ContinuitySourceCategory;

const GRID_COLUMNS: usize = 26;
const GRID_ROWS: usize = 10;
const GRID_CELLS: usize = GRID_COLUMNS * GRID_ROWS;
const BUILT_IN_CONTEXT_COLOR: Color = Color::Rgb(139, 92, 246);
const PORTABLE_CONTEXT_COLOR: Color = Color::Rgb(215, 119, 87);

#[derive(Clone, Debug)]
struct CategoryUsage {
    label: &'static str,
    tokens: u64,
    color: Color,
}

#[derive(Clone, Debug)]
struct ContextUsageSnapshot {
    model: String,
    used_tokens: Option<u64>,
    window_tokens: u64,
    used_percent: Option<i64>,
    has_request_snapshot: bool,
    categories: Vec<CategoryUsage>,
    saved_tokens: u64,
    sources: Vec<crate::legacy_core::elpis_context::ContinuitySource>,
    backtrack_points: usize,
    native_compaction_count: u64,
    latest_native_compaction: Option<crate::branding::EvictionNotice>,
    rollout_path: Option<std::path::PathBuf>,
}

fn dashboard_source_projection(
    source: &crate::legacy_core::elpis_context::ContinuitySource,
) -> crate::dashboard_server::DashboardSource {
    let name = if source.origin == "manual addition" {
        source.path.file_name()
    } else {
        std::path::Path::new(&source.name).file_name()
    }
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| "Custom source".to_string());
    crate::dashboard_server::DashboardSource {
        name,
        category: LedgerSourceGroup::for_source(source)
            .display_name()
            .to_ascii_lowercase(),
        estimated_tokens: source.estimated_tokens,
        admitted: source.admitted,
    }
}

#[derive(Debug)]
struct ContextUsageHistoryCell {
    before_chart: Vec<Line<'static>>,
    categories: Vec<CategoryUsage>,
    used: u64,
    window: u64,
    after_chart: Vec<Line<'static>>,
}

impl ContextUsageHistoryCell {
    fn rendered_lines(&self, width: u16) -> Vec<Line<'static>> {
        let mut lines = self.before_chart.clone();
        lines.extend(build_category_bar_chart(
            &self.categories,
            self.used,
            self.window,
            width,
        ));
        lines.extend(self.after_chart.clone());
        lines
    }
}

fn instruction_bucket_tokens(
    sources: &[crate::legacy_core::elpis_context::ContinuitySource],
) -> (u64, u64) {
    sources
        .iter()
        .filter(|source| {
            source.category == ContinuitySourceCategory::Instructions && source.admitted
        })
        .fold((0, 0), |(system_prompt, development_rules), source| {
            if matches!(
                source.origin,
                "managed development rules" | "configured development rules"
            ) {
                (
                    system_prompt,
                    development_rules.saturating_add(source.estimated_tokens),
                )
            } else {
                (
                    system_prompt.saturating_add(source.estimated_tokens),
                    development_rules,
                )
            }
        })
}

fn dashboard_css_color(color: Color) -> String {
    match color {
        Color::Blue | Color::LightBlue => "#3b82f6",
        Color::Green | Color::LightGreen => "#22c55e",
        Color::Yellow | Color::LightYellow => "#eab308",
        Color::Magenta | Color::LightMagenta => "#d946ef",
        Color::Cyan | Color::LightCyan => "#06b6d4",
        Color::Gray | Color::DarkGray => "#6b635a",
        BUILT_IN_CONTEXT_COLOR => "#8b5cf6",
        PORTABLE_CONTEXT_COLOR => "#d77757",
        _ => "#6b635a",
    }
    .to_string()
}

impl HistoryCell for ContextUsageHistoryCell {
    fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
        self.rendered_lines(width)
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        let mut lines = self.before_chart.clone();
        lines.extend(build_category_bar_chart(
            &self.categories,
            self.used,
            self.window,
            100,
        ));
        lines.extend(self.after_chart.clone());
        lines
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
        self.add_info_message("Manual pruning command finished".to_string(), None);
        self.request_fresh_context_usage_report();
    }

    pub(super) fn update_context_prune_savings(
        &mut self,
        saved_tokens: u64,
        from_replay: bool,
    ) -> bool {
        if saved_tokens == 0 {
            return false;
        }
        let changed = self.last_prune_saved_tokens != Some(saved_tokens);
        let newly_saved = newly_reclaimed_tokens(self.last_prune_saved_tokens, saved_tokens);
        self.last_prune_saved_tokens = Some(saved_tokens);
        if !from_replay && let Some(line) = saved_context_flash_line(newly_saved) {
            self.bottom_pane.show_saved_context_flash(line);
        }
        changed
    }

    pub(super) fn update_smart_prune_savings(
        &mut self,
        saved_tokens: u64,
        from_replay: bool,
    ) -> bool {
        let previous = self.last_smart_prune_saved_tokens;
        let high_watermark = previous.map_or(saved_tokens, |total| total.max(saved_tokens));
        let changed = previous != Some(high_watermark);
        let newly_saved = previous.map_or(0, |total| saved_tokens.saturating_sub(total));
        self.last_smart_prune_saved_tokens = Some(high_watermark);
        if !from_replay && let Some(line) = smart_prune_saved_context_flash_line(newly_saved) {
            self.bottom_pane.show_saved_context_flash(line);
        }
        changed
    }

    fn context_usage_snapshot(
        &self,
        totals: &ContextUsageTranscriptTotals,
    ) -> ContextUsageSnapshot {
        let sources = self.continuity_sources();
        // Only admitted instruction sources count. Their stable provenance, not a
        // directory-name guess, determines which attribution bucket receives them.
        let (workspace_instruction_tokens, development_rule_tokens) =
            instruction_bucket_tokens(&sources);
        let portable_context_tokens = sources
            .iter()
            .filter(|source| {
                source.admitted && source.category != ContinuitySourceCategory::Instructions
            })
            .map(|source| source.estimated_tokens)
            .sum::<u64>();

        let estimate =
            |bytes: usize| codex_utils_string::approx_tokens_from_byte_count(bytes) as u64;
        // Workspace instructions and development rules are fixed admitted-source costs.
        // They must NEVER be scaled up to absorb unexplained usage
        // (that is what previously inflated Development rules to nonsense figures).
        let fixed_system = workspace_instruction_tokens;
        let fixed_development_rules = development_rule_tokens;
        let fixed_portable_context = portable_context_tokens;
        let conversation_estimates: [u64; 3] = [
            estimate(totals.user_message_bytes),
            estimate(totals.agent_response_bytes),
            estimate(totals.tool_activity_bytes),
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
        let used_tokens = self
            .token_info
            .as_ref()
            .map(|_| last_usage.tokens_in_context_window().max(0) as u64)
            .map(|used| used.min(window));
        let used = used_tokens.unwrap_or(0);
        let raw_categories = [
            conversation_estimates[0],
            conversation_estimates[1],
            conversation_estimates[2],
            fixed_system,
            fixed_development_rules,
            fixed_portable_context,
        ];
        let category_tokens = scale_token_counts(&raw_categories, used);
        let conversation = [category_tokens[0], category_tokens[1], category_tokens[2]];
        let fixed_system = category_tokens[3];
        let fixed_development_rules = category_tokens[4];
        let fixed_portable_context = category_tokens[5];
        let agent_runtime = used.saturating_sub(category_tokens.iter().sum());
        let saved_tokens = self.last_prune_saved_tokens.unwrap_or(0);

        let mut categories = vec![
            CategoryUsage {
                label: "User messages",
                tokens: conversation[0],
                color: Color::LightBlue,
            },
            CategoryUsage {
                label: "Agent responses",
                tokens: conversation[1],
                color: Color::LightGreen,
            },
            CategoryUsage {
                label: "Tool activity",
                tokens: conversation[2],
                color: Color::LightYellow,
            },
            CategoryUsage {
                label: "Workspace instructions",
                tokens: fixed_system,
                color: Color::LightMagenta,
            },
            CategoryUsage {
                label: "Development rules",
                tokens: fixed_development_rules,
                color: Color::LightCyan,
            },
            CategoryUsage {
                label: "Portable context",
                tokens: fixed_portable_context,
                color: PORTABLE_CONTEXT_COLOR,
            },
        ];
        if agent_runtime > 0 {
            categories.push(CategoryUsage {
                label: "Built-in + estimate gap",
                tokens: agent_runtime,
                color: BUILT_IN_CONTEXT_COLOR,
            });
        }
        categories.retain(|category| category.tokens > 0);
        let used_percent = has_request_snapshot
            .then(|| self.status_line_context_used_percent())
            .flatten();
        let (native_compaction_count, latest_native_compaction) =
            crate::branding::compaction_evidence();

        ContextUsageSnapshot {
            model: self
                .config
                .model
                .clone()
                .unwrap_or_else(|| "model".to_string()),
            used_tokens,
            window_tokens: window,
            used_percent,
            has_request_snapshot,
            categories,
            saved_tokens,
            sources,
            backtrack_points: totals.checkpoints,
            native_compaction_count,
            latest_native_compaction,
            rollout_path: self.rollout_path(),
        }
    }

    /// Refreshes the `/dashboard` web view's typed live state. Cheap: only recomputes
    /// the same numbers `/context` already computes and merges semantic changes.
    pub(crate) fn publish_dashboard_snapshot(&self, totals: &ContextUsageTranscriptTotals) {
        let snapshot = self.context_usage_snapshot(totals);
        let categories = snapshot.has_request_snapshot.then(|| {
            snapshot
                .categories
                .iter()
                .map(|category| crate::dashboard_server::DashboardCategory {
                    label: category.label.to_string(),
                    tokens: category.tokens,
                    color: dashboard_css_color(category.color),
                })
                .collect()
        });

        let sources = snapshot
            .sources
            .iter()
            .map(dashboard_source_projection)
            .collect();

        let to_totals = |usage: &crate::token_usage::TokenUsage| {
            crate::dashboard_server::DashboardTokenTotals {
                input: usage.input_tokens,
                cached_input: usage.cached_input_tokens,
                cache_write: usage.cache_write_tokens,
                output: usage.output_tokens,
                reasoning_output: usage.reasoning_output_tokens,
                total: usage.total_tokens,
            }
        };
        let session_total = self
            .token_info
            .as_ref()
            .map(|info| to_totals(&info.total_token_usage));
        let last_turn = self
            .token_info
            .as_ref()
            .map(|info| to_totals(&info.last_token_usage));
        let smart_prune_latest = self.smart_prune.latest.as_ref().map(|latest| {
            crate::dashboard_server::DashboardSmartPruneLatest {
                examined_outputs: latest.examined_outputs,
                admitted_outputs: latest.admitted_outputs,
                approx_source_tokens: latest.approx_source_tokens,
                approx_admitted_tokens: latest.approx_admitted_tokens,
                approx_saved_tokens: latest.approx_saved_tokens,
                request_linkage_verified: latest.request_linkage_verified,
                response_usage: latest.response_usage.as_ref().map(|usage| {
                    to_totals(&crate::token_usage::TokenUsage {
                        input_tokens: usage.input_tokens,
                        cached_input_tokens: usage.cached_input_tokens,
                        cache_write_tokens: usage.cache_write_tokens,
                        output_tokens: usage.output_tokens,
                        reasoning_output_tokens: usage.reasoning_output_tokens,
                        total_tokens: usage.total_tokens,
                    })
                }),
                response_linkage_verified: latest.response_linkage_verified,
            }
        });
        let smart_prune = crate::dashboard_server::DashboardSmartPrune {
            configured_enabled: self
                .config
                .features
                .enabled(Feature::AutomaticContextPruning),
            current_thread_next_turn_enabled: self.current_thread_smart_prune_enabled(),
            examined_outputs: self.smart_prune.examined_outputs,
            admitted_outputs: self.smart_prune.admitted_outputs,
            unchanged_outputs: self.smart_prune.unchanged_outputs,
            failed_batches: self.smart_prune.failed_batches,
            approx_source_tokens: self.smart_prune.approx_source_tokens,
            approx_admitted_tokens: self.smart_prune.approx_admitted_tokens,
            approx_saved_tokens: self.smart_prune.approx_saved_tokens,
            optimizer_requests: self.smart_prune.optimizer_requests,
            optimizer_usage_reports: self.smart_prune.optimizer_usage_reports,
            optimizer_usage: crate::dashboard_server::DashboardTokenTotals {
                input: self.smart_prune.optimizer_usage.input_tokens,
                cached_input: self.smart_prune.optimizer_usage.cached_input_tokens,
                cache_write: self.smart_prune.optimizer_usage.cache_write_tokens,
                output: self.smart_prune.optimizer_usage.output_tokens,
                reasoning_output: self.smart_prune.optimizer_usage.reasoning_output_tokens,
                total: self.smart_prune.optimizer_usage.total_tokens,
            },
            optimizer_latency_ms: self.smart_prune.optimizer_latency_ms,
            latest: smart_prune_latest,
        };

        crate::dashboard_server::publish_state(
            crate::dashboard_server::DashboardContext {
                model: snapshot.model,
                used_tokens: snapshot.used_tokens,
                window_tokens: snapshot.window_tokens,
                used_percent: snapshot.used_percent,
                categories,
                saved_tokens: snapshot.saved_tokens,
                sources,
                backtrack_points: snapshot.backtrack_points,
            },
            crate::dashboard_server::DashboardTokens {
                session_total,
                last_turn,
            },
            self.dashboard_activity_state(),
            smart_prune,
        );
    }

    pub(crate) fn add_context_usage_output(&mut self, totals: ContextUsageTranscriptTotals) {
        let snapshot = self.context_usage_snapshot(&totals);
        let used = snapshot.used_tokens.unwrap_or(0);
        let window = snapshot.window_tokens;
        let categories = snapshot.categories.clone();
        let saved_tokens = snapshot.saved_tokens;
        let free = window.saturating_sub(used);

        // Right-hand legend, one entry per grid row.
        let model = snapshot.model.clone();
        let mut legend: Vec<Line<'static>> = Vec::new();
        let used_percent = fmt_percent(used, window);
        let free_percent = fmt_percent(free, window);
        legend.push(
            format!(
                "{model} · {}/{} tokens ({used_percent} used)",
                fmt_tokens(used),
                fmt_tokens(window),
            )
            .bold()
            .into(),
        );
        legend.push(
            "Estimated attribution (not a provider breakdown)"
                .bold()
                .into(),
        );
        for category in &categories {
            legend.push(category_legend_line(category, window));
        }
        legend.push(Line::from(vec![
            Span::from("□ ").dim(),
            Span::from(format!(
                "Free space: {} ({free_percent} left)",
                fmt_tokens(free),
            ))
            .dim(),
        ]));
        if saved_tokens > 0 {
            legend.push(Line::from(vec![
                Span::styled("✨ ", Style::default().fg(Color::Green)),
                Span::styled(
                    format!(
                        "History pruning: ~{} tokens removed earlier in this history",
                        fmt_tokens(saved_tokens)
                    ),
                    Style::default().fg(Color::Green).bold(),
                ),
            ]));
        }
        if !snapshot.has_request_snapshot {
            legend.push("(no measured request snapshot yet)".dim().into());
        }

        let mut before_chart: Vec<Line<'static>> = Vec::new();
        before_chart.push(" Context Usage".bold().into());
        before_chart.extend(build_grid_with_legend(&categories, used, window, legend));
        before_chart.push(
            " Headline total is measured; rows estimate it from visible transcript and admitted files."
                .dim()
                .into(),
        );
        before_chart.push(
        " Built-in + estimate gap includes built-in instructions, tool definitions, hidden history, images, protocol, and estimation error; not all is prunable."
                .dim()
                .into(),
        );
        before_chart.push(Line::default());

        let mut after_chart = vec![Line::default()];
        after_chart.push(" History Pruning Audit".bold().into());
        if self.last_prune_saved_tokens.is_none() {
            after_chart.push(no_prune_totals_line());
        } else {
            after_chart.push(Line::from(vec![
                Span::from("   Status: "),
                Span::styled(
                    "cumulative thread history",
                    Style::default().fg(Color::Cyan).bold(),
                ),
                Span::from(" · "),
                Span::styled(
                    format!("~{} tokens removed earlier", fmt_tokens(saved_tokens)),
                    Style::default().fg(Color::Green).bold(),
                ),
                Span::styled(" ⚡", Style::default().fg(Color::Yellow)),
            ]));
            after_chart.push(
                "   History pruning rewrites completed tool-result history; category estimates exclude saved totals."
                    .dim()
                    .into(),
            );
        }
        after_chart.push(Line::default());

        after_chart.push(" Checkpoints · Esc Esc to backtrack".bold().into());
        if snapshot.backtrack_points == 0 {
            after_chart.push(
                "   No backtrack points yet — send a message first."
                    .dim()
                    .into(),
            );
        } else {
            after_chart.push(
                format!(
                    "   {} backtrack point(s) available — Esc Esc jumps to a prior message and forks from it.",
                    snapshot.backtrack_points
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
        };
        self.flush_active_cell();
        self.transcript.active_cell = Some(Box::new(cell));
        self.bump_active_cell_revision();
        self.request_redraw();
    }
}

#[cfg(test)]
fn render_dashboard_lines(snapshot: &ContextUsageSnapshot, width: u16) -> Vec<Line<'static>> {
    let narrow = width < 80;
    let mut lines = Vec::new();

    match (snapshot.used_tokens, snapshot.used_percent) {
        (Some(used), Some(_)) => {
            let used_percent = fmt_percent(used, snapshot.window_tokens);
            let free_percent = fmt_percent(
                snapshot.window_tokens.saturating_sub(used),
                snapshot.window_tokens,
            );
            lines.push(Line::from(vec![
                Span::from(" "),
                snapshot.model.clone().bold(),
                " · ".dim(),
                format!(
                    "{} / {} tokens",
                    fmt_tokens(used),
                    fmt_tokens(snapshot.window_tokens)
                )
                .cyan()
                .bold(),
                format!(" · {used_percent} used · {free_percent} free").dim(),
            ]));
            lines.extend(build_category_bar_chart(
                &snapshot.categories,
                used,
                snapshot.window_tokens,
                width,
            ));
        }
        _ => {
            lines.push(Line::from(vec![
                Span::from(" "),
                snapshot.model.clone().bold(),
                " · context occupancy not recorded yet".dim(),
            ]));
            lines.push(
                "   Send the first provider request to establish a measured snapshot."
                    .dim()
                    .into(),
            );
        }
    }
    lines.push(if narrow {
        "   Estimates by category/source · headline is measured."
            .dim()
            .into()
    } else {
        "   Category and source sizes are attribution estimates; the occupancy above is measured."
            .dim()
            .into()
    });

    lines.push(Line::default());
    lines.push(" Context Ledger".bold().into());
    if snapshot.sources.is_empty() {
        lines.push("   No continuity sources discovered.".dim().into());
    } else {
        for group in LedgerSourceGroup::ALL {
            let sources = snapshot
                .sources
                .iter()
                .filter(|source| LedgerSourceGroup::for_source(source) == group);
            if !snapshot
                .sources
                .iter()
                .any(|source| LedgerSourceGroup::for_source(source) == group)
            {
                continue;
            }
            lines.push(format!("   {}", group.display_name()).bold().into());
            for source in sources {
                let (marker, state, style) = if source.admitted {
                    ("●", "admitted", Style::default().fg(Color::LightGreen))
                } else {
                    ("○", "discovered", Style::default().fg(Color::DarkGray))
                };
                let control = if source.selectable {
                    "toggleable"
                } else {
                    "fixed"
                };
                let mut source_line = vec![
                    Span::styled(format!("     {marker} {state:<10}"), style),
                    source.name.clone().bold(),
                ];
                let metadata = format!(
                    "≈{} tokens · {} bytes · {control}",
                    fmt_tokens(source.estimated_tokens),
                    source.bytes,
                );
                if narrow {
                    lines.push(Line::from(source_line));
                    lines.push(format!("       {metadata}").dim().into());
                } else {
                    source_line.push(format!(" · {metadata}").dim());
                    lines.push(Line::from(source_line));
                }
                lines.push(format!("       {}", source.path.display()).dim().into());
                lines.push(
                    format!("       {} · {}", source.reason, source.lifetime)
                        .dim()
                        .into(),
                );
            }
        }
    }

    lines.push(Line::default());
    lines.push(" Continuity evidence".bold().into());
    let pruning = if snapshot.saved_tokens > 0 {
        format!(
            "~{} removed earlier in history",
            fmt_tokens(snapshot.saved_tokens)
        )
    } else {
        "none recorded".to_string()
    };
    if narrow {
        lines.push(Line::from(vec![
            Span::from("   Pruning "),
            Span::styled(pruning, Style::default().fg(Color::LightGreen).bold()),
        ]));
        lines.push(Line::from(vec![
            Span::from("   Native compaction (process) "),
            format!("{} recorded", snapshot.native_compaction_count).cyan(),
        ]));
        lines.push(Line::from(vec![
            Span::from("   Backtrack "),
            format!("{} available", snapshot.backtrack_points).yellow(),
        ]));
        lines.push(
            "   Pruning checkpoint count unavailable in this UI snapshot."
                .dim()
                .into(),
        );
    } else {
        lines.push(Line::from(vec![
            Span::from("   Pruning "),
            Span::styled(pruning, Style::default().fg(Color::LightGreen).bold()),
            "  ·  Native compaction (process) ".dim(),
            format!("{} recorded", snapshot.native_compaction_count).cyan(),
            "  ·  Backtrack ".dim(),
            format!("{} available", snapshot.backtrack_points).yellow(),
        ]));
        lines.push(
            "   Pruning checkpoint count: not recorded in the current UI snapshot."
                .dim()
                .into(),
        );
    }
    if let Some(latest) = &snapshot.latest_native_compaction {
        if narrow {
            lines.push(
                format!(
                    "   Latest process compaction: {} · {}",
                    latest.reason, latest.count
                )
                .into(),
            );
            lines.push(format!("     evidence {}", latest.evidence).dim().into());
        } else {
            lines.push(
                format!(
                    "   Latest process compaction: {} · {} · evidence {}",
                    latest.reason, latest.count, latest.evidence
                )
                .into(),
            );
        }
    }
    match &snapshot.rollout_path {
        Some(path) => lines.push(Line::from(vec![
            Span::from("   Rollout "),
            path.display().to_string().cyan(),
        ])),
        None => lines.push(
            "   Rollout evidence not available for this session."
                .dim()
                .into(),
        ),
    }

    lines.push(Line::default());
    lines.push(if narrow {
        " Accounting only · no quality, cost, or causal claims."
            .dim()
            .into()
    } else {
        " Context accounting only · no task-quality, cost, or causal claims."
            .dim()
            .into()
    });
    lines
}

/// Scale attribution estimates down when they exceed the measured request
/// context. If the estimates are smaller, keep them raw and let the caller show
/// the remainder as built-in context plus estimation gap.
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
    width: u16,
) -> Vec<Line<'static>> {
    let bar_width = 24usize;
    let narrow = width < 80;
    let mut lines = Vec::new();
    lines.push(Line::from(
        " Estimated Attribution · history savings excluded".bold(),
    ));

    let overall_cells = if window > 0 {
        (((used * bar_width as u64) / window) as usize).min(bar_width)
    } else {
        0
    };
    let filled_overall = "█".repeat(overall_cells);
    let empty_overall = "░".repeat(bar_width - overall_cells);
    if narrow {
        lines.push(Line::from(format!(
            "   Overall · {}/{} · {} used",
            fmt_tokens(used),
            fmt_tokens(window),
            fmt_percent(used, window)
        )));
        lines.push(Line::from(vec![
            Span::from("   "),
            Span::styled(
                format!("[{filled_overall}{empty_overall}]"),
                Style::default().fg(Color::Cyan),
            ),
        ]));
    } else {
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
    }

    let largest_current = categories
        .iter()
        .map(|category| category.tokens)
        .max()
        .unwrap_or(0)
        .max(1);
    for category in categories {
        let current_cells = ((category.tokens * bar_width as u64) / largest_current) as usize;
        let empty_cells = bar_width.saturating_sub(current_cells);
        let bar = vec![
            Span::from(if narrow { "   [" } else { "[" }),
            Span::styled(
                "█".repeat(current_cells),
                Style::default().fg(category.color),
            ),
            Span::from("░".repeat(empty_cells)).dim(),
            Span::from("]"),
        ];
        if narrow {
            lines.push(Line::from(vec![
                Span::from(format!("   {} · ", category.label)),
                Span::from(fmt_tokens(category.tokens)),
            ]));
            lines.push(Line::from(bar));
        } else {
            let mut spans = vec![Span::from(format!("   {:16} ", category.label))];
            spans.extend(bar);
            spans.push(Span::from(" "));
            spans.push(Span::from(fmt_tokens(category.tokens)));
            lines.push(Line::from(spans));
        }
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
    let used_cells =
        ((u128::from(used.min(window)) * GRID_CELLS as u128) / u128::from(window.max(1))) as usize;
    let counts = category_grid_cell_counts(categories, used_cells);
    let allocated_colors = categories
        .iter()
        .zip(counts)
        .flat_map(|(category, count)| std::iter::repeat_n(category.color, count));
    let mut cells = vec![None; GRID_CELLS];
    for (position, color) in allocated_colors.enumerate() {
        // Fill top-to-bottom before moving right so a 9%-full context reads as
        // roughly 9% of the grid's width, rather than an almost-full first row.
        let row = position % GRID_ROWS;
        let column = position / GRID_ROWS;
        cells[row * GRID_COLUMNS + column] = Some(color);
    }

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

fn category_grid_cell_counts(categories: &[CategoryUsage], used_cells: usize) -> Vec<usize> {
    let total = categories
        .iter()
        .map(|category| u128::from(category.tokens))
        .sum::<u128>();
    if total == 0 || used_cells == 0 {
        return vec![0; categories.len()];
    }

    let mut remainders = Vec::with_capacity(categories.len());
    let mut counts = categories
        .iter()
        .enumerate()
        .map(|(index, category)| {
            let scaled = u128::from(category.tokens) * used_cells as u128;
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
    counts
}

fn category_legend_line(category: &CategoryUsage, window: u64) -> Line<'static> {
    Line::from(vec![
        Span::styled("● ", Style::default().fg(category.color)),
        Span::from(format!(
            "{}: {} tokens ({} of window)",
            category.label,
            fmt_tokens(category.tokens),
            fmt_percent(category.tokens, window),
        )),
    ])
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

fn smart_prune_saved_context_flash_line(saved_tokens: u64) -> Option<Line<'static>> {
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

fn no_prune_totals_line() -> Line<'static> {
    "   No history pruning recorded this thread".dim().into()
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
    let window = window.max(1);
    let tenths = tokens.saturating_mul(1000).saturating_add(window / 2) / window;
    format!("{}.{}%", tenths / 10, tenths % 10)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_memory_dashboard_source_projection_does_not_serialize_custom_absolute_paths() {
        let absolute_path = "/home/private-user/context/secret-plan.md";
        let source = crate::legacy_core::elpis_context::ContinuitySource {
            name: absolute_path.to_string(),
            path: std::path::PathBuf::from(absolute_path),
            bytes: 128,
            estimated_tokens: 32,
            category: ContinuitySourceCategory::Files,
            origin: "manual addition",
            lifetime: "every turn",
            reason: "manually added file",
            admitted: true,
            selectable: true,
        };

        let projected = dashboard_source_projection(&source);
        let serialized = serde_json::to_string(&projected).expect("serialize dashboard source");

        assert_eq!(projected.name, "secret-plan.md");
        assert_eq!(projected.category, "user files");
        assert!(!serialized.contains(absolute_path));
        assert!(!serialized.contains("/home/private-user"));
    }

    fn filled_cells(lines: &[Line<'static>]) -> usize {
        lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .filter(|span| span.content.contains('●'))
            .count()
    }

    fn grid_color_counts(lines: &[Line<'static>]) -> std::collections::HashMap<Color, usize> {
        let mut counts = std::collections::HashMap::new();
        for span in lines.iter().flat_map(|line| line.spans.iter()) {
            if span.content.contains('●')
                && let Some(color) = span.style.fg
            {
                *counts.entry(color).or_insert(0) += 1;
            }
        }
        counts
    }

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
    fn grid_allocates_screenshot_categories_fairly_and_fills_by_column() {
        let categories = vec![
            CategoryUsage {
                label: "User messages",
                tokens: 17,
                color: Color::LightBlue,
            },
            CategoryUsage {
                label: "Agent responses",
                tokens: 251,
                color: Color::LightGreen,
            },
            CategoryUsage {
                label: "Tool calls",
                tokens: 1_400,
                color: Color::LightYellow,
            },
            CategoryUsage {
                label: "Development rules",
                tokens: 2_900,
                color: Color::LightCyan,
            },
            CategoryUsage {
                label: "Built-in + estimate gap",
                tokens: 6_732,
                color: BUILT_IN_CONTEXT_COLOR,
            },
        ];

        let lines = build_grid_with_legend(&categories, 11_300, 121_600, Vec::new());
        assert_eq!(filled_cells(&lines), 24);
        assert_eq!(
            grid_color_counts(&lines),
            std::collections::HashMap::from([
                (Color::LightGreen, 1),
                (Color::LightYellow, 3),
                (Color::LightCyan, 6),
                (BUILT_IN_CONTEXT_COLOR, 14),
            ])
        );
        for (row_index, row) in lines.iter().enumerate() {
            assert_eq!(row.spans[1].content, "● ");
            assert_eq!(row.spans[2].content, "● ");
            assert_eq!(
                row.spans[3].content,
                if row_index < 4 { "● " } else { "□ " }
            );
            assert_eq!(row.spans[4].content, "□ ");
        }
    }

    #[test]
    fn category_legend_keeps_user_and_built_in_context_colors_distinct() {
        let user = CategoryUsage {
            label: "User messages",
            tokens: 17,
            color: Color::LightBlue,
        };
        let built_in = CategoryUsage {
            label: "Built-in + estimate gap",
            tokens: 6_732,
            color: BUILT_IN_CONTEXT_COLOR,
        };

        let user_legend = category_legend_line(&user, 121_600);
        let built_in_legend = category_legend_line(&built_in, 121_600);
        assert_eq!(user_legend.spans[0].style.fg, Some(Color::LightBlue));
        assert_eq!(
            built_in_legend.spans[0].style.fg,
            Some(BUILT_IN_CONTEXT_COLOR)
        );
        assert_ne!(
            user_legend.spans[0].style.fg,
            built_in_legend.spans[0].style.fg
        );
    }

    #[test]
    fn context_report_groups_manual_additions_as_user_files() {
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".to_string(),
            used_tokens: None,
            window_tokens: 200_000,
            used_percent: None,
            has_request_snapshot: false,
            categories: Vec::new(),
            saved_tokens: 0,
            sources: vec![
                crate::legacy_core::elpis_context::ContinuitySource {
                    name: "GOAL.md".to_string(),
                    path: std::path::PathBuf::from("/workspace/GOAL.md"),
                    bytes: 64,
                    estimated_tokens: 16,
                    category: ContinuitySourceCategory::Files,
                    origin: "Elpis workspace state",
                    lifetime: "every turn",
                    reason: "active workspace goal",
                    admitted: true,
                    selectable: true,
                },
                crate::legacy_core::elpis_context::ContinuitySource {
                    name: "/workspace/notes.md".to_string(),
                    path: std::path::PathBuf::from("/workspace/notes.md"),
                    bytes: 80,
                    estimated_tokens: 20,
                    category: ContinuitySourceCategory::Files,
                    origin: "manual addition",
                    lifetime: "every turn",
                    reason: "manually added file",
                    admitted: true,
                    selectable: true,
                },
            ],
            backtrack_points: 0,
            native_compaction_count: 0,
            latest_native_compaction: None,
            rollout_path: None,
        };

        let text = plain_text(render_dashboard_lines(&snapshot, 100));
        assert!(text.contains("SESSION CONTINUITY"));
        assert!(text.contains("● admitted  GOAL.md"));
        assert!(text.contains("USER FILES"));
        assert!(text.contains("● admitted  /workspace/notes.md"));
    }

    #[test]
    fn fmt_helpers_produce_compact_values() {
        assert_eq!(fmt_tokens(301), "301");
        assert_eq!(fmt_tokens(39_700), "39.7k");
        assert_eq!(fmt_tokens(1_000_000), "1m");
        assert_eq!(fmt_percent(305, 1_000), "30.5%");
        assert_eq!(fmt_percent(11_300, 121_600), "9.3%");
    }

    #[test]
    fn instruction_attribution_uses_origin_not_path_components() {
        let sources = [
            crate::legacy_core::elpis_context::ContinuitySource {
                name: "dev/AGENTS.md".to_string(),
                path: std::path::PathBuf::from("/tmp/dev-rules/AGENTS.md"),
                bytes: 480,
                estimated_tokens: 120,
                category: ContinuitySourceCategory::Instructions,
                origin: "configured development rules",
                lifetime: "every turn",
                reason: "configured development rules",
                admitted: true,
                selectable: true,
            },
            crate::legacy_core::elpis_context::ContinuitySource {
                name: "Project AGENTS.md".to_string(),
                path: std::path::PathBuf::from("/tmp/project/skills/AGENTS.md"),
                bytes: 320,
                estimated_tokens: 80,
                category: ContinuitySourceCategory::Instructions,
                origin: "runtime instructions",
                lifetime: "every turn",
                reason: "applicable project rules",
                admitted: true,
                selectable: true,
            },
        ];

        assert_eq!(instruction_bucket_tokens(&sources), (80, 120));
    }

    #[test]
    fn dashboard_preserves_portable_and_built_in_category_colors() {
        assert_eq!(dashboard_css_color(PORTABLE_CONTEXT_COLOR), "#d77757");
        assert_eq!(dashboard_css_color(BUILT_IN_CONTEXT_COLOR), "#8b5cf6");
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
    fn smart_prune_flash_is_plain_and_specific() {
        let line = smart_prune_saved_context_flash_line(3_300).expect("Smart Prune flash");
        assert_eq!(
            plain_text(vec![line]),
            "✂ Smart Prune saved ~3.3k tokens · snip!"
        );
        assert!(smart_prune_saved_context_flash_line(0).is_none());
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
        assert!(text.contains("Estimated Attribution"));
        assert!(text.contains("history savings excluded"));
        assert!(!text.contains("current context only"));
        assert!(!text.contains("removed earlier"));
        assert!(!text.contains('→'));
    }

    #[test]
    fn dashboard_lines_keep_measured_usage_and_source_provenance_together() {
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".to_string(),
            used_tokens: Some(42_000),
            window_tokens: 200_000,
            used_percent: Some(21),
            has_request_snapshot: true,
            categories: vec![CategoryUsage {
                label: "Tool activity",
                tokens: 12_000,
                color: Color::Yellow,
            }],
            saved_tokens: 6_000,
            sources: vec![crate::legacy_core::elpis_context::ContinuitySource {
                name: "GOAL.md".to_string(),
                path: std::path::PathBuf::from("/workspace/GOAL.md"),
                bytes: 1_024,
                origin: "Elpis workspace state",
                estimated_tokens: 256,
                category: ContinuitySourceCategory::Files,
                lifetime: "until goal completion",
                reason: "the active objective",
                admitted: true,
                selectable: true,
            }],
            backtrack_points: 2,
            native_compaction_count: 1,
            latest_native_compaction: Some(crate::branding::EvictionNotice {
                count: 1,
                reason: "context compaction".to_string(),
                evidence: "thread:t/turn:u".to_string(),
            }),
            rollout_path: Some(std::path::PathBuf::from("/tmp/rollout.jsonl")),
        };

        let text = render_dashboard_lines(&snapshot, 100)
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert!(text.contains("42k / 200k tokens"));
        assert!(text.contains("GOAL.md"));
        assert!(text.contains("/workspace/GOAL.md"));
        assert!(text.contains("≈256 tokens"));
        assert!(text.contains("6k removed earlier in history"));
        assert!(text.contains("1 recorded"));
        assert!(text.contains("thread:t/turn:u"));
        assert!(text.contains("/tmp/rollout.jsonl"));
        assert!(text.contains("not recorded in the current UI snapshot"));
        assert!(
            render_dashboard_lines(&snapshot, 60)
                .iter()
                .all(|line| line.width() <= 60),
            "narrow dashboard fixture must not rely on wrapping"
        );

        insta::assert_snapshot!(plain_text(render_dashboard_lines(&snapshot, 100)), @r"
gpt-test · 42k / 200k tokens · 21.0% used · 79.0% free
Estimated Attribution · history savings excluded
  Overall Capacity [█████░░░░░░░░░░░░░░░░░░░] 42k/200k tokens (21.0% used)
  Tool activity    [████████████████████████] 12k
  Category and source sizes are attribution estimates; the occupancy above is measured.

Context Ledger
  SESSION CONTINUITY
    ● admitted  GOAL.md · ≈256 tokens · 1024 bytes · toggleable
      /workspace/GOAL.md
      the active objective · until goal completion

Continuity evidence
  Pruning ~6k removed earlier in history  ·  Native compaction (process) 1 recorded  ·  Backtrack 2 available
  Pruning checkpoint count: not recorded in the current UI snapshot.
  Latest process compaction: context compaction · 1 · evidence thread:t/turn:u
  Rollout /tmp/rollout.jsonl

Context accounting only · no task-quality, cost, or causal claims.
");
        insta::assert_snapshot!(plain_text(render_dashboard_lines(&snapshot, 60)), @r"
gpt-test · 42k / 200k tokens · 21.0% used · 79.0% free
Estimated Attribution · history savings excluded
  Overall · 42k/200k · 21.0% used
  [█████░░░░░░░░░░░░░░░░░░░]
  Tool activity · 12k
  [████████████████████████]
  Estimates by category/source · headline is measured.

Context Ledger
  SESSION CONTINUITY
    ● admitted  GOAL.md
      ≈256 tokens · 1024 bytes · toggleable
      /workspace/GOAL.md
      the active objective · until goal completion

Continuity evidence
  Pruning ~6k removed earlier in history
  Native compaction (process) 1 recorded
  Backtrack 2 available
  Pruning checkpoint count unavailable in this UI snapshot.
  Latest process compaction: context compaction · 1
    evidence thread:t/turn:u
  Rollout /tmp/rollout.jsonl

Accounting only · no quality, cost, or causal claims.
");
    }

    #[test]
    fn dashboard_leads_with_measured_visual_context() {
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".to_string(),
            used_tokens: Some(42_000),
            window_tokens: 200_000,
            used_percent: Some(21),
            has_request_snapshot: true,
            categories: vec![CategoryUsage {
                label: "Tool calls",
                tokens: 12_000,
                color: Color::Yellow,
            }],
            saved_tokens: 6_000,
            sources: Vec::new(),
            backtrack_points: 2,
            native_compaction_count: 1,
            latest_native_compaction: None,
            rollout_path: None,
        };

        let lines = render_dashboard_lines(&snapshot, 100);
        let first_line = lines
            .iter()
            .find(|line| !line.spans.is_empty())
            .expect("dashboard has content")
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        let text = lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert!(first_line.contains("gpt-test · 42k / 200k"));
        assert!(
            text.contains('█'),
            "dashboard needs a visual occupancy mark"
        );
        assert!(!text.contains("Read-only observability view"));
    }

    #[test]
    fn dashboard_primary_visuals_fit_a_narrow_terminal() {
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".to_string(),
            used_tokens: Some(42_000),
            window_tokens: 200_000,
            used_percent: Some(21),
            has_request_snapshot: true,
            categories: vec![CategoryUsage {
                label: "Tool calls",
                tokens: 12_000,
                color: Color::Yellow,
            }],
            saved_tokens: 6_000,
            sources: Vec::new(),
            backtrack_points: 2,
            native_compaction_count: 1,
            latest_native_compaction: None,
            rollout_path: None,
        };

        let overflowing = render_dashboard_lines(&snapshot, 60)
            .into_iter()
            .filter(|line| line.width() > 60)
            .map(|line| {
                line.spans
                    .into_iter()
                    .map(|span| span.content.into_owned())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();

        assert!(
            overflowing.is_empty(),
            "primary dashboard rows must not wrap at 60 columns: {overflowing:?}"
        );
    }

    #[test]
    fn dashboard_does_not_turn_missing_request_usage_into_zero() {
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".to_string(),
            used_tokens: None,
            window_tokens: 200_000,
            used_percent: None,
            has_request_snapshot: false,
            categories: Vec::new(),
            saved_tokens: 0,
            sources: Vec::new(),
            backtrack_points: 0,
            native_compaction_count: 0,
            latest_native_compaction: None,
            rollout_path: None,
        };

        let text = render_dashboard_lines(&snapshot, 100)
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert!(text.contains("not recorded yet"));
        assert!(!text.contains("0 / 200k tokens"));
    }
}
