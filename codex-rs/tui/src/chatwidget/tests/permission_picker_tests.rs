//! Permission picker presentation and configured navigation, without applying real policies.

use super::*;
use pretty_assertions::assert_eq;
use ratatui::style::Color;

#[tokio::test]
async fn clipped_full_access_confirmation_discloses_hidden_warning_text() {
    let mut snapshots = Vec::new();
    for (specialty, height) in [(None, 10), (Some("cyber"), 16)] {
        let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
        chat.set_feature_enabled(Feature::GuardianApproval, /*enabled*/ false);
        let current_model = chat.current_model().to_owned();
        Arc::make_mut(&mut chat.model_catalog)
            .models
            .iter_mut()
            .find(|model| model.model == current_model)
            .expect("the selected model is in the catalog")
            .model_specialty = specialty.map(str::to_owned);
        let preset = builtin_approval_presets()
            .into_iter()
            .find(|preset| preset.id == "full-access")
            .unwrap();
        chat.open_full_access_confirmation(
            preset, /*return_to_permissions*/ true, /*profile_selection*/ None,
        );

        let area = Rect::new(/*x*/ 0, /*y*/ 0, /*width*/ 40, height);
        let mut buffer = Buffer::empty(area);
        chat.bottom_pane.render(area, &mut buffer);
        let rows = (0..height)
            .map(|y| {
                (0..area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert!(rows.iter().any(|row| row.contains("Yes, continue anyway")));
        assert!(rows.iter().any(|row| row.contains("[…")));
        assert_eq!(rows.last().unwrap().trim(), "enter select · esc back");
        snapshots.push(format!(
            "specialty={specialty:?} 40x{height}\n{}",
            rows.join("\n")
        ));

        let complete = render_bottom_popup(&chat, /*width*/ 40)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!complete.contains("[…"));
        assert!(complete.contains("without your approval"));
        if specialty.is_some() {
            assert!(complete.contains("Cyber models carry a higher risk"));
            assert!(complete.contains("Ask for approval"));
        } else {
            assert!(complete.contains("risk of data loss"));
        }
    }
    assert_chatwidget_snapshot!("clipped_full_access_confirmation", snapshots.join("\n\n"));
}

#[tokio::test]
async fn permission_picker_retry_and_confirmation_follow_configured_bindings() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let mut keymap = crate::keymap::RuntimeKeymap::defaults();
    keymap.list.accept = vec![key_hint::plain(KeyCode::F(/*n*/ 3))];
    keymap.list.cancel = vec![key_hint::plain(KeyCode::F(/*n*/ 2))];
    chat.bottom_pane.set_keymap_bindings(&keymap);
    chat.request_permission_profiles();
    rx.try_recv().unwrap();
    chat.on_permission_profiles_loaded(
        chat.permission_popup_request_id.unwrap(),
        Err("Disconnected".into()),
    );
    let popup = render_bottom_popup(&chat, /*width*/ 40);
    assert_eq!(popup.lines().last().unwrap().trim(), "f3 select · f2 back");
    chat.handle_key_event(KeyEvent::from(KeyCode::F(/*n*/ 3)));
    assert_matches!(rx.try_recv(), Ok(AppEvent::OpenPermissionsPopup));
    let preset = builtin_approval_presets()
        .into_iter()
        .find(|preset| preset.id == "full-access")
        .unwrap();
    chat.open_full_access_confirmation(
        preset, /*return_to_permissions*/ true, /*profile_selection*/ None,
    );
    chat.handle_key_event(KeyEvent::from(KeyCode::Down));
    chat.handle_key_event(KeyEvent::from(KeyCode::F(/*n*/ 3)));
    assert_matches!(rx.try_recv(), Ok(AppEvent::OpenPermissionsPopup));
    assert!(rx.try_recv().is_err(), "cancel must not apply permissions");

    chat.request_permission_profiles();
    rx.try_recv().unwrap();
    chat.handle_key_event(KeyEvent::from(KeyCode::F(/*n*/ 2)));
    assert!(chat.no_modal_or_popup_active());
    assert!(rx.try_recv().is_err());
}

/// Elpis: the rendered rows of the open popup, with each row's cells for style checks.
fn rendered_popup_rows(chat: &ChatWidget, width: u16, height: u16) -> (Vec<String>, Buffer) {
    let area = Rect::new(/*x*/ 0, /*y*/ 0, width, height);
    let mut buffer = Buffer::empty(area);
    chat.bottom_pane.render(area, &mut buffer);
    let rows = (0..height)
        .map(|y| {
            (0..width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect();
    (rows, buffer)
}

/// The foreground of every cell of `text` in the first row that contains it.
fn text_colors(rows: &[String], buffer: &Buffer, text: &str) -> Vec<Option<Color>> {
    let (y, row) = rows
        .iter()
        .enumerate()
        .find(|(_, row)| row.contains(text))
        .unwrap_or_else(|| panic!("{text:?} is rendered"));
    let start = row[..row.find(text).unwrap()].chars().count() as u16;
    (start..start + text.chars().count() as u16)
        .map(|x| buffer[(x, y as u16)].style().fg)
        .collect()
}

const TEST_COLORS: crate::terminal_probe::DefaultColors = crate::terminal_probe::DefaultColors {
    fg: (220, 220, 220),
    bg: (20, 20, 20),
};

#[tokio::test]
async fn bypass_permissions_is_offered_in_red_right_after_full_access() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.config.explicit_permission_profile_mode = true;
    chat.set_feature_enabled(Feature::GuardianApproval, /*enabled*/ false);

    let (rows, buffer) = crate::terminal_palette::with_test_default_colors(TEST_COLORS, || {
        chat.open_permission_profiles_popup(
            crate::permission_discovery::PermissionDiscovery::local(&chat.config),
        );
        rendered_popup_rows(&chat, /*width*/ 80, /*height*/ 20)
    });

    let position = |label: &str| {
        rows.iter()
            .position(|row| row.contains(label))
            .unwrap_or_else(|| panic!("{label:?} is offered"))
    };
    assert!(position("Full Access") < position("Bypass permissions"));
    assert!(position("Bypass permissions") < position("Read Only"));
    assert!(
        text_colors(&rows, &buffer, "Bypass permissions")
            .iter()
            .all(|color| *color == Some(Color::Red)),
        "the Bypass row is red"
    );
    assert!(
        text_colors(&rows, &buffer, "Full Access")
            .iter()
            .all(|color| *color != Some(Color::Red)),
        "only Bypass is red"
    );
    assert_chatwidget_snapshot!("bypass_permissions_picker_row", rows.join("\n"));
}

#[tokio::test]
async fn choosing_bypass_permissions_asks_once_and_defaults_to_cancel() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.config.explicit_permission_profile_mode = true;
    chat.set_feature_enabled(Feature::GuardianApproval, /*enabled*/ false);
    // Hiding the Full Access warning does not hide this one.
    chat.local_settings.notices.hide_full_access_warning = Some(true);
    let bypass = builtin_approval_presets()
        .into_iter()
        .find(|preset| preset.id == "bypass-permissions")
        .expect("bypass preset");

    // Picking the row never applies it directly: it asks first.
    chat.open_permission_profiles_popup(crate::permission_discovery::PermissionDiscovery::local(
        &chat.config,
    ));
    chat.handle_key_event(KeyEvent::from(KeyCode::Char('3')));
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    let [
        AppEvent::OpenFullAccessConfirmation {
            preset,
            return_to_permissions: true,
            profile_selection: Some(selection),
        },
    ] = events.as_slice()
    else {
        panic!("expected one confirmation request, got {events:?}");
    };
    assert_eq!(preset.id, "bypass-permissions");
    assert_eq!(
        (
            selection.profile_id.as_str(),
            selection.approval_policy,
            selection.approvals_reviewer
        ),
        (
            ":bypass-permissions",
            Some(AskForApproval::Never),
            Some(ApprovalsReviewer::User)
        )
    );

    // The question is red and says plainly what happens; Enter alone cancels.
    let (rows, buffer) = crate::terminal_palette::with_test_default_colors(TEST_COLORS, || {
        chat.open_full_access_confirmation(
            bypass.clone(),
            /*return_to_permissions*/ true,
            Some(selection.clone()),
        );
        rendered_popup_rows(&chat, /*width*/ 80, /*height*/ 16)
    });
    assert!(
        text_colors(&rows, &buffer, "Enable Bypass permissions?")
            .iter()
            .all(|color| *color == Some(Color::Red))
    );
    let complete = rows
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(complete.contains("Elpis will run anything without asking"));
    assert_chatwidget_snapshot!("bypass_permissions_confirmation", rows.join("\n"));
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
    assert_matches!(rx.try_recv(), Ok(AppEvent::OpenPermissionsPopup));
    assert!(rx.try_recv().is_err(), "cancel must not apply permissions");

    // Confirming applies exactly the bypass selection.
    chat.open_full_access_confirmation(
        bypass,
        /*return_to_permissions*/ true,
        Some(selection.clone()),
    );
    chat.handle_key_event(KeyEvent::from(KeyCode::Down));
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::SelectPermissionProfile(applied))
            if applied.profile_id == selection.profile_id
                && applied.approval_policy == selection.approval_policy
                && applied.approvals_reviewer == selection.approvals_reviewer
    );
}
