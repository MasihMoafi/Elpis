//! Elpis: the ChatWidget side of `/dashboard` — the Context Ledger's CONTEXT WINDOW shares,
//! the Activity tab, the state the local page reads, and the local evidence links that
//! `/context`, `/usage` and the Ledger show.
//!
//! Copied from v0.3.0 `chatwidget.rs`, `chatwidget/protocol.rs` and `chatwidget/context_usage.rs`.
//! Upstream files reach this module through one-line seams marked `Elpis:`.
//!
//! The page's state is refreshed only after `/dashboard` has been opened in this chat, so a
//! session that never opens it does no dashboard work.

use codex_app_server_protocol::ThreadContextAttribution;
use codex_app_server_protocol::TurnActivityUpdatedNotification;
use codex_app_server_protocol::TurnCostUpdatedNotification;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use std::path::Path;
use std::path::PathBuf;

use super::ChatWidget;
use super::context_ledger::LedgerSourceGroup;
use super::context_usage;
use crate::activity_state::ActivityState;
use crate::activity_state::DashboardActivityState;
use crate::app_event::AppEvent;
use crate::dashboard_server::DashboardCategory;
use crate::dashboard_server::DashboardContext;
use crate::dashboard_server::DashboardLimit;
use crate::dashboard_server::DashboardModelChoice;
use crate::dashboard_server::DashboardModels;
use crate::dashboard_server::DashboardSmartPrune;
use crate::dashboard_server::DashboardSmartPruneAttempt;
use crate::dashboard_server::DashboardSmartPruneLatest;
use crate::dashboard_server::DashboardSource;
use crate::dashboard_server::DashboardTokenTotals;
use crate::dashboard_server::DashboardTokens;
use crate::elpis_app_event::ElpisAppEvent;
use crate::elpis_ledger_events::ContextUsageTranscriptTotals;
use crate::legacy_core::elpis_context::ContinuitySource;

/// Chat models with this prefix are Claude subscription models served by the Claude bridge
/// (`tools/elpis-claude/acp-bridge.mjs`), not by the configured provider.
const CLAUDE_MODEL_PREFIX: &str = "claude/";
/// The provider name shown for a Claude subscription model.
const CLAUDE_SUBSCRIPTION_PROVIDER: &str = "Claude subscription";

/// What the ChatWidget keeps for the dashboard.
#[derive(Debug, Default)]
pub(crate) struct DashboardWidgetState {
    activity: ActivityState,
    /// Set once `/dashboard` runs; until then nothing is published.
    opened: bool,
}

impl ChatWidget {
    /// Keep the latest request's category shares. An update that carries none (a replay, or a
    /// request built before this process started) keeps the last known shares.
    pub(super) fn apply_context_attribution(
        &mut self,
        attribution: Option<ThreadContextAttribution>,
    ) {
        if let Some(attribution) = attribution {
            self.context_attribution = Some(attribution);
        }
    }

    pub(super) fn on_turn_started_activity(&mut self, turn_id: String, started_at: Option<i64>) {
        if self.dashboard.activity.start(turn_id, started_at) {
            self.request_dashboard_refresh();
        }
    }

    pub(super) fn on_turn_activity_updated(
        &mut self,
        notification: TurnActivityUpdatedNotification,
    ) {
        if self.dashboard.activity.finish(
            &notification.turn_id,
            notification.status,
            notification.duration_ms,
            notification.time_to_first_token_ms,
        ) {
            self.request_dashboard_refresh();
        }
    }

    pub(super) fn on_turn_cost_updated(&mut self, notification: TurnCostUpdatedNotification) {
        if self
            .dashboard
            .activity
            .update_cost(&notification.turn_id, notification.cost)
        {
            self.request_dashboard_refresh();
        }
    }

    /// A different thread starts with no activity rows.
    pub(super) fn reset_dashboard_for_thread_change(&mut self) {
        if self.dashboard.activity.reset() {
            self.request_dashboard_refresh();
        }
    }

    pub(crate) fn dashboard_activity_state(&self) -> DashboardActivityState {
        self.dashboard.activity.project()
    }

    /// `/dashboard`: the App publishes the current state, starts the loopback server and opens
    /// the page.
    pub(super) fn open_dashboard(&mut self) {
        self.dashboard.opened = true;
        self.app_event_tx
            .send(AppEvent::Elpis(ElpisAppEvent::OpenDashboard));
    }

    /// Ask the App to republish the page's state, once `/dashboard` has been opened.
    pub(super) fn request_dashboard_refresh(&self) {
        if self.dashboard.opened {
            self.app_event_tx
                .send(AppEvent::Elpis(ElpisAppEvent::RefreshDashboard));
        }
    }

    /// Publishes the page's state. Cheap: the numbers `/context` already computes, merged only
    /// when a fact changed. Sizes and counts only; no message content and no absolute paths.
    pub(crate) fn publish_dashboard_snapshot(&self, totals: &ContextUsageTranscriptTotals) {
        let snapshot = self.context_usage_snapshot(totals);
        let categories = snapshot.has_request_snapshot.then(|| {
            snapshot
                .categories
                .iter()
                .map(|category| DashboardCategory {
                    label: category.label.to_string(),
                    tokens: category.tokens,
                    color: dashboard_css_color(category.color),
                })
                .collect()
        });
        let used_percent = snapshot
            .used_tokens
            .zip(snapshot.window_tokens)
            .map(|(used, window)| context_usage::context_used_percent(used, window));
        let sources = self
            .continuity_sources()
            .iter()
            .map(dashboard_source_projection)
            .collect();
        let to_totals = |usage: &crate::token_usage::TokenUsage| DashboardTokenTotals {
            input: usage.input_tokens,
            cached_input: usage.cached_input_tokens,
            // The TUI's token usage does not keep cache writes, so they stay unreported.
            cache_write: None,
            output: usage.output_tokens,
            reasoning_output: usage.reasoning_output_tokens,
            total: usage.total_tokens,
        };
        let tokens = DashboardTokens {
            session_total: self
                .token_info
                .as_ref()
                .map(|info| to_totals(&info.total_token_usage)),
            last_turn: self
                .token_info
                .as_ref()
                .map(|info| to_totals(&info.last_token_usage)),
        };
        crate::dashboard_server::publish_evidence(
            self.config.codex_home.as_path(),
            self.local_evidence_paths(),
        );
        crate::dashboard_server::publish_state(
            DashboardContext {
                model: snapshot.model,
                used_tokens: snapshot.used_tokens,
                window_tokens: snapshot.window_tokens,
                used_percent,
                attributed_tokens: snapshot.attributed_tokens,
                categories,
                saved_tokens: snapshot.saved_tokens,
                sources,
                backtrack_points: snapshot.backtrack_points,
                models: self.dashboard_models(),
            },
            tokens,
            self.dashboard_activity_state(),
            self.dashboard_smart_prune(),
            self.dashboard_limits(),
        );
    }

    /// The provider a person sees for the chat model. A Claude subscription model is served by
    /// the Claude bridge, so it shows as such; `config.model_provider_id` stays the configured
    /// provider because `/model` and the key checks read it.
    pub(crate) fn displayed_chat_provider(&self) -> &str {
        if self.current_model().starts_with(CLAUDE_MODEL_PREFIX) {
            CLAUDE_SUBSCRIPTION_PROVIDER
        } else {
            self.config.model_provider_id.as_str()
        }
    }

    /// The usage limits `/usage` shows, one row per window: label, percent used and reset time.
    pub(crate) fn dashboard_limits(&self) -> Vec<DashboardLimit> {
        self.rate_limit_snapshots_by_limit_id
            .values()
            .flat_map(|snapshot| {
                [
                    (snapshot.primary.as_ref(), /*is_secondary*/ false),
                    (snapshot.secondary.as_ref(), /*is_secondary*/ true),
                ]
                .into_iter()
                .filter_map(move |(window, is_secondary)| {
                    let window = window?;
                    let duration = super::rate_limits::limit_label_for_window(
                        window.window_minutes,
                        is_secondary,
                    );
                    Some(DashboardLimit {
                        label: format!("{} {duration}", snapshot.limit_name),
                        used_percent: window.used_percent.round() as i64,
                        resets_at: window.resets_at.clone(),
                    })
                })
            })
            .collect()
    }

    /// The models the Models tab shows: the chat model, the background model and the Smart
    /// Prune model, each with the provider that serves it. `None` is the built-in default.
    pub(crate) fn dashboard_models(&self) -> DashboardModels {
        let session_provider = &self.config.model_provider_id;
        let pruner = crate::legacy_core::pruner_settings::PrunerSettings::load(
            self.config.codex_home.as_path(),
        )
        .unwrap_or_default();
        DashboardModels {
            chat: DashboardModelChoice {
                provider: Some(self.displayed_chat_provider().to_string()),
                model: Some(self.current_model().to_string()),
            },
            background: DashboardModelChoice {
                provider: self.config.background_model.as_ref().map(|_| {
                    self.config
                        .background_provider
                        .clone()
                        .unwrap_or_else(|| session_provider.clone())
                }),
                model: self.config.background_model.clone(),
            },
            pruner: DashboardModelChoice {
                provider: pruner.model.as_ref().map(|_| {
                    pruner
                        .provider
                        .clone()
                        .unwrap_or_else(|| self.pruner_role_provider().to_string())
                }),
                model: pruner.model,
            },
        }
    }

    /// Local files the dashboard server opens as readable reports: the thread's rollout and,
    /// once Smart Prune reports them, its latest attempt, admission and optimizer conversation.
    fn local_evidence_paths(&self) -> Vec<(&'static str, PathBuf)> {
        let codex_home = self.config.codex_home.as_path();
        let mut paths = Vec::new();
        if let Some(path) = self.rollout_path().filter(|path| path.is_file()) {
            paths.push(("Rollout", path));
        }
        if let Some(path) = self
            .smart_prune
            .latest_attempt
            .as_ref()
            .and_then(|attempt| attempt.audit_path.as_deref())
            .and_then(|path| smart_prune_attempt_evidence_path(codex_home, path))
        {
            paths.push(("Smart Prune attempt", path));
        }
        if let Some(path) = self.smart_prune.latest.as_ref().and_then(|admission| {
            smart_prune_admission_manifest_path(codex_home, admission.audit_path.as_str())
        }) {
            let ace = path.with_file_name("ace.json");
            paths.push(("Smart Prune admission", path));
            if ace.is_file() {
                paths.push(("Optimizer conversation", ace));
            }
        }
        paths
    }

    /// The "Local evidence" block `/context` and `/usage` end with. Each link opens a readable
    /// report served on the loopback address; empty when there is nothing to read.
    pub(super) fn local_evidence_lines(&self) -> Vec<Line<'static>> {
        let codex_home = self.config.codex_home.as_path();
        let evidence: Vec<_> = self
            .local_evidence_paths()
            .iter()
            .filter_map(|(label, path)| evidence_url_line(label, codex_home, path))
            .collect();
        if evidence.is_empty() {
            return Vec::new();
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

    /// The Smart Prune tab's facts. Nothing reports Smart Prune state in this build, so the tab
    /// reads off rather than syncing forever, as the Ledger's switch does.
    fn dashboard_smart_prune(&self) -> DashboardSmartPrune {
        let prune = &self.smart_prune;
        let breakdown =
            |usage: &codex_app_server_protocol::TokenUsageBreakdown| DashboardTokenTotals {
                input: usage.input_tokens,
                cached_input: usage.cached_input_tokens,
                cache_write: Some(usage.cache_write_input_tokens),
                output: usage.output_tokens,
                reasoning_output: usage.reasoning_output_tokens,
                total: usage.total_tokens,
            };
        DashboardSmartPrune {
            configured_enabled: false,
            current_thread_next_turn_enabled: Some(self.smart_prune_synced && prune.enabled),
            examined_outputs: prune.examined_outputs,
            admitted_outputs: prune.admitted_outputs,
            unchanged_outputs: prune.unchanged_outputs,
            failed_batches: prune.failed_batches,
            approx_source_tokens: prune.approx_source_tokens,
            approx_admitted_tokens: prune.approx_admitted_tokens,
            approx_saved_tokens: prune.approx_saved_tokens,
            optimizer_requests: prune.optimizer_requests,
            optimizer_usage_reports: prune.optimizer_usage_reports,
            optimizer_usage: breakdown(&prune.optimizer_usage),
            optimizer_latency_ms: prune.optimizer_latency_ms,
            latest: prune
                .latest
                .as_ref()
                .map(|latest| DashboardSmartPruneLatest {
                    examined_outputs: latest.examined_outputs,
                    admitted_outputs: latest.admitted_outputs,
                    approx_source_tokens: latest.approx_source_tokens,
                    approx_admitted_tokens: latest.approx_admitted_tokens,
                    approx_saved_tokens: latest.approx_saved_tokens,
                    request_linkage_verified: latest.request_linkage_verified,
                    response_usage: latest.response_usage.as_ref().map(breakdown),
                    response_linkage_verified: latest.response_linkage_verified,
                }),
            latest_attempt: prune.latest_attempt.as_ref().map(|attempt| {
                DashboardSmartPruneAttempt {
                    status: attempt.status.clone(),
                    model: attempt.model_slug.clone(),
                    reasoning_effort: attempt.reasoning_effort.clone(),
                    candidate_outputs: attempt.candidate_outputs,
                    admitted_outputs: attempt.admitted_outputs,
                    approx_saved_tokens: attempt.approx_saved_tokens,
                    latency_ms: attempt.latency_ms,
                    usage: attempt.usage.as_ref().map(breakdown),
                }
            }),
        }
    }
}

/// One evidence link: the label, then the report's loopback address.
fn evidence_url_line(label: &'static str, root: &Path, path: &Path) -> Option<Line<'static>> {
    let destination = crate::dashboard_server::evidence_url(root, label, path)?;
    Some(Line::from(vec![
        Span::styled(format!("   {label} · "), Style::default().fg(Color::Reset)),
        Span::styled(
            destination,
            crate::style::brand_style().not_bold().underlined(),
        ),
    ]))
}

/// A Smart Prune audit record under `<home>/logs/smart-prune/<kind>/<leaf>`, and nothing else.
fn strict_smart_prune_path(
    codex_home: &Path,
    audit_path: &str,
    leaf_kind: &str,
    append_manifest: bool,
) -> Option<PathBuf> {
    use std::path::Component;

    let relative = Path::new(audit_path);
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
    codex_home: &Path,
    audit_path: &str,
) -> Option<PathBuf> {
    strict_smart_prune_path(
        codex_home, audit_path, "attempts", /*append_manifest*/ false,
    )
}

fn smart_prune_admission_manifest_path(codex_home: &Path, audit_path: &str) -> Option<PathBuf> {
    strict_smart_prune_path(
        codex_home,
        audit_path,
        "admissions",
        /*append_manifest*/ true,
    )
}

/// A Ledger source as the page shows it: a file name, never the absolute path it was added with.
fn dashboard_source_projection(source: &ContinuitySource) -> DashboardSource {
    let name = if source.origin == "manual addition" {
        source.path.file_name()
    } else {
        std::path::Path::new(&source.name).file_name()
    }
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| "Custom source".to_string());
    DashboardSource {
        name,
        category: LedgerSourceGroup::for_source(source)
            .display_name()
            .to_ascii_lowercase(),
        estimated_tokens: source.estimated_tokens,
        admitted: source.admitted,
    }
}

/// The page's palette for each category. Reasoning uses the page's cyan; v0.3.0 sent the
/// terminal's cream, which the page drew as gray, like tool definitions.
fn dashboard_css_color(color: Color) -> String {
    match color {
        context_usage::USER_MESSAGES_COLOR => "#6fb5fd",
        context_usage::AGENT_RESPONSES_COLOR => "#039b2c",
        context_usage::REASONING_COLOR => "#03dae5",
        context_usage::TOOL_CALLS_COLOR => "#a2810b",
        context_usage::TOOL_RESULTS_COLOR => "#fcb24f",
        context_usage::SYSTEM_INSTRUCTIONS_COLOR => "#f0445d",
        context_usage::DEVELOPER_MESSAGES_COLOR => "#ef8cff",
        context_usage::TOOL_DEFINITIONS_COLOR => "#919191",
        context_usage::UNRECOGNIZED_ITEMS_COLOR => "#a6fc18",
        _ => "#655f59",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy_core::elpis_context::ContinuitySourceCategory;
    use pretty_assertions::assert_eq;

    fn source(name: &str, path: &str, origin: &'static str) -> ContinuitySource {
        ContinuitySource {
            name: name.to_string(),
            path: std::path::PathBuf::from(path),
            bytes: 128,
            estimated_tokens: 32,
            category: ContinuitySourceCategory::Files,
            origin,
            lifetime: "every turn",
            reason: "test source",
            admitted: true,
            selectable: true,
        }
    }

    #[test]
    fn a_manually_added_source_reaches_the_page_by_file_name_only() {
        let absolute_path = "/home/private-user/context/secret-plan.md";
        let projected =
            dashboard_source_projection(&source(absolute_path, absolute_path, "manual addition"));
        let serialized = serde_json::to_string(&projected).expect("serialize dashboard source");

        assert_eq!(projected.name, "secret-plan.md");
        assert_eq!(projected.category, "user files");
        assert!(!serialized.contains("/home/private-user"), "{serialized}");
    }

    #[test]
    fn an_elpis_loaded_source_stays_session_continuity() {
        let projected = dashboard_source_projection(&source(
            "GOAL.md",
            "/workspace/GOAL.md",
            "Elpis workspace state",
        ));
        assert_eq!(projected.name, "GOAL.md");
        assert_eq!(projected.category, "session continuity");
    }

    #[test]
    fn evidence_links_open_readable_http_reports() {
        let dir = tempfile::tempdir().expect("temp home");
        let path = dir.path().join("attempt.json");
        std::fs::write(
            &path,
            r#"{"status":"admitted","input":"EVIDENCE_ACCESS_MARKER"}"#,
        )
        .expect("write evidence");

        let line = evidence_url_line("Smart Prune attempt", dir.path(), &path)
            .expect("a file under the home gets a link");
        assert_eq!(line.spans[0].style.fg, Some(Color::Reset));
        let text = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(text.contains("http://127.0.0.1:"), "{text}");
        assert!(!text.contains("file://"), "{text}");

        // A file outside the home is never served.
        let elsewhere = tempfile::tempdir().expect("second temp dir");
        let foreign = elsewhere.path().join("secret.json");
        std::fs::write(&foreign, "{}").expect("write foreign file");
        assert!(evidence_url_line("Foreign", dir.path(), &foreign).is_none());
    }

    #[test]
    fn only_smart_prune_audit_records_become_evidence() {
        let home = tempfile::tempdir().expect("temp home");
        let attempts = home.path().join("logs/smart-prune/attempts");
        std::fs::create_dir_all(&attempts).expect("attempts dir");
        std::fs::write(attempts.join("a1.json"), "{}").expect("attempt record");
        std::fs::write(home.path().join("config.toml"), "").expect("config");

        assert_eq!(
            smart_prune_attempt_evidence_path(home.path(), "smart-prune/attempts/a1.json"),
            Some(attempts.join("a1.json"))
        );
        for escaping in [
            "../config.toml",
            "smart-prune/attempts/../../../config.toml",
            "smart-prune/admissions/a1.json",
            "/etc/passwd",
        ] {
            assert_eq!(
                smart_prune_attempt_evidence_path(home.path(), escaping),
                None,
                "{escaping}"
            );
        }
    }

    #[test]
    fn every_category_has_its_own_page_color() {
        let colors = [
            context_usage::USER_MESSAGES_COLOR,
            context_usage::AGENT_RESPONSES_COLOR,
            context_usage::REASONING_COLOR,
            context_usage::TOOL_CALLS_COLOR,
            context_usage::TOOL_RESULTS_COLOR,
            context_usage::SYSTEM_INSTRUCTIONS_COLOR,
            context_usage::DEVELOPER_MESSAGES_COLOR,
            context_usage::TOOL_DEFINITIONS_COLOR,
            context_usage::UNRECOGNIZED_ITEMS_COLOR,
        ]
        .map(dashboard_css_color);
        let page_js = include_str!("../dashboard_assets/dashboard.js");
        for (index, color) in colors.iter().enumerate() {
            assert!(
                page_js.contains(color.as_str()),
                "{color} has no page class"
            );
            assert!(
                !colors[index + 1..].contains(color),
                "{color} is used by two categories"
            );
        }
    }
}
