use std::sync::OnceLock;
use std::sync::RwLock;

use codex_model_provider_info::WireApi;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;

pub(crate) const PRODUCT_NAME: &str = "Elpis";
pub(crate) const CODEX_RUNTIME_TITLE: &str = "Elpis";

const STATUS_SEPARATOR: &str = " · ";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderRoute {
    Native,
    Compatibility,
}

impl ProviderRoute {
    pub(crate) fn long_label(self) -> &'static str {
        match self {
            Self::Native => "direct provider connection",
            Self::Compatibility => "OpenAI-compatible Responses route",
        }
    }

    pub(crate) fn for_provider(
        provider_id: &str,
        provider_name: &str,
        wire_api: WireApi,
        custom_openai_base_url: bool,
    ) -> Self {
        match wire_api {
            WireApi::AnthropicMessages | WireApi::GeminiGenerateContent | WireApi::Chat => {
                Self::Native
            }
            WireApi::Responses => {
                let is_openai = provider_id.trim().eq_ignore_ascii_case("openai")
                    || provider_name.trim().eq_ignore_ascii_case("openai");
                if is_openai && !custom_openai_base_url {
                    Self::Native
                } else {
                    Self::Compatibility
                }
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct EvictionNotice {
    pub(crate) count: u64,
    pub(crate) reason: String,
    pub(crate) evidence: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RuntimeIdentity {
    thread_id: Option<String>,
    provider: String,
    route: ProviderRoute,
    model: String,
    context_used_percent: Option<i64>,
    durable_memory_enabled: bool,
    memory_citations: usize,
    eviction_count: u64,
    latest_eviction: Option<EvictionNotice>,
    latest_continuity: Option<String>,
    resume_announced: bool,
    snapshot_restore_announced: bool,
}

impl Default for RuntimeIdentity {
    fn default() -> Self {
        Self {
            thread_id: None,
            provider: "starting".to_string(),
            route: ProviderRoute::Native,
            model: "starting".to_string(),
            context_used_percent: None,
            durable_memory_enabled: false,
            memory_citations: 0,
            eviction_count: 0,
            latest_eviction: None,
            latest_continuity: None,
            resume_announced: false,
            snapshot_restore_announced: false,
        }
    }
}

static RUNTIME_IDENTITY: OnceLock<RwLock<RuntimeIdentity>> = OnceLock::new();

fn runtime_identity() -> &'static RwLock<RuntimeIdentity> {
    RUNTIME_IDENTITY.get_or_init(|| RwLock::new(RuntimeIdentity::default()))
}

fn read_runtime_identity() -> RuntimeIdentity {
    runtime_identity()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn mutate_runtime_identity<T>(f: impl FnOnce(&mut RuntimeIdentity) -> T) -> T {
    let mut state = runtime_identity()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut state)
}

pub(crate) fn sync_runtime_identity(
    thread_id: Option<&str>,
    provider: &str,
    route: ProviderRoute,
    model: &str,
    durable_memory_enabled: bool,
) -> bool {
    mutate_runtime_identity(|state| {
        let provider = normalized_value(provider, "configured");
        let model = normalized_value(model, "starting");
        let changed = state.thread_id.as_deref() != thread_id
            || state.provider != provider
            || state.route != route
            || state.model != model
            || state.durable_memory_enabled != durable_memory_enabled;
        if state.thread_id.as_deref() != thread_id {
            *state = RuntimeIdentity {
                thread_id: thread_id.map(ToOwned::to_owned),
                ..RuntimeIdentity::default()
            };
        }
        state.provider = provider;
        state.route = route;
        state.model = model;
        state.durable_memory_enabled = durable_memory_enabled;
        changed
    })
}

pub(crate) fn record_context_usage(last_total_tokens: i64, context_window: Option<i64>) {
    mutate_runtime_identity(|state| {
        state.context_used_percent = context_window
            .filter(|window| *window > 0)
            .map(|window| ((last_total_tokens.max(0) * 100) / window).clamp(0, 100));
    });
}

pub(crate) fn record_memory_citation(entry_count: usize) {
    mutate_runtime_identity(|state| {
        state.memory_citations = state.memory_citations.saturating_add(entry_count);
        state.durable_memory_enabled = true;
        state.latest_continuity = Some("memory recalled".to_string());
    });
}

pub(crate) fn record_compaction(thread_id: &str, turn_id: &str) -> EvictionNotice {
    mutate_runtime_identity(|state| {
        state.eviction_count = state.eviction_count.saturating_add(1);
        let notice = EvictionNotice {
            count: state.eviction_count,
            reason: "context compaction".to_string(),
            evidence: format!("thread:{thread_id}/turn:{turn_id}"),
        };
        state.latest_eviction = Some(notice.clone());
        state.latest_continuity = Some("context compacted".to_string());
        notice
    })
}

pub(crate) fn record_model_reroute(from_model: &str, to_model: &str) {
    mutate_runtime_identity(|state| {
        state.model = normalized_value(to_model, "starting");
        state.latest_continuity = Some(format!("model rerouted {from_model} → {to_model}"));
    });
}

pub(crate) fn record_provider_switch(provider: &str, model: &str) {
    mutate_runtime_identity(|state| {
        state.provider = normalized_value(provider, "configured");
        state.model = normalized_value(model, "starting");
        state.latest_continuity = Some("provider switched".to_string());
    });
}

pub(crate) fn mark_resume_announced() -> bool {
    mutate_runtime_identity(|state| {
        if state.resume_announced {
            false
        } else {
            state.resume_announced = true;
            state.latest_continuity = Some("session resumed".to_string());
            true
        }
    })
}

pub(crate) fn mark_snapshot_restore_announced() -> bool {
    mutate_runtime_identity(|state| {
        if state.snapshot_restore_announced {
            false
        } else {
            state.snapshot_restore_announced = true;
            state.latest_continuity = Some("context restored".to_string());
            true
        }
    })
}

pub(crate) fn decorate_status_line(
    tail: Option<Line<'static>>,
    model_hint: Option<&str>,
) -> Line<'static> {
    let state = read_runtime_identity();
    let mut spans = identity_spans(&state, model_hint);
    if let Some(tail) = tail.filter(|line| !line.spans.is_empty()) {
        spans.push(STATUS_SEPARATOR.dim());
        spans.extend(tail.spans);
    }
    Line::from(spans)
}

fn identity_spans(state: &RuntimeIdentity, model_hint: Option<&str>) -> Vec<Span<'static>> {
    let model = if state.model == "starting" {
        model_hint.unwrap_or(state.model.as_str())
    } else {
        state.model.as_str()
    };
    let context = state
        .context_used_percent
        .map_or_else(|| "admitted".to_string(), |used| format!("{used}%"));
    let mut spans = vec![Span::styled("ELPIS", crate::style::brand_style())];
    push_field(
        &mut spans,
        "provider",
        &state.provider,
        crate::style::status_symbol_style(),
    );
    push_field(
        &mut spans,
        "model",
        model,
        crate::style::status_symbol_style(),
    );
    push_field(
        &mut spans,
        "context",
        &context,
        crate::style::status_symbol_style(),
    );
    if let Some(latest) = state.latest_eviction.as_ref() {
        push_field(
            &mut spans,
            "evidence",
            &latest.evidence,
            crate::style::status_symbol_style(),
        );
    }
    if let Some(continuity) = state.latest_continuity.as_deref() {
        push_field(
            &mut spans,
            "flow",
            continuity,
            crate::style::status_symbol_style(),
        );
    }
    spans
}

fn push_field(spans: &mut Vec<Span<'static>>, label: &str, value: &str, label_style: Style) {
    if !spans.is_empty() {
        spans.push(STATUS_SEPARATOR.dim());
    }
    spans.push(Span::styled(format!("{label} "), label_style));
    spans.push(Span::raw(value.to_string()));
}

fn normalized_value(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_text(line: &Line<'static>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>()
    }

    #[test]
    fn identity_line_front_loads_runtime_fields_for_narrow_terminals() {
        let state = RuntimeIdentity {
            provider: "OpenAI".to_string(),
            route: ProviderRoute::Native,
            model: "gpt-5.6".to_string(),
            context_used_percent: Some(41),
            durable_memory_enabled: true,
            memory_citations: 6,
            eviction_count: 2,
            latest_eviction: Some(EvictionNotice {
                count: 2,
                reason: "context compaction".to_string(),
                evidence: "thread:t/turn:u".to_string(),
            }),
            ..RuntimeIdentity::default()
        };

        let text = line_text(&Line::from(identity_spans(&state, None)));
        assert_eq!(
            text,
            "ELPIS · provider OpenAI · model gpt-5.6 · context 41% · evidence thread:t/turn:u"
        );
        assert!(text.starts_with("ELPIS · provider"));
    }

    #[test]
    fn compaction_state_keeps_reason_and_evidence_pointer() {
        let mut state = RuntimeIdentity::default();
        state.eviction_count += 1;
        let notice = EvictionNotice {
            count: state.eviction_count,
            reason: "context compaction".to_string(),
            evidence: "thread:abc/turn:def".to_string(),
        };
        state.latest_eviction = Some(notice.clone());

        assert_eq!(notice.count, 1);
        assert_eq!(notice.reason, "context compaction");
        assert_eq!(notice.evidence, "thread:abc/turn:def");
        assert_eq!(state.latest_eviction, Some(notice));
    }

    #[test]
    fn provider_routes_are_explicit() {
        assert_eq!(
            ProviderRoute::Native.long_label(),
            "direct provider connection"
        );
        assert_eq!(
            ProviderRoute::Compatibility.long_label(),
            "OpenAI-compatible Responses route"
        );
        assert_eq!(
            ProviderRoute::for_provider(
                "anthropic",
                "Anthropic Claude (native)",
                WireApi::AnthropicMessages,
                false,
            ),
            ProviderRoute::Native
        );
        assert_eq!(
            ProviderRoute::for_provider(
                "google-gemini",
                "Google Gemini (native)",
                WireApi::GeminiGenerateContent,
                false,
            ),
            ProviderRoute::Native
        );
        assert_eq!(
            ProviderRoute::for_provider("openrouter", "OpenRouter", WireApi::Responses, false,),
            ProviderRoute::Compatibility
        );
    }
}
