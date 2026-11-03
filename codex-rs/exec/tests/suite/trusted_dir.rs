#![cfg(not(target_os = "windows"))]
#![allow(clippy::unwrap_used)]

use core_test_support::responses;
use core_test_support::test_codex_exec::test_codex_exec;
use predicates::str::contains;

/// A directory that is not a git repository runs only when config.toml marks it trusted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exec_runs_in_a_trusted_directory_that_is_not_a_git_repository() -> anyhow::Result<()> {
    let test = test_codex_exec();
    test.cmd()
        .arg("-C")
        .arg(test.cwd_path())
        .arg("hello")
        .assert()
        .failure()
        .stderr(contains("Not inside a trusted directory"));

    let cwd = test.cwd_path().canonicalize()?;
    std::fs::write(
        test.home_path().join("config.toml"),
        format!("[projects.{:?}]\ntrust_level = \"trusted\"\n", cwd.to_string_lossy()),
    )?;
    let server = responses::start_mock_server().await;
    responses::mount_sse_once(
        &server,
        responses::sse(vec![
            responses::ev_response_created("resp1"),
            responses::ev_assistant_message("m1", "fixture hello"),
            responses::ev_completed("resp1"),
        ]),
    )
    .await;
    test.cmd_with_server(&server)
        .arg("-C")
        .arg(&cwd)
        .arg("-m")
        .arg("gpt-5.1")
        .arg("hello")
        .assert()
        .success();
    Ok(())
}
