//! Elpis: `/memory-model` chooses the fallback model/provider for Smart Prune.
//!
//! The choice is `background_model` / `background_provider` in config.toml, as in v0.3.0.
//! An explicit `/pruner-model` choice takes precedence. Session naming follows upstream's
//! model/provider selection, and saving memory uses the responding agent.

use crate::legacy_core::config::Config;
use crate::legacy_core::config::edit::ConfigEdit;

/// One `/memory-model` choice.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackgroundModelChoice {
    /// `None` restores the built-in default.
    pub(crate) model: Option<String>,
    /// `Some(provider)` replaces `background_provider` (`Some(None)` clears it); `None`
    /// leaves the configured provider alone.
    pub(crate) provider: Option<Option<String>>,
}

impl BackgroundModelChoice {
    /// `default` clears the model and the provider together; `<provider>:<id>` sets both
    /// when `<provider>` is configured; any other input is a model id on the provider
    /// background work already uses. Ported from v0.3.0 `typed_model_choice`.
    pub(crate) fn parse(input: &str, config: &Config) -> Result<Self, String> {
        let input = input.trim();
        if input.is_empty() {
            return Err("name a model id, provider:id, or default".to_string());
        }
        if input == "default" {
            return Ok(Self {
                model: None,
                provider: Some(None),
            });
        }
        if let Some((provider, model)) = input.split_once(':')
            && !model.is_empty()
            && config.model_providers.contains_key(provider)
        {
            return Ok(Self {
                model: Some(model.to_string()),
                provider: Some(Some(provider.to_string())),
            });
        }
        Ok(Self {
            model: Some(input.to_string()),
            provider: None,
        })
    }

    /// The config.toml edits that save this choice.
    pub(crate) fn edits(&self) -> Vec<ConfigEdit> {
        let mut edits = vec![setting_edit("background_model", self.model.as_deref())];
        if let Some(provider) = &self.provider {
            edits.push(setting_edit("background_provider", provider.as_deref()));
        }
        edits
    }

    /// Applies the saved choice to a loaded configuration.
    pub(crate) fn apply_to(&self, config: &mut Config) {
        config.background_model = self.model.clone();
        if let Some(provider) = &self.provider {
            config.background_provider = provider.clone();
        }
    }
}

fn setting_edit(key: &str, value: Option<&str>) -> ConfigEdit {
    let segments = vec![key.to_string()];
    match value {
        Some(value) => ConfigEdit::SetPath {
            segments,
            value: value.into(),
        },
        None => ConfigEdit::ClearPath { segments },
    }
}

/// How the configured background model reads in messages.
pub(crate) fn describe(config: &Config) -> String {
    match (&config.background_model, &config.background_provider) {
        (None, _) => "built-in default".to_string(),
        (Some(model), Some(provider)) => format!("{model} on {provider}"),
        (Some(model), None) => model.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    async fn config() -> Config {
        let home = tempfile::tempdir().expect("tempdir");
        Config::load_default_with_cli_overrides_for_codex_home(
            home.path().to_path_buf(),
            Vec::new(),
        )
        .await
        .expect("config")
    }

    #[tokio::test]
    async fn typed_choices_follow_v030() {
        let config = config().await;
        let provider = config.model_provider_id.clone();
        assert_eq!(
            BackgroundModelChoice::parse("default", &config),
            Ok(BackgroundModelChoice {
                model: None,
                provider: Some(None),
            })
        );
        assert_eq!(
            BackgroundModelChoice::parse(&format!("{provider}:gpt-5.6-luna"), &config),
            Ok(BackgroundModelChoice {
                model: Some("gpt-5.6-luna".to_string()),
                provider: Some(Some(provider)),
            })
        );
        // An unknown prefix is part of the id, not a provider.
        assert_eq!(
            BackgroundModelChoice::parse("vendor:model", &config),
            Ok(BackgroundModelChoice {
                model: Some("vendor:model".to_string()),
                provider: None,
            })
        );
        assert!(BackgroundModelChoice::parse("  ", &config).is_err());
    }
}
