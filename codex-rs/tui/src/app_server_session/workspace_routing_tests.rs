//! A slow or failing network must not stop the TUI from starting.
//! `account/read` used to wait for workspace routing discovery, which needs the network (15 s
//! limit), and bootstrap turned its failure into a fatal startup error.

use super::*;
use crate::legacy_core::config::ConfigBuilder;
use app_test_support::ChatGptAuthFixture;
use app_test_support::write_chatgpt_auth;
use app_test_support::write_models_cache;
use codex_config::types::AuthCredentialsStoreMode;
use pretty_assertions::assert_eq;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path_regex;

/// Far above the server's 15 s discovery limit and the 8 s the TUI may spend starting.
const SLOWER_THAN_DISCOVERY_LIMIT: Duration = Duration::from_secs(/*secs*/ 30);
const STARTUP_BUDGET: Duration = Duration::from_secs(/*secs*/ 8);

async fn bootstrap_against(discovery: ResponseTemplate) -> Result<AppServerBootstrap> {
    let backend = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex("^/(backend-api/wham|api/codex)/accounts/check$"))
        .respond_with(discovery)
        .mount(&backend)
        .await;
    let codex_home = tempfile::tempdir()?;
    std::fs::write(
        codex_home.path().join("config.toml"),
        format!(
            "chatgpt_base_url = '{}/backend-api/'\ncli_auth_credentials_store = 'file'\n",
            backend.uri()
        ),
    )?;
    write_chatgpt_auth(
        codex_home.path(),
        ChatGptAuthFixture::new("token")
            .account_id("selected")
            .email("user@example.com")
            .plan_type("pro"),
        AuthCredentialsStoreMode::File,
    )
    .map_err(|error| color_eyre::eyre::eyre!("{error:#}"))?;
    write_models_cache(codex_home.path()).await?;
    let config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .build()
        .await?;
    let mut app_server = crate::start_embedded_app_server_for_picker(&config).await?;
    let bootstrap = tokio::time::timeout(STARTUP_BUDGET, app_server.bootstrap(&config)).await;
    app_server.shutdown().await?;
    bootstrap.map_err(|_| {
        color_eyre::eyre::eyre!("bootstrap waited more than {STARTUP_BUDGET:?} for the network")
    })?
}

fn assert_signed_in_without_routing(bootstrap: &AppServerBootstrap) {
    assert_eq!(
        (
            bootstrap.account_email.as_deref(),
            bootstrap.plan_type.as_ref(),
            bootstrap.has_chatgpt_account,
        ),
        (
            Some("user@example.com"),
            Some(&codex_protocol::account::PlanType::Pro),
            true,
        )
    );
}

#[tokio::test]
async fn bootstrap_does_not_wait_for_slow_workspace_routing() -> Result<()> {
    let slow = ResponseTemplate::new(/*s*/ 200)
        .set_body_json(serde_json::json!({"accounts": []}))
        .set_delay(SLOWER_THAN_DISCOVERY_LIMIT);

    let bootstrap = bootstrap_against(slow).await?;

    assert_signed_in_without_routing(&bootstrap);
    Ok(())
}

#[tokio::test]
async fn bootstrap_survives_failed_workspace_routing() -> Result<()> {
    let bootstrap = bootstrap_against(ResponseTemplate::new(/*s*/ 503)).await?;

    assert_signed_in_without_routing(&bootstrap);
    Ok(())
}
