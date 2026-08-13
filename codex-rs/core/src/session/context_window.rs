use super::session::Session;
use super::turn_context::TurnContext;
use codex_protocol::config_types::AutoCompactTokenLimitScope;

#[derive(Debug)]
pub(crate) struct ContextWindowTokenStatus {
    // Full active context usage, independent of the configured auto-compact scope.
    pub(crate) active_context_tokens: i64,
    // Usage counted against `model_auto_compact_token_limit` for the current scope.
    pub(crate) auto_compact_scope_tokens: i64,
    pub(crate) auto_compact_scope_limit: Option<i64>,
    pub(crate) full_context_window_limit: Option<i64>,
    pub(crate) base_window_tokens_remaining: Option<i64>,
    pub(crate) auto_compact_window_prefill_tokens: Option<i64>,
    pub(crate) full_context_window_limit_reached: bool,
    pub(crate) token_limit_reached: bool,
}

fn tokens_remaining(limit: Option<i64>, used: i64) -> Option<i64> {
    limit.map(|limit| limit.saturating_sub(used).max(0))
}

/// Share of the context window Elpis leaves free before compaction is forced.
///
/// Pruning is the first line and triggers far earlier (at 30% *used*); this is only the
/// backstop for when a pruning cycle stalls or has nothing left to reclaim. It exists
/// because without it a stalled cycle has nothing underneath it and the session runs the
/// window to exhaustion and errors.
pub(crate) const ELPIS_COMPACT_REMAINING_PERCENT: i64 = 40;

/// The Elpis auto-compaction threshold in absolute tokens: compact once fewer than
/// `ELPIS_COMPACT_REMAINING_PERCENT` of the window is left.
fn elpis_auto_compact_token_limit(full_context_window_limit: Option<i64>) -> Option<i64> {
    full_context_window_limit
        .map(|window| window.saturating_mul(100 - ELPIS_COMPACT_REMAINING_PERCENT) / 100)
}

pub(crate) async fn context_window_token_status(
    sess: &Session,
    turn_context: &TurnContext,
) -> ContextWindowTokenStatus {
    let active_context_tokens = sess.get_total_token_usage().await;

    // The model's full context window is a hard cap, independent of the auto-compaction scope.
    let full_context_window_limit = turn_context.model_context_window();

    // Count either the full active context or only the tokens added after the initial prefix.
    let (auto_compact_scope_tokens, auto_compact_scope_limit, auto_compact_window_prefill_tokens) =
        match turn_context.config.model_auto_compact_token_limit_scope {
            AutoCompactTokenLimitScope::Total => (
                active_context_tokens,
                // An explicit config limit wins; otherwise hold the Elpis remaining-context
                // floor, falling back to the model's own limit when the window is unknown.
                turn_context
                    .config
                    .model_auto_compact_token_limit
                    .or_else(|| elpis_auto_compact_token_limit(full_context_window_limit))
                    .or_else(|| turn_context.model_info.auto_compact_token_limit()),
                None,
            ),
            AutoCompactTokenLimitScope::BodyAfterPrefix => {
                let window = sess.auto_compact_window_snapshot().await;
                let baseline = window.prefill_input_tokens.unwrap_or(active_context_tokens);

                let scope_limit = turn_context
                    .config
                    .model_auto_compact_token_limit
                    .or_else(|| turn_context.model_info.auto_compact_token_limit());
                (
                    active_context_tokens.saturating_sub(baseline),
                    scope_limit,
                    window.prefill_input_tokens,
                )
            }
        };

    // Report remaining tokens against the base (unbuffered) window, capped by the full context.
    let base_window_tokens_remaining = [
        tokens_remaining(auto_compact_scope_limit, auto_compact_scope_tokens),
        tokens_remaining(full_context_window_limit, active_context_tokens),
    ]
    .into_iter()
    .flatten()
    .min();

    // Only reserve the fallback buffer when there is a fallback prompt to use it.
    let auto_compact_fallback_buffer_tokens = turn_context
        .config
        .token_budget
        .as_ref()
        .map_or(0, crate::config::TokenBudgetConfig::fallback_buffer_tokens);
    let buffered_auto_compact_limit = auto_compact_scope_limit
        .map(|limit| limit.saturating_add(auto_compact_fallback_buffer_tokens));

    // Force compaction once the buffered window or the model's full context window is reached.
    let full_context_window_limit_reached =
        full_context_window_limit.is_some_and(|limit| active_context_tokens >= limit);
    let token_limit_reached = buffered_auto_compact_limit
        .is_some_and(|limit| auto_compact_scope_tokens >= limit)
        || full_context_window_limit_reached;

    ContextWindowTokenStatus {
        active_context_tokens,
        auto_compact_scope_tokens,
        auto_compact_scope_limit,
        full_context_window_limit,
        base_window_tokens_remaining,
        auto_compact_window_prefill_tokens,
        full_context_window_limit_reached,
        token_limit_reached,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    /// The window used by every run in the RQ1/RQ4 corpus.
    const GPT_5_6_LUNA_WINDOW: i64 = 258_400;

    #[test]
    fn compaction_is_armed_once_forty_percent_of_the_window_is_left() {
        let limit = elpis_auto_compact_token_limit(Some(GPT_5_6_LUNA_WINDOW))
            .expect("a known window yields a limit");

        assert_eq!(limit, 155_040);
        assert_eq!(limit * 100 / GPT_5_6_LUNA_WINDOW, 60);
        assert_eq!(GPT_5_6_LUNA_WINDOW - limit, 103_360);
    }

    #[test]
    fn the_backstop_sits_well_clear_of_the_pruning_trigger() {
        let limit = elpis_auto_compact_token_limit(Some(GPT_5_6_LUNA_WINDOW))
            .expect("a known window yields a limit");
        let prune_trigger = GPT_5_6_LUNA_WINDOW
            * crate::context_pruner::AUTO_PRUNE_TRIGGER_PERCENT
            / 100;

        assert!(
            limit > prune_trigger,
            "compaction at {limit} would fire before pruning at {prune_trigger}"
        );
        assert_eq!(prune_trigger, 77_520);
    }

    #[test]
    fn an_unknown_window_yields_no_elpis_limit() {
        assert_eq!(elpis_auto_compact_token_limit(None), None);
    }

    #[test]
    fn the_threshold_scales_with_the_window() {
        assert_eq!(elpis_auto_compact_token_limit(Some(100_000)), Some(60_000));
        assert_eq!(elpis_auto_compact_token_limit(Some(400_000)), Some(240_000));
        assert_eq!(elpis_auto_compact_token_limit(Some(40_000)), Some(24_000));
        assert_eq!(elpis_auto_compact_token_limit(Some(0)), Some(0));
    }
}
