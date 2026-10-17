//! Elpis product names for titles the TUI draws.
//!
//! Copied from Elpis v0.3.0 `branding.rs` (tag `stage0-stop-bleeding`), names only. The
//! runtime-identity status line there was never visible (v0.3.0 forced the footer status
//! line off) and is not carried.

pub(crate) const PRODUCT_NAME: &str = "Elpis";
pub(crate) const CODEX_RUNTIME_TITLE: &str = "Elpis";
pub(crate) const WORKING_LABEL: &str = "Elpising";

/// The Elpis release, as `elpis --version` prints it. The vendored crates keep Codex's
/// version (0.158.0) because the model catalog keys on it.
pub(crate) const ELPIS_VERSION: &str = "0.4.1";

/// Amber on dark terminals, and deeper Aurora tones on light terminals.
pub(crate) fn wordmark_palette(background: Option<(u8, u8, u8)>) -> [(u8, u8, u8); 5] {
    let light = background.is_some_and(|(r, g, b)| {
        u32::from(r) * 299 + u32::from(g) * 587 + u32::from(b) * 114 > 128_000
    });
    if light {
        [
            (123, 92, 22),
            (69, 118, 71),
            (37, 113, 89),
            (25, 113, 101),
            (18, 107, 110),
        ]
    } else {
        [
            (217, 121, 19),
            (242, 166, 38),
            (255, 212, 90),
            (255, 231, 134),
            (255, 215, 94),
        ]
    }
}

/// Move the same five colors through the wordmark over a three-second loop.
pub(crate) fn wordmark_palette_at(
    background: Option<(u8, u8, u8)>,
    millis: u128,
) -> [(u8, u8, u8); 5] {
    let palette = wordmark_palette(background);
    let phase = (millis % 3_000) as usize;
    let step = phase / 600;
    let blend = (phase % 600) as u32;
    std::array::from_fn(|index| {
        let from = palette[(index + step) % palette.len()];
        let to = palette[(index + step + 1) % palette.len()];
        let channel =
            |a: u8, b: u8| ((u32::from(a) * (600 - blend) + u32::from(b) * blend) / 600) as u8;
        (
            channel(from.0, to.0),
            channel(from.1, to.1),
            channel(from.2, to.2),
        )
    })
}

/// The version a title shows: the Elpis release in place of the vendored Codex version.
pub(crate) fn title_version(version: &'static str) -> &'static str {
    if version == crate::version::CODEX_CLI_VERSION {
        ELPIS_VERSION
    } else {
        version
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wordmark_moves_and_repeats_without_changing_its_palette() {
        for background in [None, Some((255, 255, 255))] {
            let start = wordmark_palette_at(background, 0);
            assert_eq!(start, wordmark_palette(background));
            assert_ne!(start, wordmark_palette_at(background, 300));
            assert_eq!(start, wordmark_palette_at(background, 3_000));
            assert_eq!(wordmark_palette_at(background, 600)[0], start[1]);
        }
    }

    #[test]
    fn wordmark_follows_terminal_background_and_defaults_to_amber() {
        let dark = wordmark_palette(Some((11, 14, 12)));
        let light = wordmark_palette(Some((244, 247, 244)));
        assert_eq!(wordmark_palette(None), dark);
        assert_ne!(light, dark);
        assert!(dark.iter().all(|(r, g, _)| r >= g));
        assert!(light.iter().skip(1).all(|(r, g, _)| g > r));
    }

    #[test]
    fn titles_show_the_elpis_release_the_cli_reports() {
        let cli_manifest = include_str!("../../cli/Cargo.toml");
        assert!(
            cli_manifest.contains(&format!("version = \"{ELPIS_VERSION}\"")),
            "ELPIS_VERSION must match codex-rs/cli/Cargo.toml"
        );
        assert_eq!(
            title_version(crate::version::CODEX_CLI_VERSION),
            ELPIS_VERSION
        );
        assert_eq!(title_version("test"), "test");
    }
}
