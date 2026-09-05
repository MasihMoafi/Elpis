//! `/context` command: one category-segmented full-window usage bar, a Checkpoints
//! section backed by Elpis's real backtrack mechanism, and a System files
//! (auto-loaded) section backed by the same admitted-source list the Context Ledger
//! renders.
//!
//! Total occupancy comes from core's current token state. Category proportions are
//! estimated from the exact `Prompt` built for the latest provider attempt and
//! reconciled to that measured total. Every bar and percentage uses the model's full
//! context window as its denominator.

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

// Adjacent categories deliberately alternate light/dark luminance while retaining
// distinct hues and at least 4.5:1 contrast against the reference charcoal surface.
pub(super) const USER_MESSAGES_COLOR: Color = Color::Rgb(111, 181, 253);
pub(super) const AGENT_RESPONSES_COLOR: Color = Color::Rgb(3, 155, 44);
pub(super) const REASONING_COLOR: Color = Color::Rgb(3, 218, 229);
pub(super) const TOOL_CALLS_COLOR: Color = Color::Rgb(162, 129, 11);
pub(super) const TOOL_RESULTS_COLOR: Color = Color::Rgb(252, 178, 79);
pub(super) const SYSTEM_INSTRUCTIONS_COLOR: Color = Color::Rgb(240, 68, 93);
pub(super) const DEVELOPER_MESSAGES_COLOR: Color = Color::Rgb(239, 140, 255);
pub(super) const TOOL_DEFINITIONS_COLOR: Color = Color::Rgb(145, 145, 145);
pub(super) const UNRECOGNIZED_ITEMS_COLOR: Color = Color::Rgb(166, 252, 24);

#[derive(Clone, Debug)]
pub(super) struct CategoryUsage {
    pub(super) label: &'static str,
    pub(super) tokens: u64,
    pub(super) color: Color,
}

impl CategoryUsage {
    /// A shape identifier shared by `/context` and the persistent Ledger. Shapes
    /// keep categories distinguishable when a terminal theme or color vision
    /// makes two hues harder to tell apart.
    pub(super) fn marker(&self) -> &'static str {
        match self.color {
            USER_MESSAGES_COLOR => "●",
            AGENT_RESPONSES_COLOR => "◆",
            REASONING_COLOR => "▲",
            TOOL_CALLS_COLOR => "■",
            TOOL_RESULTS_COLOR => "⬟",
            SYSTEM_INSTRUCTIONS_COLOR => "✦",
            DEVELOPER_MESSAGES_COLOR => "✚",
            TOOL_DEFINITIONS_COLOR => "▣",
            UNRECOGNIZED_ITEMS_COLOR => "?",
            _ => "●",
        }
    }
}

#[derive(Clone, Debug)]
struct ContextUsageSnapshot {
    model: String,
    used_tokens: Option<u64>,
    window_tokens: u64,
    used_percent: Option<i64>,
    has_request_snapshot: bool,
    attributed_tokens: Option<u64>,
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
    has_request_snapshot: bool,
    categories: Vec<CategoryUsage>,
    used: u64,
    window: u64,
    after_chart: Vec<Line<'static>>,
}

impl ContextUsageHistoryCell {
    fn rendered_lines(&self, width: u16) -> Vec<Line<'static>> {
        let mut lines = self.before_chart.clone();
        if self.has_request_snapshot {
            lines.extend(build_category_bar_chart(
                &self.categories,
                self.used,
                self.window,
                width,
            ));
        } else {
            lines.push(" Context measurement unavailable.".dim().into());
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
            label: "Reasoning",
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
    debug_assert_eq!(
        categories
            .iter()
            .map(|category| category.tokens)
            .sum::<u64>(),
        attribution.estimated_total,
        "run-built categories must sum to the unpadded request estimate",
    );
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

fn dashboard_css_color(color: Color) -> String {
    match color {
        USER_MESSAGES_COLOR => "#6fb5fd",
        AGENT_RESPONSES_COLOR => "#039b2c",
        REASONING_COLOR => "#03dae5",
        TOOL_CALLS_COLOR => "#a2810b",
        TOOL_RESULTS_COLOR => "#fcb24f",
        SYSTEM_INSTRUCTIONS_COLOR => "#f0445d",
        DEVELOPER_MESSAGES_COLOR => "#ef8cff",
        TOOL_DEFINITIONS_COLOR => "#919191",
        UNRECOGNIZED_ITEMS_COLOR => "#a6fc18",
        _ => "#655f59",
    }
    .to_string()
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
        crate::terminal_hyperlinks::annotate_terminal_urls(self.rendered_lines(width))
    }

    fn transcript_hyperlink_lines(
        &self,
        width: u16,
    ) -> Vec<crate::terminal_hyperlinks::HyperlinkLine> {
        self.display_hyperlink_lines(width)
    }
}

fn strict_smart_prune_path(
    codex_home: &std::path::Path,
    audit_path: &str,
    leaf_kind: &str,
    append_manifest: bool,
) -> Option<std::path::PathBuf> {
    use std::path::Component;

    let relative = std::path::Path::new(audit_path);
    let mut components = relative.components();
    let valid = matches!(components.next(), Some(Component::Normal(part)) if part == "smart-prune")
        && matches!(components.next(), Some(Component::Normal(part)) if part == leaf_kind)
        && matches!(components.next(), Some(Component::Normal(leaf)) if !leaf.is_empty())
        && components.next().is_none();
    if !valid {
        return None;
    }
    let mut path = codex_home.join("logs").join(relative);
    if append_manifest {
        path.push("manifest.json");
    } else if path.extension().is_none_or(|extension| extension != "json") {
        return None;
    }
    path.is_file().then_some(path)
}

pub(super) fn smart_prune_attempt_evidence_path(
    codex_home: &std::path::Path,
    audit_path: &str,
) -> Option<std::path::PathBuf> {
    strict_smart_prune_path(codex_home, audit_path, "attempts", false)
}

fn smart_prune_admission_manifest_path(
    codex_home: &std::path::Path,
    audit_path: &str,
) -> Option<std::path::PathBuf> {
    strict_smart_prune_path(codex_home, audit_path, "admissions", true)
}

fn evidence_url_line(label: &'static str, path: &std::path::Path) -> Option<Line<'static>> {
    let destination = url::Url::from_file_path(path).ok()?.to_string();
    Some(Line::from(vec![
        Span::styled(
            format!("   {label} · "),
            Style::default().fg(Color::DarkGray),
        ),
        Span::styled(destination, Style::default().fg(Color::Cyan).underlined()),
    ]))
}

impl ChatWidget {
    pub(super) fn local_evidence_lines(
        &self,
        rollout_path: Option<&std::path::Path>,
    ) -> Vec<Line<'static>> {
        let mut evidence = Vec::new();
        if let Some(path) = rollout_path.filter(|path| path.is_file())
            && let Some(line) = evidence_url_line("Rollout", path)
        {
            evidence.push(line);
        }
        if let Some(path) = self
            .smart_prune
            .latest_attempt
            .as_ref()
            .and_then(|attempt| attempt.audit_path.as_deref())
            .and_then(|path| smart_prune_attempt_evidence_path(&self.config.codex_home, path))
            && let Some(line) = evidence_url_line("Smart Prune attempt", &path)
        {
            evidence.push(line);
        }
        if let Some(path) = self.smart_prune.latest.as_ref().and_then(|admission| {
            smart_prune_admission_manifest_path(
                &self.config.codex_home,
                admission.audit_path.as_str(),
            )
        }) && let Some(line) = evidence_url_line("Smart Prune admission", &path)
        {
            evidence.push(line);
        }
        if evidence.is_empty() {
            return evidence;
        }
        let mut lines = vec![
            Span::styled(
                " Local evidence · Ctrl+click to open",
                crate::style::brand_style(),
            )
            .into(),
        ];
        lines.extend(evidence);
        lines
    }

    pub(crate) fn set_context_usage_transcript_totals(
        &mut self,
        totals: ContextUsageTranscriptTotals,
    ) {
        self.context_usage_transcript_totals = totals;
    }

    #[cfg(test)]
    pub(crate) fn context_usage_transcript_totals_for_test(&self) -> ContextUsageTranscriptTotals {
        self.context_usage_transcript_totals
    }

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
            .unwrap_or(258_400)
            .max(1) as u64;
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
        let used_percent = used_tokens.map(|used| context_used_percent(used, window));
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
            attributed_tokens,
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
        let smart_prune_latest_attempt = self.smart_prune.latest_attempt.as_ref().map(|attempt| {
            crate::dashboard_server::DashboardSmartPruneAttempt {
                status: attempt.status.clone(),
                model: attempt.model_slug.clone(),
                reasoning_effort: attempt.reasoning_effort.clone(),
                candidate_outputs: attempt.candidate_outputs,
                admitted_outputs: attempt.admitted_outputs,
                approx_saved_tokens: attempt.approx_saved_tokens,
                latency_ms: attempt.latency_ms,
                usage: attempt.usage.as_ref().map(|usage| {
                    crate::dashboard_server::DashboardTokenTotals {
                        input: usage.input_tokens,
                        cached_input: usage.cached_input_tokens,
                        cache_write: usage.cache_write_tokens,
                        output: usage.output_tokens,
                        reasoning_output: usage.reasoning_output_tokens,
                        total: usage.total_tokens,
                    }
                }),
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
            latest_attempt: smart_prune_latest_attempt,
        };

        crate::dashboard_server::publish_state(
            crate::dashboard_server::DashboardContext {
                model: snapshot.model,
                used_tokens: snapshot.used_tokens,
                window_tokens: snapshot.window_tokens,
                used_percent: snapshot.used_percent,
                attributed_tokens: snapshot.attributed_tokens,
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
        let model = snapshot.model.clone();
        let before_chart = vec![
            Span::styled(
                " Context Usage · active context",
                crate::style::brand_style(),
            )
            .into(),
            format!(" {model} · one full-window scale").bold().into(),
            if snapshot.attributed_tokens.is_some() {
                " Measured total · estimated category attribution from the latest built request"
                    .dim()
                    .into()
            } else if snapshot.has_request_snapshot {
                " Measured total available · category attribution unavailable"
                    .dim()
                    .into()
            } else {
                " No request snapshot yet · send a provider request to measure context"
                    .dim()
                    .into()
            },
            Line::default(),
        ];

        let mut after_chart = vec![Line::default()];
        after_chart.push(Span::styled(" Smart Prune Audit", crate::style::brand_style()).into());
        if !self.smart_prune_synced {
            after_chart.push(
                "   status unavailable · syncing with current thread state"
                    .dim()
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
                after_chart.push("   optimizer usage unreported".dim().into());
            } else if self.smart_prune.optimizer_usage_reports > 0 {
                after_chart.push(
                    format!(
                        "   optimizer usage · ~{} tokens",
                        fmt_tokens(self.smart_prune.optimizer_usage.total_tokens.max(0) as u64)
                    )
                    .dim()
                    .into(),
                );
            }
        }
        after_chart.push(Line::default());

        after_chart
            .push(Span::styled(" History Rewrite Audit", crate::style::brand_style()).into());
        if self.last_prune_saved_tokens.is_none() {
            after_chart.push("   No history rewrites recorded this thread".dim().into());
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
                "   History rewrites replace completed tool-result history; category estimates exclude saved totals."
                    .dim()
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
        let evidence_lines = self.local_evidence_lines(snapshot.rollout_path.as_deref());
        if !evidence_lines.is_empty() {
            after_chart.push(Line::default());
            after_chart.extend(evidence_lines);
        }
        let cell = ContextUsageHistoryCell {
            before_chart,
            has_request_snapshot: snapshot.has_request_snapshot,
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
                "   Send the first provider request to establish an occupancy snapshot."
                    .dim()
                    .into(),
            );
        }
    }
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
            Style::default().fg(Color::DarkGray),
        ));
    } else {
        for (category, cells) in categories.iter().zip(counts) {
            if cells > 0 {
                bar.push(Span::styled(
                    "█".repeat(cells),
                    Style::default().fg(category.color),
                ));
            }
        }
    }
    if used_cells < bar_width {
        bar.push(Span::styled(
            "░".repeat(bar_width - used_cells),
            Style::default().fg(Color::DarkGray),
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

    for category in &categories {
        if narrow {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("   {} ", category.marker()),
                    Style::default().fg(category.color),
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
                    format!("   {} ", category.marker()),
                    Style::default().fg(category.color),
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
            .dim()
            .into()
    } else if narrow {
        "   Estimated segments · measured total.".dim().into()
    } else {
        "   Segment proportions are estimated from the latest built request; total width is measured active context."
            .dim()
            .into()
    });
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
    use crate::legacy_core::elpis_context::ContinuitySourceCategory;

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
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".to_string(),
            used_tokens: Some(210_000),
            window_tokens: 200_000,
            used_percent: Some(105),
            has_request_snapshot: true,
            attributed_tokens: Some(210_000),
            categories,
            saved_tokens: 0,
            sources: Vec::new(),
            backtrack_points: 0,
            native_compaction_count: 0,
            latest_native_compaction: None,
            rollout_path: None,
        };
        let dashboard = plain_text(render_dashboard_lines(&snapshot, 100));
        assert!(dashboard.contains("105.0% used · 0.0% free"), "{dashboard}");
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
    fn context_report_groups_manual_additions_as_user_files() {
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".to_string(),
            used_tokens: None,
            window_tokens: 200_000,
            used_percent: None,
            has_request_snapshot: false,
            attributed_tokens: None,
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

    fn rgb(color: Color) -> (u8, u8, u8) {
        match color {
            Color::Rgb(red, green, blue) => (red, green, blue),
            other => panic!("expected explicit RGB colour, got {other:?}"),
        }
    }

    fn colors_have_minimum_distance(colors: &[Color], minimum: f64) -> bool {
        colors.iter().enumerate().all(|(index, left)| {
            let (left_red, left_green, left_blue) = rgb(*left);
            colors.iter().skip(index + 1).all(|right| {
                let (right_red, right_green, right_blue) = rgb(*right);
                let red = f64::from(left_red) - f64::from(right_red);
                let green = f64::from(left_green) - f64::from(right_green);
                let blue = f64::from(left_blue) - f64::from(right_blue);
                red.hypot(green).hypot(blue) >= minimum
            })
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
        const MINIMUM_RGB_DISTANCE: f64 = 100.0;
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
            MINIMUM_RGB_DISTANCE
        ));
        assert!(
            terminal_colors
                .iter()
                .all(|color| contrast_ratio(*color, terminal_background) >= MINIMUM_CONTRAST)
        );
        for (index, pair) in terminal_colors.windows(2).enumerate() {
            let left = relative_luminance(pair[0]);
            let right = relative_luminance(pair[1]);
            assert!(
                if index % 2 == 0 {
                    left - right >= 0.10
                } else {
                    right - left >= 0.10
                },
                "category {index} and {} do not alternate light/dark: {left:.3} vs {right:.3}",
                index + 1,
            );
        }

        let near_duplicate = [Color::Rgb(95, 135, 255), Color::Rgb(96, 136, 255)];
        assert!(!colors_have_minimum_distance(
            &near_duplicate,
            MINIMUM_RGB_DISTANCE
        ));
        assert!(contrast_ratio(Color::Rgb(36, 36, 36), terminal_background) < MINIMUM_CONTRAST);
    }

    #[test]
    fn dashboard_preserves_category_hues() {
        assert_eq!(dashboard_css_color(USER_MESSAGES_COLOR), "#6fb5fd");
        assert_eq!(dashboard_css_color(AGENT_RESPONSES_COLOR), "#039b2c");
        assert_eq!(dashboard_css_color(REASONING_COLOR), "#03dae5");
        assert_eq!(dashboard_css_color(TOOL_CALLS_COLOR), "#a2810b");
        assert_eq!(dashboard_css_color(TOOL_RESULTS_COLOR), "#fcb24f");
        assert_eq!(dashboard_css_color(SYSTEM_INSTRUCTIONS_COLOR), "#f0445d");
        assert_eq!(dashboard_css_color(DEVELOPER_MESSAGES_COLOR), "#ef8cff");
        assert_eq!(dashboard_css_color(TOOL_DEFINITIONS_COLOR), "#919191");
        assert_eq!(dashboard_css_color(UNRECOGNIZED_ITEMS_COLOR), "#a6fc18");
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

    #[test]
    fn dashboard_lines_keep_measured_usage_and_source_provenance_together() {
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".to_string(),
            used_tokens: Some(42_000),
            window_tokens: 200_000,
            used_percent: Some(21),
            has_request_snapshot: true,
            attributed_tokens: Some(12_000),
            categories: vec![CategoryUsage {
                label: "Tool results",
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
Context Accounting · history savings excluded
  Context Window [█████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]
  42k/200k · 21.0% used
  ● Tool results               42k · 21.0% of context window
  Segment proportions are estimated from the latest built request; total width is measured active context.

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
Context Accounting · history savings excluded
  Context [██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]
  42k/200k · 21.0% used
  ● Tool results · 42k · 21.0% of window
  Estimated segments · measured total.

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
            attributed_tokens: Some(12_000),
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
            attributed_tokens: Some(12_000),
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
            attributed_tokens: None,
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
