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

/// A slow start must not look like the Ledger is missing: the startup screen already holds its
/// column, level with where the live Ledger starts, and the composer stops at it.
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
    // The live Ledger starts below the header with a dedicated Close row, then its title.
    assert_eq!(title_row, header_row + 4);
    for y in 0..title_row - 1 {
        assert_eq!(buffer[(rule_x, y)].symbol(), " ", "row {y}");
    }
    for y in title_row - 1..area.height {
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
fn owned_startup_reserves_ledger_close_row() {
    let pump = crate::startup_draft::tests::quiet_startup_test_pump();
    let layout = OwnedStartupLayout::new(&pump);
    let area = Rect::new(0, 0, 120, 30);
    let buffer = rendered(&layout, area);
    let rule_x = area.width - crate::chatwidget::ledger_column_width(area.width);
    let title_y = (0..area.height)
        .find(|&y| row(&buffer, y, rule_x + 1..area.width).contains("CONTEXT LEDGER"))
        .expect("Ledger loading title");
    let header_y = (0..area.height)
        .find(|&y| row(&buffer, y, 0..rule_x).contains(">_ Elpis"))
        .expect("startup header");
    assert_eq!(
        title_y,
        header_y + 4,
        "startup reserves the live owned Close row above its heading"
    );
    assert_eq!(buffer[(rule_x, title_y - 1)].symbol(), "│");
    assert!(
        !row(&buffer, title_y - 1, rule_x + 1..area.width).contains("Close"),
        "startup paints no dead button"
    );
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
