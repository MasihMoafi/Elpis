//! Verify provisional composer geometry while startup owns the terminal.

use super::*;

#[test]
fn owned_startup_keeps_the_live_bottom_geometry() {
    let mut pump = crate::startup_draft::tests::quiet_startup_test_pump();
    pump.bottom_pane.set_status_line_enabled(/*enabled*/ true);
    pump.bottom_pane
        .set_composer_text("first line\nsecond line".into(), Vec::new(), Vec::new());
    pump.bottom_pane.set_footer_hint_override(Some(vec![
        ("Waiting for startup".into(), String::new()),
        ("esc".into(), "cancel".into()),
    ]));
    let layout = OwnedStartupLayout::new(&pump);
    let area = Rect::new(
        /*x*/ 0, /*y*/ 0, /*width*/ 48, /*height*/ 16,
    );
    let mut buffer = Buffer::empty(area);
    layout.render(area, &mut buffer);
    let frame = (area.y..area.bottom())
        .map(|y| {
            (area.x..area.right())
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    insta::assert_snapshot!(
        "owned_startup_layout",
        format!("cursor={:?}\n{frame}", layout.cursor_pos(area))
            .replace(crate::version::CODEX_CLI_VERSION, "<VERSION>")
            // Elpis: the header shows the Elpis release.
            .replace(crate::branding::ELPIS_VERSION, "<VERSION>")
    );
}

fn rendered(layout: &OwnedStartupLayout<'_>, area: Rect) -> Buffer {
    let mut buffer = Buffer::empty(area);
    layout.render(area, &mut buffer);
    buffer
}

fn row(buffer: &Buffer, y: u16, columns: std::ops::Range<u16>) -> String {
    columns.map(|x| buffer[(x, y)].symbol()).collect()
}

/// A slow start holds the same top-right Ledger column as the live screen, beside the composer.
#[test]
fn owned_startup_shows_the_ledger_column_beside_the_composer() {
    let pump = crate::startup_draft::tests::quiet_startup_test_pump();
    let layout = OwnedStartupLayout::new(&pump);
    let area = Rect::new(
        /*x*/ 0, /*y*/ 0, /*width*/ 120, /*height*/ 30,
    );
    let buffer = rendered(&layout, area);
    let ledger_width = crate::chatwidget::ledger_column_width(area.width);
    assert!(ledger_width > 0, "a 120-column terminal has the Ledger");
    let rule_x = area.width - ledger_width;
    let title_row = (0..area.height)
        .find(|&y| row(&buffer, y, rule_x + 1..area.width).contains("CONTEXT LEDGER"))
        .expect("the startup screen names the Ledger");
    let header_row = (0..area.height)
        .find(|&y| row(&buffer, y, 0..rule_x).contains(">_ Elpis"))
        .expect("the header stays");
    assert_eq!(title_row, 1, "the Ledger title stays below its switch");
    assert_eq!(
        header_row, 1,
        "the conversation header keeps its own margin"
    );
    for y in 0..area.height {
        assert_eq!(buffer[(rule_x, y)].symbol(), "│", "row {y}");
    }
    let composer_rows = |columns: std::ops::Range<u16>| {
        (0..area.height)
            .filter(|&y| row(&buffer, y, columns.clone()).contains("Ask Elpis"))
            .count()
    };
    assert_eq!(composer_rows(0..rule_x), 1);
    assert_eq!(composer_rows(rule_x..area.width), 0);
}

#[test]
fn owned_startup_ledger_keeps_the_switch_on_the_title_row_at_each_size() {
    let pump = crate::startup_draft::tests::quiet_startup_test_pump();
    let layout = OwnedStartupLayout::new(&pump);
    for width in [80, 120, 200] {
        for height in [0, 1, 2, 3, 6, 24, 40, 60] {
            let buffer = rendered(&layout, Rect::new(0, 0, width, height));
            let rule_x = width - crate::chatwidget::ledger_column_width(width);
            if height > 0 {
                assert_eq!(row(&buffer, 0, rule_x + 1..width).trim(), "");
            }
            if height > 1 {
                let title = row(&buffer, 1, rule_x + 1..width);
                assert!(title.contains("CONTEXT LEDGER  co"), "{title}");
                assert!(title.trim_end().ends_with("[━━━●] ON"), "{title}");
            }
            assert!((0..height).all(|y| !row(&buffer, y, rule_x..width).contains(['×', '╳'])));
        }
    }
}

#[test]
fn owned_startup_has_no_ledger_column_on_a_narrow_terminal() {
    let pump = crate::startup_draft::tests::quiet_startup_test_pump();
    let layout = OwnedStartupLayout::new(&pump);
    let area = Rect::new(
        /*x*/ 0, /*y*/ 0, /*width*/ 79, /*height*/ 30,
    );
    let buffer = rendered(&layout, area);
    assert!(
        (0..area.height).all(|y| !row(&buffer, y, 0..area.width).contains("CONTEXT LEDGER")),
        "below 80 columns the live Ledger is hidden too"
    );
}

#[tokio::test]
async fn owned_startup_ledger_uses_the_saved_width() -> anyhow::Result<()> {
    let home = tempfile::tempdir()?;
    std::fs::write(
        home.path().join("config.toml"),
        "[tui]\ncontext_ledger_width = 65\n",
    )?;
    let config = crate::legacy_core::config::ConfigBuilder::default()
        .codex_home(home.path().to_path_buf())
        .loader_overrides(
            crate::legacy_core::config::LoaderOverrides::without_managed_config_for_tests(),
        )
        .build()
        .await?;
    let settings = crate::local_settings::LocalSettings::from(&config);
    let mut pump = crate::startup_draft::tests::quiet_startup_test_pump();
    pump.apply_settings(&settings, config.cwd.as_path());
    let layout = OwnedStartupLayout::new(&pump);
    let area = Rect::new(0, 0, 125, 40);
    let buffer = rendered(&layout, area);
    let title_row = (0..area.height)
        .find(|&y| row(&buffer, y, 60..125).contains("CONTEXT LEDGER"))
        .expect("the startup Ledger title");
    assert_eq!(buffer[(60, title_row)].symbol(), "│");
    Ok(())
}
