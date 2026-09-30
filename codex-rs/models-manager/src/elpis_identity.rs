//! Elpis: the model is told it is Elpis.
//!
//! OpenAI's model catalog introduces the agent as Codex ("You are Codex, an agent based on
//! GPT-6", "As Codex, you are ..."), and the bundled fallback prompt says it runs "in the Codex
//! CLI". Every catalog model passes through `with_config_overrides`, which calls
//! [`name_elpis`] before applying user overrides, so a user's own `base_instructions` stay
//! verbatim. Only the capitalized word "Codex" is renamed: paths (`~/.codex`), commands
//! (`codex exec`) and longer words are left alone.

use codex_protocol::openai_models::ModelInfo;

const UPSTREAM_NAME: &str = "Codex";
const PRODUCT_NAME: &str = "Elpis";

pub(crate) fn name_elpis(mut model: ModelInfo) -> ModelInfo {
    if let Some(messages) = model.model_messages.as_mut() {
        for text in [
            messages.instructions_template.as_mut(),
            messages.persistent_instructions.as_mut(),
        ]
        .into_iter()
        .flatten()
        {
            *text = rename(text);
        }
    }
    model
}

fn rename(text: &str) -> String {
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(UPSTREAM_NAME) {
        let (before, after) = rest.split_at(index);
        let after = &after[UPSTREAM_NAME.len()..];
        let standalone = !out
            .chars()
            .chain(before.chars())
            .last()
            .is_some_and(is_word)
            && !after.chars().next().is_some_and(is_word)
            // "the old Codex language model built by OpenAI" is history, not the agent's name.
            && !after.starts_with(" language model");
        out.push_str(before);
        out.push_str(if standalone {
            PRODUCT_NAME
        } else {
            UPSTREAM_NAME
        });
        rest = after;
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn catalog_identity_lines_name_elpis() {
        assert_eq!(
            rename("You are Codex, an agent based on GPT-6.\n\nAs Codex, you are curious."),
            "You are Elpis, an agent based on GPT-6.\n\nAs Elpis, you are curious."
        );
        assert_eq!(
            rename("You have a vivid inner life as Codex: intelligent"),
            "You have a vivid inner life as Elpis: intelligent"
        );
        assert_eq!(
            rename("running in the Codex CLI"),
            "running in the Elpis CLI"
        );
    }

    #[test]
    fn every_model_is_renamed_but_a_users_own_instructions_are_not() {
        let renamed = crate::model_info::with_config_overrides(
            crate::model_info::model_info_from_slug("any-model"),
            &crate::config::ModelsManagerConfig::default(),
        );
        let template = renamed
            .model_messages
            .and_then(|messages| messages.instructions_template)
            .unwrap_or_default();
        assert!(template.contains("Elpis"), "{template}");
        assert_eq!(rename(&template), template, "a standalone Codex is left");

        let own = "You are Codex, my way.".to_string();
        let kept = crate::model_info::with_config_overrides(
            crate::model_info::model_info_from_slug("any-model"),
            &crate::config::ModelsManagerConfig {
                base_instructions: Some(own.clone()),
                ..Default::default()
            },
        );
        assert_eq!(
            kept.model_messages
                .and_then(|messages| messages.instructions_template),
            Some(own)
        );
    }

    #[test]
    fn paths_commands_and_longer_words_are_untouched() {
        for text in [
            "~/.codex/config.toml",
            "run `codex exec`",
            "CodexHome and MyCodex",
            "the codex-rs tree",
            "not the old Codex language model built by OpenAI",
        ] {
            assert_eq!(rename(text), text);
        }
    }
}
