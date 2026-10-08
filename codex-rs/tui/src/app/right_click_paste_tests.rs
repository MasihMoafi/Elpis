use super::*;
use pretty_assertions::assert_eq;

#[test]
fn policy_preserves_explicit_modes_and_terminal_ownership() {
    use VscodeDetection::Other;
    use VscodeDetection::Unknown;
    use VscodeDetection::VsCode;
    for (platform_default, ssh, wsl, vscode, expected) in [
        (true, false, false, Other, [false, true, true]),
        (false, false, false, Other, [false, true, false]),
        (true, true, false, Other, [false, false, false]),
        (true, false, false, VsCode, [false, false, false]),
        (true, false, true, Unknown, [false, true, false]),
        (true, false, true, Other, [false, true, true]),
    ] {
        let env = PasteEnvironment {
            primary: false,
            platform_default,
            ssh,
            wsl,
            vscode,
        };
        assert_eq!(
            [
                RightClickPaste::Off,
                RightClickPaste::On,
                RightClickPaste::Auto
            ]
            .map(|mode| env.allows(mode)),
            expected
        );
    }
}

#[tokio::test]
async fn pending_primary_paste_survives_release_but_not_other_input() {
    let mut app = crate::app::test_support::make_test_app().await;
    for (kind, keep) in [
        (MouseEventKind::Up(MouseButton::Middle), true),
        (MouseEventKind::Moved, true),
        (MouseEventKind::Down(MouseButton::Middle), true),
        (MouseEventKind::Down(MouseButton::Left), false),
        (MouseEventKind::Up(MouseButton::Right), false),
        (MouseEventKind::ScrollDown, false),
    ] {
        app.pending_right_click_paste = Some(PendingPaste {
            thread: None,
            draft: (String::new(), 0),
            source: PasteSource::Primary,
            by_key: false,
            _request: Arc::new(()),
        });
        app.invalidate_right_click_paste(&TuiEvent::Mouse(MouseEvent {
            kind,
            column: 0,
            row: 0,
            modifiers: crossterm::event::KeyModifiers::NONE,
        }));
        assert_eq!(app.pending_right_click_paste.is_some(), keep);
    }
}

/// Positive: Ctrl+V with no image on the clipboard reads its text for the composer even with
/// right-click paste off, and releasing the keys keeps that read. Negative: a right click with
/// it off reads nothing, and a typed key drops the read.
#[tokio::test]
async fn ctrl_v_pastes_clipboard_text_whatever_the_right_click_setting() -> std::io::Result<()> {
    let mut app = crate::app::test_support::make_test_app().await;
    let mut tui = crate::tui::test_support::make_test_tui()?;
    tui.set_owned_screen(/*owned*/ true)?;
    app.right_click_paste_environment = PasteEnvironment {
        primary: false,
        platform_default: true,
        ssh: false,
        wsl: false,
        vscode: VscodeDetection::Other,
    };
    app.local_settings.tui.right_click_paste = RightClickPaste::Off;

    app.start_right_click_paste(
        &mut tui,
        MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Right),
            column: 0,
            row: 0,
            modifiers: crossterm::event::KeyModifiers::NONE,
        },
    );
    assert!(app.pending_right_click_paste.is_none());

    app.start_key_paste(&mut tui);
    assert!(
        app.pending_right_click_paste
            .as_ref()
            .is_some_and(|p| p.by_key)
    );
    let key = |kind| {
        TuiEvent::Key(crossterm::event::KeyEvent::new_with_kind(
            crossterm::event::KeyCode::Char('v'),
            crossterm::event::KeyModifiers::CONTROL,
            kind,
        ))
    };
    app.invalidate_right_click_paste(&key(crossterm::event::KeyEventKind::Release));
    assert!(app.pending_right_click_paste.is_some());
    app.invalidate_right_click_paste(&key(crossterm::event::KeyEventKind::Press));
    assert!(app.pending_right_click_paste.is_none());
    Ok(())
}
