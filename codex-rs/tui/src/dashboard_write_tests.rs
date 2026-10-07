//! Evals for the dashboard pages that change settings: the Models tab, the provider keys and
//! the Smart Prune prompt, and the poll that keeps the page current.
//!
//! Each behaviour has a positive case and a negative case. The routes run against a temporary
//! Elpis home and a channel that stands in for the App.

use std::path::Path;

use pretty_assertions::assert_eq;
use serde_json::Value;
use tiny_http::Header;
use tiny_http::Method;
use tiny_http::Request;
use tiny_http::TestRequest;
use tokio::sync::mpsc::UnboundedReceiver;

use super::super::*;
use crate::app_event::AppEvent;
use crate::app_event_sender::AppEventSender;
use crate::chatwidget::ElpisProviderEvent;
use crate::elpis_app_event::ElpisAppEvent;
use crate::elpis_background_model::BackgroundModelChoice;
use crate::legacy_core::pruner_settings::PrunerSettings;

const PORT: u16 = 43123;
const HOST: &str = "127.0.0.1:43123";
const ORIGIN: &str = "http://127.0.0.1:43123";
const PLANTED_KEY: &str = "sk-or-PLANTED-SECRET-7e21";

struct Harness {
    home: tempfile::TempDir,
    link: DashboardLink,
    events: UnboundedReceiver<AppEvent>,
    // Runs the vendor model lists; dropped last.
    _runtime: tokio::runtime::Runtime,
}

fn harness() -> Harness {
    let home = tempfile::tempdir().expect("temp home");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .expect("runtime");
    let (tx, events) = tokio::sync::mpsc::unbounded_channel();
    let mut providers = codex_model_provider_info::built_in_model_providers(None);
    providers.extend(codex_model_provider_info::built_in_gateway_providers());
    let link = DashboardLink {
        tx: AppEventSender::new(tx),
        home: home.path().to_path_buf(),
        providers,
        active_provider: "openai".to_string(),
        catalog: crate::test_support::TEST_MODEL_PRESETS.clone(),
        pruner_role_provider: "openai".to_string(),
        runtime: Some(runtime.handle().clone()),
        refresh_pending: Default::default(),
    };
    Harness {
        home,
        link,
        events,
        _runtime: runtime,
    }
}

/// A model the OpenAI catalogue lists in its picker.
fn listed_model() -> String {
    crate::test_support::TEST_MODEL_PRESETS
        .iter()
        .find(|preset| preset.show_in_picker)
        .expect("a visible preset")
        .model
        .clone()
}

fn token() -> String {
    super::super::evidence::dashboard_fragment()
        .trim_start_matches("#evidence=")
        .to_string()
}

fn get(path: &str) -> Request {
    TestRequest::new()
        .with_method(Method::Get)
        .with_path(path)
        .with_header(format!("Host: {HOST}").parse::<Header>().expect("host"))
        .into()
}

/// A test body; `TestRequest` keeps only `'static` bodies.
fn leak(body: &str) -> &'static str {
    Box::leak(body.to_string().into_boxed_str())
}

fn post_with(path: &str, origin: Option<&str>, content_type: &str, body: &str) -> Request {
    let mut request = TestRequest::new()
        .with_method(Method::Post)
        .with_path(path)
        .with_header(format!("Host: {HOST}").parse::<Header>().expect("host"))
        .with_header(
            format!("Content-Type: {content_type}")
                .parse::<Header>()
                .expect("content type"),
        )
        .with_body(leak(body));
    if let Some(origin) = origin {
        request = request.with_header(
            format!("Origin: {origin}")
                .parse::<Header>()
                .expect("origin"),
        );
    }
    request.into()
}

fn post(path: &str, body: &str) -> Request {
    post_with(path, Some(ORIGIN), "application/json", body)
}

fn send(link: &DashboardLink, mut request: Request) -> (u16, String) {
    let response = route(&mut request, PORT, Some(link), None, 2_000);
    let status = response.status_code().0;
    let body = String::from_utf8(response.into_reader().into_inner()).expect("utf-8 body");
    (status, body)
}

fn json(body: &str) -> Value {
    serde_json::from_str(body).unwrap_or_else(|error| panic!("{error}: {body}"))
}

/// The App events the routes sent, in a form a test can compare.
fn drain(events: &mut UnboundedReceiver<AppEvent>) -> Vec<String> {
    std::iter::from_fn(|| events.try_recv().ok())
        .map(|event| match event {
            AppEvent::Elpis(ElpisAppEvent::RefreshDashboard) => "refresh".to_string(),
            AppEvent::Elpis(ElpisAppEvent::Provider(ElpisProviderEvent::Switch {
                provider_id,
                model,
            })) => format!("chat {provider_id} {model}"),
            AppEvent::Elpis(ElpisAppEvent::Provider(ElpisProviderEvent::UseClaudeModel {
                model,
            })) => format!("chat model {model}"),
            AppEvent::Elpis(ElpisAppEvent::SaveBackgroundModel(BackgroundModelChoice {
                model,
                provider,
            })) => format!("background {provider:?} {model:?}"),
            AppEvent::InsertHistoryCell(cell) => format!(
                "history {}",
                cell.display_lines(/*width*/ 400)
                    .iter()
                    .map(ToString::to_string)
                    .collect::<String>()
            ),
            other => format!("other {other:?}"),
        })
        .collect()
}

fn pruner_settings(home: &Path) -> PrunerSettings {
    PrunerSettings::load(home).expect("pruner settings")
}

/// Positive: the providers and a provider's catalogue, as the `/model` picker lists them.
/// Negative: a wrong token, a foreign Host or no running session lists nothing.
#[test]
fn the_models_tab_lists_providers_and_their_catalogue() {
    let harness = harness();
    let token = token();

    let (status, body) = send(&harness.link, get(&format!("/models/{token}")));
    assert_eq!(status, 200, "{body}");
    let ids: Vec<String> = json(&body)["providers"]
        .as_array()
        .expect("providers")
        .iter()
        .map(|row| row["id"].as_str().expect("id").to_string())
        .collect();
    assert!(ids.contains(&"openai".to_string()), "{ids:?}");
    assert!(ids.contains(&"openrouter".to_string()), "{ids:?}");
    assert!(!ids.contains(&"amazon-bedrock".to_string()), "{ids:?}");

    let (status, body) = send(&harness.link, get(&format!("/models/{token}/openai")));
    assert_eq!(status, 200, "{body}");
    let models = json(&body);
    let listed: Vec<&str> = models["models"]
        .as_array()
        .expect("models")
        .iter()
        .map(|row| row["id"].as_str().expect("id"))
        .collect();
    assert!(listed.contains(&listed_model().as_str()), "{listed:?}");
    assert!(
        crate::test_support::TEST_MODEL_PRESETS
            .iter()
            .filter(|preset| !preset.show_in_picker)
            .all(|hidden| !listed.contains(&hidden.model.as_str())),
        "a model hidden from the picker is listed: {listed:?}"
    );

    let (status, _) = send(
        &harness.link,
        get("/models/0123456789abcdef0123456789abcdef"),
    );
    assert_eq!(status, 403);
    let mut foreign: Request = TestRequest::new()
        .with_method(Method::Get)
        .with_path(&format!("/models/{token}"))
        .with_header("Host: evil.example:43123".parse::<Header>().expect("host"))
        .into();
    assert_eq!(
        route(&mut foreign, PORT, Some(&harness.link), None, 2_000)
            .status_code()
            .0,
        403
    );
    let mut no_session = get(&format!("/models/{token}"));
    assert_eq!(
        route(&mut no_session, PORT, None, None, 2_000)
            .status_code()
            .0,
        503
    );
}

/// Positive: each role's choice goes through the terminal's own writer and the page is
/// republished. Negative: a model its provider does not list is refused and nothing is sent
/// or saved.
#[test]
fn choosing_a_model_uses_the_terminals_writers() {
    let mut harness = harness();
    let token = token();
    let path = format!("/models/{token}");
    let model = listed_model();

    let (status, body) = send(
        &harness.link,
        post(
            &path,
            &format!(r#"{{"role":"chat","provider":"openai","model":"{model}"}}"#),
        ),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        drain(&mut harness.events),
        vec![format!("chat openai {model}"), "refresh".to_string()]
    );

    // One refresh per publication: the App has not republished yet.
    let (status, body) = send(
        &harness.link,
        post(
            &path,
            &format!(r#"{{"role":"background","provider":"openai","model":"{model}"}}"#),
        ),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        drain(&mut harness.events),
        vec![format!(
            r#"background Some(Some("openai")) Some("{model}")"#
        )]
    );
    let (status, body) = send(
        &harness.link,
        post(
            &path,
            r#"{"role":"background","provider":null,"model":null}"#,
        ),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        drain(&mut harness.events),
        vec!["background Some(None) None".to_string()]
    );

    let (status, body) = send(
        &harness.link,
        post(
            &path,
            &format!(r#"{{"role":"pruner","provider":"openai","model":"{model}"}}"#),
        ),
    );
    assert_eq!(status, 200, "{body}");
    let saved = pruner_settings(harness.home.path());
    assert_eq!(saved.model.as_deref(), Some(model.as_str()));
    assert_eq!(saved.provider.as_deref(), Some("openai"));
    let events = drain(&mut harness.events);
    assert_eq!(events.len(), 1, "{events:?}");
    assert!(
        events[0].contains("Smart Prune model saved:") && events[0].contains(&model),
        "{events:?}"
    );

    // Refused: an unlisted model, a chat default, and a provider that is not configured.
    for body in [
        r#"{"role":"chat","provider":"openai","model":"vendor/not-listed"}"#.to_string(),
        r#"{"role":"pruner","provider":"openai","model":"vendor/not-listed"}"#.to_string(),
        r#"{"role":"background","provider":"openai","model":"vendor/not-listed"}"#.to_string(),
        r#"{"role":"chat","provider":null,"model":null}"#.to_string(),
        format!(r#"{{"role":"chat","provider":"nowhere","model":"{model}"}}"#),
        r#"{"role":"chat","provider":"openai"}"#.to_string(),
        r#"{"role":"chat","provider":"openai","model":"x","extra":1}"#.to_string(),
    ] {
        let (status, answer) = send(&harness.link, post(&path, &body));
        assert_eq!(status, 400, "{body}: {answer}");
    }
    assert_eq!(drain(&mut harness.events), Vec::<String>::new());
    assert_eq!(pruner_settings(harness.home.path()), saved);
}

/// Positive: while the app server's list carries a Claude subscription model, the chat model
/// can come from the Claude subscription, which lists that model alone, and choosing it sends
/// the picker's model change, not a provider switch. Negative: without one, nothing offers or
/// accepts it; another role, or a model it does not list, is refused.
#[test]
fn the_claude_subscription_is_a_chat_model_provider_only_with_the_claude_bridge() {
    const CLAUDE: &str = crate::chatwidget::CLAUDE_SUBSCRIPTION_PROVIDER_ID;
    let mut harness = harness();
    let token = token();
    let path = format!("/models/{token}");
    let provider_rows = |link: &DashboardLink| {
        let (status, body) = send(link, get(&path));
        assert_eq!(status, 200, "{body}");
        json(&body)["providers"]
            .as_array()
            .expect("providers")
            .clone()
    };
    let listed = |link: &DashboardLink, provider: &str| {
        let (status, body) = send(link, get(&format!("{path}/{provider}")));
        (status == 200).then(|| {
            json(&body)["models"]
                .as_array()
                .expect("models")
                .iter()
                .map(|row| row["id"].as_str().expect("id").to_string())
                .collect::<Vec<_>>()
        })
    };
    let choose_claude = format!(r#"{{"role":"chat","provider":"{CLAUDE}","model":"claude/opus"}}"#);
    let pruner_before = pruner_settings(harness.home.path());

    // Without the Claude bridge.
    assert!(
        provider_rows(&harness.link)
            .iter()
            .all(|row| row["id"] != CLAUDE),
        "offered without Claude models"
    );
    assert_eq!(listed(&harness.link, CLAUDE), None);
    let (status, answer) = send(&harness.link, post(&path, &choose_claude));
    assert_eq!(status, 400, "{answer}");
    assert_eq!(drain(&mut harness.events), Vec::<String>::new());

    // With it.
    let mut claude = crate::test_support::TEST_MODEL_PRESETS
        .iter()
        .find(|preset| preset.show_in_picker)
        .expect("a visible preset")
        .clone();
    claude.id = "claude/opus".to_string();
    claude.model = "claude/opus".to_string();
    claude.display_name = "Opus 5.5 (Claude subscription)".to_string();
    claude.is_default = false;
    harness.link.catalog.insert(0, claude);

    let rows = provider_rows(&harness.link);
    assert!(
        rows.contains(&serde_json::json!({
            "id": CLAUDE,
            "name": "Claude subscription",
            "chat_only": true,
        })),
        "{rows:?}"
    );
    assert_eq!(
        listed(&harness.link, CLAUDE),
        Some(vec!["claude/opus".to_string()])
    );
    let openai = listed(&harness.link, "openai").expect("openai list");
    assert!(!openai.contains(&"claude/opus".to_string()), "{openai:?}");

    let (status, body) = send(&harness.link, post(&path, &choose_claude));
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        drain(&mut harness.events),
        vec!["chat model claude/opus".to_string(), "refresh".to_string()]
    );

    let model = listed_model();
    for body in [
        format!(r#"{{"role":"background","provider":"{CLAUDE}","model":"claude/opus"}}"#),
        format!(r#"{{"role":"pruner","provider":"{CLAUDE}","model":"claude/opus"}}"#),
        format!(r#"{{"role":"chat","provider":"{CLAUDE}","model":"{model}"}}"#),
        format!(r#"{{"role":"chat","provider":"{CLAUDE}","model":null}}"#),
    ] {
        let (status, answer) = send(&harness.link, post(&path, &body));
        assert_eq!(status, 400, "{body}: {answer}");
    }
    assert_eq!(drain(&mut harness.events), Vec::<String>::new());
    assert_eq!(pruner_settings(harness.home.path()), pruner_before);
}

/// Positive: a same-origin JSON POST with this session's token writes. Negative: a missing or
/// foreign Origin, a form body, a wrong token or a foreign Host writes nothing, on every page.
#[test]
fn writes_need_the_token_the_origin_and_json() {
    let mut harness = harness();
    let token = token();
    let model = listed_model();
    let pruner_body = format!(r#"{{"role":"pruner","provider":"openai","model":"{model}"}}"#);
    let key_body = format!(r#"{{"provider":"openrouter","api_key":"{PLANTED_KEY}"}}"#);
    let prompt_body = r#"{"system_prompt":"Keep the planted marker 42."}"#.to_string();
    for (prefix, body) in [
        ("/models/", &pruner_body),
        ("/provider-keys/", &key_body),
        ("/pruner-settings/", &prompt_body),
    ] {
        let path = format!("{prefix}{token}");
        for (request, why) in [
            (
                post_with(&path, None, "application/json", body),
                "no Origin",
            ),
            (
                post_with(
                    &path,
                    Some("https://evil.example"),
                    "application/json",
                    body,
                ),
                "foreign Origin",
            ),
            (
                post_with(&path, Some(ORIGIN), "text/plain", body),
                "not JSON",
            ),
            (
                post(&format!("{prefix}0123456789abcdef0123456789abcdef"), body),
                "wrong token",
            ),
        ] {
            let (status, answer) = send(&harness.link, request);
            assert_eq!(status, 403, "{prefix} {why}: {answer}");
            assert!(!answer.contains(PLANTED_KEY));
        }
        let mut foreign: Request = TestRequest::new()
            .with_method(Method::Post)
            .with_path(&path)
            .with_header("Host: evil.example:43123".parse::<Header>().expect("host"))
            .with_header(
                format!("Origin: {ORIGIN}")
                    .parse::<Header>()
                    .expect("origin"),
            )
            .with_header(
                "Content-Type: application/json"
                    .parse::<Header>()
                    .expect("type"),
            )
            .with_body(leak(body))
            .into();
        assert_eq!(
            route(&mut foreign, PORT, Some(&harness.link), None, 2_000)
                .status_code()
                .0,
            403,
            "{prefix} foreign Host"
        );
    }
    assert_eq!(drain(&mut harness.events), Vec::<String>::new());
    assert_eq!(
        pruner_settings(harness.home.path()),
        PrunerSettings::default()
    );
    assert!(!codex_elpis_gateway::provider_keys_path(harness.home.path()).exists());

    // The same three writes, sent properly, land.
    for (prefix, body) in [
        ("/models/", &pruner_body),
        ("/provider-keys/", &key_body),
        ("/pruner-settings/", &prompt_body),
    ] {
        let (status, answer) = send(&harness.link, post(&format!("{prefix}{token}"), body));
        assert_eq!(status, 200, "{prefix}: {answer}");
    }
    let saved = pruner_settings(harness.home.path());
    assert_eq!(saved.model.as_deref(), Some(model.as_str()));
    assert_eq!(
        saved.system_prompt.as_deref(),
        Some("Keep the planted marker 42.")
    );
    assert!(codex_elpis_gateway::provider_keys_path(harness.home.path()).exists());
}

/// Positive: a pasted key is saved owner-only where the gateway reads it for the next request,
/// and the page learns only where it comes from. Negative: the key never comes back to the page
/// or the terminal, a provider the gateway does not serve takes none, and clearing it forgets it.
#[test]
fn a_pasted_key_is_saved_and_never_echoed() {
    let mut harness = harness();
    let path = format!("/provider-keys/{}", token());
    let home = harness.home.path().to_path_buf();
    let row = |body: &str, id: &str| -> Value {
        json(body)["providers"]
            .as_array()
            .expect("providers")
            .iter()
            .find(|row| row["id"] == id)
            .cloned()
            .unwrap_or_else(|| panic!("no {id} row: {body}"))
    };

    let (status, body) = send(&harness.link, get(&path));
    assert_eq!(status, 200, "{body}");
    assert_eq!(row(&body, "openrouter")["env_var"], "OPENROUTER_API_KEY");
    assert!(
        !body.contains("\"openai\""),
        "OpenAI signs in elsewhere: {body}"
    );

    let (status, body) = send(
        &harness.link,
        post(
            &path,
            &format!(r#"{{"provider":"openrouter","api_key":"{PLANTED_KEY}"}}"#),
        ),
    );
    assert_eq!(status, 200, "{body}");
    assert!(!body.contains(PLANTED_KEY), "{body}");
    assert!(!body.contains("7e21"), "the key's tail leaked: {body}");
    let saved = row(&body, "openrouter");
    assert_eq!(saved["source"], "saved");
    assert_eq!(saved["masked"], "••••••••");
    let stored = std::fs::read_to_string(codex_elpis_gateway::provider_keys_path(&home))
        .expect("stored keys");
    assert!(stored.contains(PLANTED_KEY));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(codex_elpis_gateway::provider_keys_path(&home))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let told = drain(&mut harness.events);
    assert_eq!(told.len(), 1, "{told:?}");
    assert!(told[0].contains("key saved from the dashboard"), "{told:?}");
    assert!(!told[0].contains(PLANTED_KEY));

    for (body, status) in [
        (
            format!(r#"{{"provider":"openai","api_key":"{PLANTED_KEY}"}}"#),
            404,
        ),
        (
            format!(r#"{{"provider":"openrouter","api_key":"{PLANTED_KEY}","x":1}}"#),
            400,
        ),
        (
            r#"{"provider":"openrouter","api_key":"has space"}"#.to_string(),
            400,
        ),
    ] {
        let (answer_status, answer) = send(&harness.link, post(&path, &body));
        assert_eq!(answer_status, status, "{body}: {answer}");
        assert!(!answer.contains(PLANTED_KEY), "{answer}");
    }

    let (status, body) = send(
        &harness.link,
        post(&path, r#"{"provider":"openrouter","api_key":null}"#),
    );
    assert_eq!(status, 200, "{body}");
    assert_ne!(row(&body, "openrouter")["source"], "saved");
    let stored = std::fs::read_to_string(codex_elpis_gateway::provider_keys_path(&home))
        .expect("stored keys");
    assert!(!stored.contains(PLANTED_KEY));
}

/// Positive: the prompt page saves a prompt and keeps the model the Models tab chose.
/// Negative: an empty prompt is refused and changes nothing.
#[test]
fn the_prompt_page_keeps_the_chosen_model() {
    let harness = harness();
    let path = format!("/pruner-settings/{}", token());
    let chosen = PrunerSettings {
        model: Some("chosen-model".to_string()),
        provider: Some("openrouter".to_string()),
        system_prompt: None,
    };
    chosen.save(harness.home.path()).expect("save");

    let (status, body) = send(
        &harness.link,
        post(&path, r#"{"system_prompt":"Retain 42."}"#),
    );
    assert_eq!(status, 200, "{body}");
    let saved = pruner_settings(harness.home.path());
    assert_eq!(
        saved,
        PrunerSettings {
            system_prompt: Some("Retain 42.".to_string()),
            ..chosen
        }
    );
    assert_eq!(json(&body)["settings"]["model"], "chosen-model");

    let (status, _) = send(&harness.link, post(&path, r#"{"system_prompt":"  "}"#));
    assert_eq!(status, 400);
    let (status, _) = send(&harness.link, post(&path, r#"{"model":"other"}"#));
    assert_eq!(status, 400);
    assert_eq!(pruner_settings(harness.home.path()), saved);
}

/// Positive: a poll asks the App to republish, once per publication, so the page shows the
/// current session within one poll. Negative: without a session the poll asks nothing.
#[test]
fn each_poll_asks_the_app_for_current_state() {
    let mut harness = harness();

    let (status, _) = send(&harness.link, get("/data.json"));
    assert_eq!(status, 503, "nothing published in this test");
    assert_eq!(drain(&mut harness.events), vec!["refresh".to_string()]);
    send(&harness.link, get("/data.json"));
    assert_eq!(drain(&mut harness.events), Vec::<String>::new());

    // The App's publication registers a new link, and the next poll asks again.
    harness.link.refresh_pending = Default::default();
    send(&harness.link, get("/data.json"));
    assert_eq!(drain(&mut harness.events), vec!["refresh".to_string()]);

    // Only the state poll asks.
    for path in ["/", "/dashboard.js"] {
        send(&harness.link, get(path));
    }
    assert_eq!(drain(&mut harness.events), Vec::<String>::new());
    let mut request = get("/data.json");
    assert_eq!(
        route(&mut request, PORT, None, None, 2_000).status_code().0,
        503
    );
}
