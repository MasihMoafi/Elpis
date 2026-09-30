use super::*;
use codex_model_provider_info::GatewayWire;
use codex_model_provider_info::ModelProviderInfo;
use http::HeaderMap;
use pretty_assertions::assert_eq;

const ENV_KEY: &str = "FIXTURE_PROVIDER_API_KEY";

fn route(bearer: Option<&str>) -> Route {
    Route {
        provider_id: "fixture".to_string(),
        wire: GatewayWire::AnthropicMessages,
        upstream: "http://127.0.0.1:9/v1".to_string(),
        env_key: Some(ENV_KEY.to_string()),
        bearer: bearer.map(str::to_string),
        forwarded: HeaderMap::new(),
    }
}

fn env_with_key(name: &str) -> Option<String> {
    (name == ENV_KEY).then(|| "env-key".to_string())
}

fn no_env(_: &str) -> Option<String> {
    None
}

#[test]
fn a_saved_key_wins_over_the_environment_and_a_bearer_wins_over_both() {
    let home = tempfile::tempdir().expect("tempdir");
    assert_eq!(
        resolve(home.path(), &route(None), env_with_key).as_deref(),
        Some("env-key")
    );

    save_provider_key(home.path(), "fixture", "  saved-key  ").expect("save");
    assert_eq!(
        resolve(home.path(), &route(None), env_with_key).as_deref(),
        Some("saved-key")
    );
    assert_eq!(
        resolve(home.path(), &route(Some("config-bearer")), env_with_key).as_deref(),
        Some("config-bearer")
    );

    remove_provider_key(home.path(), "fixture").expect("remove");
    assert_eq!(
        resolve(home.path(), &route(None), env_with_key).as_deref(),
        Some("env-key")
    );
}

#[test]
fn no_key_anywhere_resolves_to_none() {
    let home = tempfile::tempdir().expect("tempdir");
    save_provider_key(home.path(), "another-provider", "other-key").expect("save");

    assert_eq!(resolve(home.path(), &route(None), no_env), None);
}

#[test]
fn a_key_that_cannot_be_a_header_is_refused_and_not_stored() {
    let home = tempfile::tempdir().expect("tempdir");
    let too_long = "k".repeat(MAX_KEY_BYTES + 1);
    for key in ["", "has space", "line\nbreak", too_long.as_str()] {
        assert!(save_provider_key(home.path(), "fixture", key).is_err(), "{key:?}");
    }
    assert!(!provider_keys_path(home.path()).exists());
}

#[cfg(unix)]
#[test]
fn saved_keys_are_readable_only_by_the_owner_in_v030_format() {
    use std::os::unix::fs::PermissionsExt;

    let home = tempfile::tempdir().expect("tempdir");
    save_provider_key(home.path(), "anthropic", "sk-ant-fixture").expect("save");
    let path = provider_keys_path(home.path());

    let mode = std::fs::metadata(&path).expect("metadata").permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    let stored: BTreeMap<String, String> =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
    assert_eq!(
        stored,
        BTreeMap::from([("anthropic".to_string(), "sk-ant-fixture".to_string())])
    );
}

#[test]
fn key_source_names_where_a_key_would_come_from() {
    let home = tempfile::tempdir().expect("tempdir");
    let unset = "ELPIS_GATEWAY_TEST_VARIABLE_THAT_IS_NEVER_SET";

    assert_eq!(key_source(home.path(), "fixture", Some(unset)), KeySource::Missing);
    save_provider_key(home.path(), "fixture", "saved-key").expect("save");
    assert_eq!(key_source(home.path(), "fixture", Some(unset)), KeySource::Saved);
}

fn routed(provider_id: &str, wire: GatewayWire, env_key: Option<&str>) -> ModelProviderInfo {
    let mut provider = ModelProviderInfo {
        name: provider_id.to_string(),
        base_url: Some("https://vendor.example/v1".to_string()),
        env_key: env_key.map(str::to_string),
        ..ModelProviderInfo::default()
    };
    codex_model_provider_info::route_through_gateway(provider_id, wire, &mut provider)
        .expect("routed");
    provider
}

#[test]
fn provider_key_source_covers_every_way_a_gateway_provider_gets_a_key() {
    let home = tempfile::tempdir().expect("tempdir");
    let unset = "ELPIS_GATEWAY_TEST_VARIABLE_THAT_IS_NEVER_SET";
    let anthropic = routed("fixture", GatewayWire::AnthropicMessages, Some(unset));

    assert_eq!(provider_key_source(home.path(), &anthropic), Some(KeySource::Missing));
    save_provider_key(home.path(), "fixture", "saved-key").expect("save");
    assert_eq!(provider_key_source(home.path(), &anthropic), Some(KeySource::Saved));

    let local_chat = routed("local", GatewayWire::Chat, /*env_key*/ None);
    assert_eq!(provider_key_source(home.path(), &local_chat), Some(KeySource::NotRequired));

    let mut configured = routed("configured", GatewayWire::Chat, Some(unset));
    configured.experimental_bearer_token = Some("token".into());
    assert_eq!(provider_key_source(home.path(), &configured), Some(KeySource::Configured));

    let openai = ModelProviderInfo::create_openai_provider(/*base_url*/ None);
    assert_eq!(provider_key_source(home.path(), &openai), None);
}
