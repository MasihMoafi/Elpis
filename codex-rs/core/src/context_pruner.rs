//! Elpis: the pruning model, its provider and batch limit, shared by Smart Prune
//! (`crate::session::smart_prune`).
//!
//! Copied from v0.3.0 `core/src/context_pruner.rs`. The pruner follows `/pruner-model`
//! (`pruner.json`), then the background model and provider that `/memory-model` sets
//! (`background_model`, `background_provider`), then the built-in default.

use codex_model_provider_info::ModelProviderInfo;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use std::collections::HashMap;

/// Luna is sufficient for the pass's bounded keep/delete classification and avoids
/// spending a larger model on routine context maintenance.
pub(crate) const PRUNE_MODEL_SLUG: &str = "gpt-5.6-luna";

/// Upper bound on one pass's batch, in approximate tokens. Beyond this a single pass
/// stops being a bounded maintenance call: latency grows, and a reply covering
/// hundreds of ids is far likelier to come back truncated or unparseable — which
/// reclaims nothing at all. Whatever is left over is simply the next pass's batch.
pub const MAX_PRUNE_BATCH_TOKENS: usize = 24_000;

/// The model background maintenance should use: the configured
/// `background_model` when set, otherwise the caller's built-in default.
///
/// Pruning and session naming route through this so one setting moves them together onto
/// a cheaper or non-OpenAI provider without touching the model that answers the user.
pub(crate) fn background_model_slug<'a>(configured: Option<&'a str>, default: &'a str) -> &'a str {
    configured
        .map(str::trim)
        .filter(|slug| !slug.is_empty())
        .unwrap_or(default)
}

/// The provider a pruning request should go to, or `None` when the session's
/// own should be used.
///
/// `pruner_provider` is `/pruner-model`'s own pin, which wins because it is the
/// narrower choice; without it the pruner follows the rest of background
/// maintenance. An unknown id is an error rather than a silent fall back to the
/// session's provider, which would spend the user's main quota on a model it
/// cannot serve.
pub fn pruner_provider_info(
    pruner_provider: Option<&str>,
    config: &crate::config::Config,
) -> anyhow::Result<Option<ModelProviderInfo>> {
    match resolve_background_provider(pruner_provider, &config.model_providers)? {
        Some(provider) => Ok(Some(provider)),
        None => resolve_background_provider(
            config.background_provider.as_deref(),
            &config.model_providers,
        ),
    }
}

/// The configured background provider, or `None` when the session's own should
/// be used. An unknown id is an error so the setting cannot silently no-op.
fn resolve_background_provider(
    configured: Option<&str>,
    providers: &HashMap<String, ModelProviderInfo>,
) -> anyhow::Result<Option<ModelProviderInfo>> {
    let Some(provider_id) = configured.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    providers
        .get(provider_id)
        .cloned()
        .map(Some)
        .ok_or_else(|| {
            anyhow::anyhow!("background_provider {provider_id} is not in model_providers")
        })
}

/// The current user question is classification context, never part of the deletable
/// batch. The optimizer needs it to judge whether a tool result mattered.
pub(crate) fn latest_user_message_text<'a>(
    input: impl DoubleEndedIterator<Item = &'a ResponseItem>,
) -> Option<String> {
    input.rev().find_map(|item| {
        let ResponseItem::Message { role, content, .. } = item else {
            return None;
        };
        if role != "user" {
            return None;
        }
        let text = content
            .iter()
            .filter_map(|content| match content {
                ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                    Some(text.as_str())
                }
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        (!text.trim().is_empty()).then_some(text)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn message(role: &str, text: &str) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: role.to_string(),
            content: vec![ContentItem::InputText {
                text: text.to_string(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }
    }

    #[test]
    fn latest_user_message_is_the_newest_non_blank_user_text() {
        let items = [
            message("user", "first question"),
            message("assistant", "answer"),
            message("user", "second question"),
            message("user", "   "),
            message("developer", "rules"),
        ];
        assert_eq!(
            latest_user_message_text(items.iter()).as_deref(),
            Some("second question")
        );
        assert_eq!(
            latest_user_message_text([message("assistant", "only")].iter()),
            None
        );
    }

    #[test]
    fn an_unknown_pruner_provider_is_an_error_not_a_fallback() {
        let providers = HashMap::new();
        assert!(
            resolve_background_provider(None, &providers)
                .expect("unset")
                .is_none()
        );
        assert!(
            resolve_background_provider(Some("  "), &providers)
                .expect("blank")
                .is_none()
        );
        assert!(resolve_background_provider(Some("missing"), &providers).is_err());
    }

    #[test]
    fn background_model_replaces_the_default_only_when_set() {
        assert_eq!(background_model_slug(None, "gpt-5.6-luna"), "gpt-5.6-luna");
        assert_eq!(background_model_slug(Some("  "), "gpt-5.6-luna"), "gpt-5.6-luna");
        assert_eq!(background_model_slug(Some("cheap"), "gpt-5.6-luna"), "cheap");
    }
}
