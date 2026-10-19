//! Preferences must reach the model, including edits made after the chat starts.
use anyhow::Result;
use codex_core::config::Config;
use codex_extension_api::ExtensionRegistryBuilder;
use core_test_support::responses::ev_completed;
use core_test_support::responses::ev_response_created;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::responses::start_mock_server;
use core_test_support::test_codex::test_codex;
use std::sync::Arc;
use tempfile::TempDir;

const HABIT: &str = "PERSONAL_WORKING_HABIT_7319";
const EDITED: &str = "PERSONAL_EDITED_HABIT_7319";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn elpis_personal_reaches_requests_and_refreshes_without_duplicates() -> Result<()> {
    let server = start_mock_server().await;
    let responses = (0..3)
        .map(|i| {
            let id = format!("personal-{i}");
            sse(vec![ev_response_created(&id), ev_completed(&id)])
        })
        .collect();
    let requests = mount_sse_sequence(&server, responses).await;
    let home = Arc::new(TempDir::new()?);
    let mut registry = ExtensionRegistryBuilder::<Config>::new();
    codex_core::elpis_personal::install(&mut registry);
    let mut builder = test_codex()
        .with_home(home.clone())
        .with_extensions(Arc::new(registry.build()));
    let test = builder.build(&server).await?;
    test.submit_turn("before profile creation").await?;
    let (path, _) = codex_skills::personal::open(home.path())?;
    std::fs::write(
        &path,
        format!("{}\nHabit: {HABIT}\n", codex_skills::personal::TEMPLATE),
    )?;
    test.submit_turn("after profile creation").await?;
    std::fs::write(
        &path,
        format!("{}\nHabit: {EDITED}\n", codex_skills::personal::TEMPLATE),
    )?;
    test.submit_turn("after editing profile").await?;
    let counts = requests
        .requests()
        .iter()
        .map(|request| {
            let input = request.body_json().to_string();
            (input.matches(HABIT).count(), input.matches(EDITED).count())
        })
        .collect::<Vec<_>>();
    assert_eq!(counts, vec![(0, 0), (1, 0), (0, 1)]);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn elpis_personal_is_absent_from_requests_when_extension_is_disabled() -> Result<()> {
    let server = start_mock_server().await;
    let requests = mount_sse_sequence(
        &server,
        vec![sse(vec![
            ev_response_created("disabled"),
            ev_completed("disabled"),
        ])],
    )
    .await;
    let home = Arc::new(TempDir::new()?);
    let (path, _) = codex_skills::personal::open(home.path())?;
    std::fs::write(
        path,
        format!("{}\nHabit: {HABIT}\n", codex_skills::personal::TEMPLATE),
    )?;
    let mut builder = test_codex()
        .with_home(home)
        .with_extensions(Arc::new(ExtensionRegistryBuilder::<Config>::new().build()));
    let test = builder.build(&server).await?;
    test.submit_turn("without the personal extension").await?;
    assert!(
        !requests.requests()[0]
            .body_json()
            .to_string()
            .contains(HABIT)
    );
    Ok(())
}
