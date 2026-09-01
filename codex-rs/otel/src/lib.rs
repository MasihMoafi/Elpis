pub(crate) mod config;
mod events;
pub(crate) mod metrics;
pub(crate) mod provider;
pub(crate) mod trace_context;

mod otlp;
mod targets;

use crate::metrics::Result as MetricsResult;
use codex_protocol::auth::AuthMode;
use serde::Serialize;
use strum_macros::Display;

pub use crate::config::OtelExporter;
pub use crate::config::OtelHttpProtocol;
pub use crate::config::OtelSettings;
pub use crate::config::OtelTlsConfig;
pub use crate::config::StatsigMetricsSettings;
pub use crate::config::validate_span_attributes;
pub use crate::events::session_telemetry::AuthEnvTelemetryMetadata;
pub use crate::events::session_telemetry::SessionTelemetry;
pub use crate::events::session_telemetry::SessionTelemetryMetadata;
pub use crate::metrics::runtime_metrics::RuntimeMetricTotals;
pub use crate::metrics::runtime_metrics::RuntimeMetricsSummary;
pub use crate::metrics::timer::Timer;
pub use crate::metrics::*;
pub use crate::provider::OtelProvider;
pub use crate::trace_context::context_from_w3c_trace_context;
pub use crate::trace_context::current_span_trace_id;
pub use crate::trace_context::current_span_w3c_trace_context;
pub use crate::trace_context::inject_span_w3c_trace_headers;
pub use crate::trace_context::set_parent_from_context;
pub use crate::trace_context::set_parent_from_w3c_trace_context;
pub use crate::trace_context::span_w3c_trace_context;
pub use crate::trace_context::traceparent_context_from_env;
pub use crate::trace_context::validate_tracestate_entries;
pub use crate::trace_context::validate_tracestate_member;
pub use codex_utils_string::sanitize_metric_tag_value;

#[derive(Debug, Clone, Serialize, Display)]
#[serde(rename_all = "snake_case")]
pub enum ToolDecisionSource {
    AutomatedReviewer,
    Config,
    User,
}

/// Coarsens the authentication domain into the dimensions used by telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Display)]
pub enum TelemetryAuthMode {
    ApiKey,
    Chatgpt,
}

impl From<AuthMode> for TelemetryAuthMode {
    fn from(mode: AuthMode) -> Self {
        match mode {
            AuthMode::ApiKey | AuthMode::BedrockApiKey => Self::ApiKey,
            AuthMode::Chatgpt
            | AuthMode::ChatgptAuthTokens
            | AuthMode::Headers
            | AuthMode::AgentIdentity
            | AuthMode::PersonalAccessToken => Self::Chatgpt,
        }
    }
}

/// Parses an unsigned ASCII decimal USD amount and rounds it to micro-USD.
pub fn parse_turn_cost_microusd(value: &str) -> Option<i64> {
    let (dollars, fractional) = match value.split_once('.') {
        Some((dollars, fractional)) if !fractional.is_empty() && !fractional.contains('.') => {
            (dollars, fractional)
        }
        Some(_) => return None,
        None => (value, ""),
    };
    if dollars.is_empty()
        || !dollars.as_bytes().iter().all(u8::is_ascii_digit)
        || !fractional.as_bytes().iter().all(u8::is_ascii_digit)
    {
        return None;
    }

    let fractional = fractional.as_bytes();
    let fractional_precision = 6_usize;
    let fractional_microusd = fractional
        .iter()
        .take(fractional_precision)
        .fold(0_u64, |value, digit| value * 10 + u64::from(digit - b'0'))
        * 10_u64.pow(fractional_precision.saturating_sub(fractional.len()) as u32);
    let round_up = fractional
        .get(fractional_precision)
        .is_some_and(|digit| *digit >= b'5');
    let microusd = dollars
        .parse::<u64>()
        .ok()?
        .checked_mul(1_000_000)?
        .checked_add(fractional_microusd)?
        .checked_add(u64::from(round_up))?;
    i64::try_from(microusd).ok()
}

/// Start a metrics timer using the globally installed metrics client.
pub fn start_global_timer(name: &str, tags: &[(&str, &str)]) -> MetricsResult<Timer> {
    let Some(metrics) = crate::metrics::global() else {
        return Err(MetricsError::ExporterDisabled);
    };
    metrics.start_timer(name, tags)
}

/// Returns the resolved Statsig metrics settings for the globally installed
/// OTEL metrics client, if the active metrics exporter is Statsig.
pub fn global_statsig_metrics_settings() -> Option<StatsigMetricsSettings> {
    crate::metrics::global_statsig_settings()
}

#[cfg(test)]
mod tests {
    use super::parse_turn_cost_microusd;

    #[test]
    fn turn_cost_decimal_parser_rounds_seventh_digit_and_rejects_invalid() {
        for (value, expected) in [
            ("0", 0),
            ("0.000001", 1),
            ("1.250000", 1_250_000),
            ("0.0001245", 125),
        ] {
            assert_eq!(parse_turn_cost_microusd(value), Some(expected), "{value}");
        }

        for value in [
            "-1",
            "+1",
            " 1",
            "1 ",
            "1e-6",
            "",
            ".1",
            "1.",
            "1.2.3",
            "one",
            "9223372036854.7758075",
        ] {
            assert_eq!(parse_turn_cost_microusd(value), None, "{value:?}");
        }
    }
}
