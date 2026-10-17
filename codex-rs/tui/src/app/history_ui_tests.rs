//! Desktop handoff output and clear-screen history reset behavior.

use super::*;
use crate::app::tests::make_test_app_with_channels;
use crate::history_cell;
use crate::history_cell::HistoryCell;
use crate::history_cell::PlainHistoryCell;
use pretty_assertions::assert_eq;

#[test]
fn desktop_thread_opened_history_snapshot() {
    let cell = history_cell::new_info_event(
        DESKTOP_THREAD_OPENED_MESSAGE.to_string(),
        /*hint*/ None,
    );

    insta::assert_snapshot!("desktop_thread_opened_history", render_cell(&cell));
}

#[test]
fn desktop_thread_open_error_history_snapshot() {
    let cell = history_cell::new_error_event(desktop_thread_open_error_message("launch failed"));

    insta::assert_snapshot!("desktop_thread_open_error_history", render_cell(&cell));
}

fn render_cell(cell: &impl HistoryCell) -> String {
    let lines = cell.display_lines(/*width*/ 80);
    lines
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn owned_clear_resets_navigation_and_retains_one_fresh_header() -> Result<()> {
    let (mut app, _rx, _op_rx) = make_test_app_with_channels().await;
    let mut tui = crate::tui::test_support::make_test_tui()?;
    tui.set_owned_screen(/*owned*/ true)?;
    app.insert_history_cell(
        &mut tui,
        Box::new(PlainHistoryCell::new(vec!["old".into()])),
    );
    app.transcript_view
        .jump_to_entry(&app.transcript_cells, /*index*/ 0);
    app.reset_transcript_state_after_clear();
    app.queue_clear_ui_header(&mut tui);
    app.queue_clear_ui_header(&mut tui);

    assert_eq!(app.transcript_cells.len(), 1);
    assert_eq!(
        app.transcript_cells[0].display_lines(/*width*/ 80),
        app.clear_ui_header_lines(/*width*/ 80),
    );
    app.chat_widget.set_raw_output_mode(/*enabled*/ true);
    assert_eq!(
        app.transcript_cells[0].raw_lines(),
        app.clear_ui_header_lines(/*width*/ 80),
    );
    assert!(app.transcript_view.is_following());
    assert!(tui.pending_history_lines_for_test().is_empty());
    tui.set_owned_screen(/*owned*/ false)?;
    Ok(())
}

// Elpis: `/app` on Linux asks the Elpis desktop app (`elpis-app`) to open the chat; a running app keeps its
// one window (Electron's single-instance lock) and opens the chat there.
#[cfg(target_os = "linux")]
#[test]
fn linux_app_handoff_names_the_thread_for_the_elpis_desktop_app() {
    let id = "019a3b2c-1111-7222-8333-444455556666";
    let link = format!("codex://threads/{id}");
    assert_eq!(
        elpis_desktop_command(&link, /*app*/ None),
        Ok((
            std::ffi::OsString::from("elpis-app"),
            vec!["--open-thread".to_string(), id.to_string()]
        ))
    );
    assert_eq!(
        elpis_desktop_command(&link, Some("/opt/Elpis/launch".into())).map(|(app, _)| app),
        Ok(std::ffi::OsString::from("/opt/Elpis/launch"))
    );
    assert!(elpis_desktop_command("https://example.test/threads/x", /*app*/ None).is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn linux_app_handoff_starts_the_app_without_waiting_for_it() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().expect("temporary directory");
    let record = dir.path().join("arguments");
    let app = dir.path().join("elpis-app");
    let path = record.display();
    std::fs::write(
        &app,
        format!("#!/bin/sh\nprintf '%s ' \"$@\" > '{path}.part' && mv '{path}.part' '{path}'\nsleep 3\n"),
    )
    .expect("write the fake app");
    std::fs::set_permissions(&app, std::fs::Permissions::from_mode(0o755)).expect("make it runnable");
    let started = std::time::Instant::now();
    launch_elpis_desktop(
        app.as_os_str(),
        &["--open-thread".to_string(), "chat-1".to_string()],
    )
    .expect("the app starts");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "the TUI must not wait for the app"
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !record.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(
        std::fs::read_to_string(&record).expect("the app ran").trim(),
        "--open-thread chat-1"
    );
    assert!(
        launch_elpis_desktop(dir.path().join("missing").as_os_str(), &[]).is_err(),
        "a missing app is reported"
    );
}
