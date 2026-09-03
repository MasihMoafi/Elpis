use super::session::Session;
use super::turn_context::TurnContext;
use crate::config::Config;
use codex_protocol::config_types::AutoCompactTokenLimitScope;
use codex_protocol::openai_models::ModelInfo;

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

pub(crate) async fn context_window_token_status(
    sess: &Session,
    turn_context: &TurnContext,
) -> ContextWindowTokenStatus {
    context_window_token_status_with_config(
        sess,
        turn_context.config.as_ref(),
        &turn_context.model_info,
    )
    .await
}

async fn context_window_token_status_with_config(
    sess: &Session,
    config: &Config,
    model_info: &ModelInfo,
) -> ContextWindowTokenStatus {
    let active_context_tokens = sess.get_total_token_usage().await;

    // Count either the full active context or only the tokens added after the initial prefix.
    let (auto_compact_scope_tokens, auto_compact_scope_limit, auto_compact_window_prefill_tokens) =
        match config.model_auto_compact_token_limit_scope {
            AutoCompactTokenLimitScope::Total => (
                active_context_tokens,
                model_info.auto_compact_token_limit(),
                None,
            ),
            AutoCompactTokenLimitScope::BodyAfterPrefix => {
                let window = sess.auto_compact_window_snapshot().await;
                let baseline = window.prefill_input_tokens.unwrap_or(active_context_tokens);

                let scope_limit = config
                    .model_auto_compact_token_limit
                    .or_else(|| model_info.auto_compact_token_limit());
                (
                    active_context_tokens.saturating_sub(baseline),
                    scope_limit,
                    window.prefill_input_tokens,
                )
            }
        };

    // The model's full context window is a hard cap, independent of the auto-compaction scope.
    let full_context_window_limit = model_info.usable_context_window();

    // Report remaining tokens against the base (unbuffered) window, capped by the full context.
    let base_window_tokens_remaining = [
        tokens_remaining(auto_compact_scope_limit, auto_compact_scope_tokens),
        tokens_remaining(full_context_window_limit, active_context_tokens),
    ]
    .into_iter()
    .flatten()
    .min();

    // Only reserve the fallback buffer when there is a fallback prompt to use it.
    let auto_compact_fallback_buffer_tokens = config
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
    use codex_protocol::protocol::TokenUsage;
    use codex_protocol::protocol::TokenUsageInfo;
    use pretty_assertions::assert_eq;

    async fn set_active_context_tokens(sess: &Session, tokens: i64) {
        let usage = TokenUsage {
            input_tokens: tokens,
            total_tokens: tokens,
            ..TokenUsage::default()
        };
        let mut state = sess.state.lock().await;
        state.set_token_info(Some(TokenUsageInfo {
            total_token_usage: usage.clone(),
            last_token_usage: usage,
            model_context_window: None,
        }));
    }

    fn model_with_context_limits(model_info: &ModelInfo) -> ModelInfo {
        ModelInfo {
            context_window: Some(272_000),
            max_context_window: Some(400_000),
            auto_compact_token_limit: Some(250_000),
            effective_context_window_percent: 95,
            ..model_info.clone()
        }
    }

    #[tokio::test]
    async fn total_scope_uses_model_limit_and_usable_context_window() {
        let (sess, turn_context) = crate::session::tests::make_session_and_context().await;
        set_active_context_tokens(&sess, 100_000).await;
        let mut config = turn_context.config.as_ref().clone();
        config.model_auto_compact_token_limit = None;
        config.model_auto_compact_token_limit_scope = AutoCompactTokenLimitScope::Total;
        let model_info = model_with_context_limits(&turn_context.model_info);

        let status = context_window_token_status_with_config(&sess, &config, &model_info).await;

        assert_eq!(status.active_context_tokens, 100_000);
        assert_eq!(status.auto_compact_scope_tokens, 100_000);
        assert_eq!(status.auto_compact_scope_limit, Some(244_800));
        assert_eq!(status.full_context_window_limit, Some(258_400));
        assert_eq!(status.base_window_tokens_remaining, Some(144_800));
        assert_eq!(status.auto_compact_window_prefill_tokens, None);
    }

    #[tokio::test]
    async fn total_scope_ignores_explicit_config_limit() {
        let (sess, turn_context) = crate::session::tests::make_session_and_context().await;
        set_active_context_tokens(&sess, 100_000).await;
        let mut config = turn_context.config.as_ref().clone();
        config.model_auto_compact_token_limit = Some(120_000);
        config.model_auto_compact_token_limit_scope = AutoCompactTokenLimitScope::Total;
        let model_info = model_with_context_limits(&turn_context.model_info);

        let status = context_window_token_status_with_config(&sess, &config, &model_info).await;

        assert_eq!(status.auto_compact_scope_limit, Some(244_800));
        assert_eq!(status.full_context_window_limit, Some(258_400));
    }

    #[tokio::test]
    async fn body_after_prefix_uses_configured_limit_and_prefill_accounting() {
        let (sess, turn_context) = crate::session::tests::make_session_and_context().await;
        set_active_context_tokens(&sess, 100_000).await;
        {
            let mut state = sess.state.lock().await;
            state.set_auto_compact_window_estimated_prefill(70_000);
        }
        let mut config = turn_context.config.as_ref().clone();
        config.model_auto_compact_token_limit = Some(40_000);
        config.model_auto_compact_token_limit_scope = AutoCompactTokenLimitScope::BodyAfterPrefix;
        let model_info = model_with_context_limits(&turn_context.model_info);

        let status = context_window_token_status_with_config(&sess, &config, &model_info).await;

        assert_eq!(status.active_context_tokens, 100_000);
        assert_eq!(status.auto_compact_scope_tokens, 30_000);
        assert_eq!(status.auto_compact_scope_limit, Some(40_000));
        assert_eq!(status.full_context_window_limit, Some(258_400));
        assert_eq!(status.base_window_tokens_remaining, Some(10_000));
        assert_eq!(status.auto_compact_window_prefill_tokens, Some(70_000));
    }

    #[tokio::test]
    async fn max_context_window_is_used_when_context_window_is_missing() {
        let (sess, turn_context) = crate::session::tests::make_session_and_context().await;
        set_active_context_tokens(&sess, 100_000).await;
        let mut config = turn_context.config.as_ref().clone();
        config.model_auto_compact_token_limit = None;
        config.model_auto_compact_token_limit_scope = AutoCompactTokenLimitScope::Total;
        let model_info = ModelInfo {
            context_window: None,
            max_context_window: Some(400_000),
            auto_compact_token_limit: None,
            effective_context_window_percent: 95,
            ..turn_context.model_info.clone()
        };

        let status = context_window_token_status_with_config(&sess, &config, &model_info).await;

        assert_eq!(status.auto_compact_scope_limit, Some(360_000));
        assert_eq!(status.full_context_window_limit, Some(380_000));
    }

    #[tokio::test]
    async fn unknown_context_window_has_no_synthetic_limit() {
        let (sess, turn_context) = crate::session::tests::make_session_and_context().await;
        set_active_context_tokens(&sess, 100_000).await;
        let mut config = turn_context.config.as_ref().clone();
        config.model_auto_compact_token_limit = Some(120_000);
        config.model_auto_compact_token_limit_scope = AutoCompactTokenLimitScope::Total;
        let model_info = ModelInfo {
            context_window: None,
            max_context_window: None,
            auto_compact_token_limit: None,
            ..turn_context.model_info.clone()
        };

        let status = context_window_token_status_with_config(&sess, &config, &model_info).await;

        assert_eq!(status.auto_compact_scope_limit, None);
        assert_eq!(status.full_context_window_limit, None);
        assert_eq!(status.base_window_tokens_remaining, None);
        assert!(!status.full_context_window_limit_reached);
        assert!(!status.token_limit_reached);
    }
}
