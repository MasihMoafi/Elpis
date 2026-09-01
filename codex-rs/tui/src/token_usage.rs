// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! TUI token usage models and display formatting.

use std::fmt;

use codex_protocol::num_format::format_with_separators;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i64>,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
}

impl TokenUsage {
    pub fn is_zero(&self) -> bool {
        self.total_tokens == 0
    }

    pub(crate) fn cached_input(&self) -> i64 {
        self.cached_input_tokens.max(0)
    }

    pub(crate) fn non_cached_input(&self) -> i64 {
        (self.input_tokens - self.cached_input()).max(0)
    }

    pub(crate) fn blended_total(&self) -> i64 {
        (self.non_cached_input() + self.output_tokens.max(0)).max(0)
    }

    /// Returns the raw `total_tokens` value. For `last_token_usage`, this is the latest active
    /// context size; for `total_token_usage`, this is the accumulated session total.
    pub(crate) fn tokens_in_context_window(&self) -> i64 {
        self.total_tokens
    }

    pub(crate) fn percent_of_context_window_remaining(&self, context_window: i64) -> i64 {
        self.percent_of_context_window_remaining_exact(context_window)
            .round() as i64
    }

    pub(crate) fn percent_of_context_window_used_exact(&self, context_window: i64) -> f64 {
        if context_window <= 0 {
            return 0.0;
        }
        let used = self.tokens_in_context_window().max(0);
        ((used as f64 / context_window as f64) * 100.0).clamp(0.0, 100.0)
    }

    pub(crate) fn percent_of_context_window_remaining_exact(&self, context_window: i64) -> f64 {
        if context_window <= 0 {
            return 100.0;
        }
        (100.0 - self.percent_of_context_window_used_exact(context_window)).clamp(0.0, 100.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TokenUsageInfo {
    pub(crate) total_token_usage: TokenUsage,
    pub(crate) last_token_usage: TokenUsage,
    pub(crate) model_context_window: Option<i64>,
}

impl fmt::Display for TokenUsage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let cached = self.cached_input();
        let non_cached = self.non_cached_input();
        let total_input = non_cached + cached;

        write!(
            f,
            "Token usage: total={} input={}",
            format_with_separators(self.total_tokens.max(0)),
            format_with_separators(total_input),
        )?;
        if cached > 0 {
            let cache_pct = if total_input > 0 {
                (cached as f64 / total_input as f64) * 100.0
            } else {
                0.0
            };
            write!(
                f,
                " ({} cached, {:.1}% cache hit)",
                format_with_separators(cached),
                cache_pct,
            )?;
        }
        if let Some(cache_write_tokens) = self.cache_write_tokens {
            write!(
                f,
                " (+ {} cache writes)",
                format_with_separators(cache_write_tokens),
            )?;
        }
        write!(f, " output={}", format_with_separators(self.output_tokens),)?;
        if self.reasoning_output_tokens > 0 {
            write!(
                f,
                " (reasoning {})",
                format_with_separators(self.reasoning_output_tokens),
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_formats_standard_usage() {
        let usage = TokenUsage {
            input_tokens: 1000,
            cached_input_tokens: 0,
            cache_write_tokens: None,
            output_tokens: 200,
            reasoning_output_tokens: 0,
            total_tokens: 1200,
        };
        assert_eq!(
            usage.to_string(),
            "Token usage: total=1,200 input=1,000 output=200"
        );
    }

    #[test]
    fn display_formats_cached_usage_with_percentage() {
        let usage = TokenUsage {
            input_tokens: 1000,
            cached_input_tokens: 650,
            cache_write_tokens: None,
            output_tokens: 200,
            reasoning_output_tokens: 50,
            total_tokens: 1200,
        };
        assert_eq!(
            usage.to_string(),
            "Token usage: total=1,200 input=1,000 (650 cached, 65.0% cache hit) output=200 (reasoning 50)"
        );
    }
}
