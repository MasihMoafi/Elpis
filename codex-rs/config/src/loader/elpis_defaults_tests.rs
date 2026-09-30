//! Elpis: the embedded packaged defaults carry the Elpis product defaults.
//!
//! They sit in the lowest-precedence layer, so a user's own config still wins.

use crate::LoaderOverrides;
use crate::NoopThreadConfigLoader;
use crate::config_toml::ConfigToml;
use crate::loader::load_config_layers_state;
use crate::loader::tests::TestFileSystem;
use crate::types::OtelExporterKind;
use codex_utils_absolute_path::AbsolutePathBuf;
use pretty_assertions::assert_eq;
use toml::Value as TomlValue;

/// Feature flags that Elpis switches off by default. Each one either phones a
/// remote service or is not part of the Elpis product.
/// Keep this list in step with config/defaults.toml.
const FEATURES_OFF: [&str; 6] = [
    "plugins",
    "apps",
    "tool_suggest",
    "image_generation",
    "daemon_auto_start",
    "memories",
];

async fn effective_config(user_config: Option<&str>) -> anyhow::Result<TomlValue> {
    let temp = tempfile::tempdir()?;
    let home = AbsolutePathBuf::from_absolute_path(temp.path().canonicalize()?)?;
    if let Some(user_config) = user_config {
        std::fs::write(home.join(crate::CONFIG_TOML_FILE).as_path(), user_config)?;
    }
    let stack = load_config_layers_state(
        &TestFileSystem,
        home.as_path(),
        /*cwd*/ None,
        &[],
        // No packaged_defaults_path: the embedded defaults.toml is used.
        LoaderOverrides::without_managed_config_for_tests(),
        &NoopThreadConfigLoader,
    )
    .await?;
    Ok(stack.effective_config())
}

fn feature(config: &TomlValue, key: &str) -> Option<bool> {
    config.get("features")?.get(key)?.as_bool()
}

#[tokio::test]
async fn elpis_defaults_turn_off_outbound_services_and_keep_the_inline_screen() -> anyhow::Result<()>
{
    let effective = effective_config(/*user_config*/ None).await?;
    let typed: ConfigToml = effective.clone().try_into()?;

    assert_eq!(typed.check_for_update_on_startup, Some(false));
    assert_eq!(typed.analytics.and_then(|a| a.enabled), Some(false));
    assert_eq!(typed.feedback.and_then(|f| f.enabled), Some(false));
    assert_eq!(
        typed.otel.and_then(|o| o.metrics_exporter),
        Some(OtelExporterKind::None)
    );
    assert_eq!(
        typed.skills.as_ref().and_then(|s| s.default_enabled),
        Some(false)
    );
    assert_eq!(
        typed.skills.and_then(|s| s.bundled).map(|b| b.enabled),
        Some(false)
    );
    assert_eq!(
        typed.shell_environment_policy.exclude,
        Some(vec!["CODEX_HOME".to_string()])
    );
    assert_eq!(typed.tui.map(|t| t.fullscreen_transcript), Some(false));
    for key in FEATURES_OFF {
        assert!(codex_features::is_known_feature_key(key), "{key}");
        assert_eq!(feature(&effective, key), Some(false), "{key}");
    }
    Ok(())
}

#[tokio::test]
async fn user_config_still_overrides_elpis_defaults() -> anyhow::Result<()> {
    let effective = effective_config(Some(
        r#"
[analytics]
enabled = true

[features]
plugins = true

[tui]
fullscreen_transcript = true
"#,
    ))
    .await?;
    let typed: ConfigToml = effective.clone().try_into()?;

    assert_eq!(typed.analytics.and_then(|a| a.enabled), Some(true));
    assert_eq!(typed.tui.map(|t| t.fullscreen_transcript), Some(true));
    assert_eq!(feature(&effective, "plugins"), Some(true));
    // Keys the user did not touch keep the Elpis default.
    assert_eq!(feature(&effective, "apps"), Some(false));
    assert_eq!(typed.check_for_update_on_startup, Some(false));
    Ok(())
}

#[tokio::test]
async fn elpis_defaults_hide_upstream_codex_tips_unless_the_user_asks() -> anyhow::Result<()> {
    // v0.3.0 showed no startup tips; the upstream ones advertise the Codex apps.
    let defaults: ConfigToml = effective_config(/*user_config*/ None).await?.try_into()?;
    assert_eq!(defaults.tui.map(|t| t.show_tooltips), Some(false));

    // A user who touches another [tui] key keeps the Elpis default.
    let other_key: ConfigToml = effective_config(Some("[tui]\nfullscreen_transcript = true\n"))
        .await?
        .try_into()?;
    assert_eq!(other_key.tui.map(|t| t.show_tooltips), Some(false));

    // A user who asks for tips gets them.
    let opted_in: ConfigToml = effective_config(Some("[tui]\nshow_tooltips = true\n"))
        .await?
        .try_into()?;
    assert_eq!(opted_in.tui.map(|t| t.show_tooltips), Some(true));
    Ok(())
}
