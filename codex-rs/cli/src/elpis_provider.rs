//! Elpis: `--provider`, v0.3.0's launcher flag.
//!
//! `--provider <id>` is `-c model_provider=<id>`. Three names are routes rather than providers:
//! `claude`, `gemini` and `gemini-flash` reach that model family through OpenRouter, and also
//! set OpenRouter's rolling alias for the family's latest model.

/// OpenRouter compatibility routes: launcher name and the OpenRouter model it selects.
const OPENROUTER_ROUTES: [(&str, &str); 3] = [
    ("claude", "~anthropic/claude-sonnet-latest"),
    ("gemini", "~google/gemini-pro-latest"),
    ("gemini-flash", "~google/gemini-flash-latest"),
];

#[derive(Debug, Default, clap::Parser, Clone)]
pub(crate) struct ProviderSelection {
    /// Model provider to use (openai, anthropic, google-gemini, openrouter, ollama, a provider
    /// from config.toml), or claude, gemini or gemini-flash for that model through OpenRouter.
    /// Give it before a subcommand: `elpis --provider claude exec …`.
    #[arg(long = "provider", value_name = "PROVIDER")]
    provider: Option<String>,
}

impl ProviderSelection {
    /// The `-c` overrides this flag stands for.
    pub(crate) fn to_overrides(&self) -> Vec<String> {
        let Some(provider) = self.provider.as_deref() else {
            return Vec::new();
        };
        let (provider, model) = OPENROUTER_ROUTES
            .iter()
            .find(|(alias, _)| *alias == provider)
            .map_or((provider, None), |(_, model)| {
                (codex_model_provider_info::OPENROUTER_PROVIDER_ID, Some(*model))
            });
        let mut overrides = vec![format!("model_provider={}", toml_string(provider))];
        if let Some(model) = model {
            overrides.push(format!("model={}", toml_string(model)));
        }
        overrides
    }
}

fn toml_string(value: &str) -> String {
    toml::Value::String(value.to_string()).to_string()
}

#[cfg(test)]
mod tests {
    use clap::Parser;
    use pretty_assertions::assert_eq;

    fn overrides(args: &[&str]) -> Vec<String> {
        crate::MultitoolCli::try_parse_from(args)
            .expect("parse")
            .elpis_provider
            .to_overrides()
    }

    #[test]
    fn a_route_name_selects_openrouter_and_its_model() {
        assert_eq!(
            overrides(&["elpis", "--provider", "claude"]),
            vec![
                "model_provider=\"openrouter\"".to_string(),
                "model=\"~anthropic/claude-sonnet-latest\"".to_string(),
            ]
        );
        assert_eq!(
            overrides(&["elpis", "--provider", "gemini-flash", "exec", "hi"]),
            vec![
                "model_provider=\"openrouter\"".to_string(),
                "model=\"~google/gemini-flash-latest\"".to_string(),
            ]
        );
    }

    #[test]
    fn a_provider_id_selects_only_the_provider() {
        assert_eq!(
            overrides(&["elpis", "--provider", "anthropic"]),
            vec!["model_provider=\"anthropic\"".to_string()]
        );
        assert_eq!(overrides(&["elpis"]), Vec::<String>::new());
    }
}
