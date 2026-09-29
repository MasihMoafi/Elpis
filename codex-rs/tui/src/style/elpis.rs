//! Elpis palette: the orange product accent, the composer surface and the popup rail.
//!
//! Copied from the Elpis v0.3.0 additions to `style.rs` (tag `stage0-stop-bleeding`);
//! kept in its own file so the upstream `style.rs` carries only a re-export seam.

use crate::color::blend;
use crate::color::is_light;
use crate::terminal_palette::best_color;
use crate::terminal_palette::default_bg;
use ratatui::style::Color;
use ratatui::style::Style;

// Orange is the product accent; context categories and success/error colors are
// independent semantic palettes. Use deeper ink on light terminal backgrounds.
pub(super) const LIGHT_BG_PRIMARY_RGB: (u8, u8, u8) = (150, 100, 0);
pub(super) const DARK_BG_PRIMARY_RGB: (u8, u8, u8) = (220, 151, 32);
const LIGHT_BG_SECONDARY_RGB: (u8, u8, u8) = LIGHT_BG_PRIMARY_RGB;
const DARK_BG_SECONDARY_RGB: (u8, u8, u8) = DARK_BG_PRIMARY_RGB;

pub(crate) fn composer_bg_rgb(bg: (u8, u8, u8)) -> (u8, u8, u8) {
    blend((128, 128, 128), bg, if is_light(bg) { 0.035 } else { 0.06 })
}

pub(crate) fn composer_style() -> Style {
    Style::default().bg(default_bg()
        .map(|bg| best_color(composer_bg_rgb(bg)))
        .unwrap_or(Color::Reset))
}

/// Returns the shared Elpis style for product titles.
pub(crate) fn brand_style() -> Style {
    primary_style_for(default_bg())
}

/// Returns the border style for the focused composer.
pub(crate) fn composer_border_style() -> Style {
    primary_style_for(default_bg())
}

/// Returns the border style for popup surfaces.
pub(crate) fn popup_border_style() -> Style {
    secondary_style_for(default_bg())
}

fn primary_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style {
    Style::default()
        .fg(adaptive_palette_color(
            terminal_bg,
            LIGHT_BG_PRIMARY_RGB,
            DARK_BG_PRIMARY_RGB,
        ))
        .bold()
}

fn secondary_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style {
    Style::default().fg(adaptive_palette_color(
        terminal_bg,
        LIGHT_BG_SECONDARY_RGB,
        DARK_BG_SECONDARY_RGB,
    ))
}

pub(crate) fn adaptive_palette_color(
    terminal_bg: Option<(u8, u8, u8)>,
    light_bg: (u8, u8, u8),
    dark_bg: (u8, u8, u8),
) -> Color {
    terminal_bg.map_or(Color::Reset, |bg| {
        best_color(if is_light(bg) { light_bg } else { dark_bg })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use ratatui::style::Modifier;

    #[test]
    fn brand_style_uses_deep_orange_on_light_backgrounds() {
        assert_eq!(
            adaptive_palette_color(
                Some((255, 255, 255)),
                LIGHT_BG_PRIMARY_RGB,
                DARK_BG_PRIMARY_RGB
            ),
            best_color((150, 100, 0)),
        );
        let style = primary_style_for(Some((255, 255, 255)));

        assert_eq!(style.fg, Some(best_color((150, 100, 0))));
        assert!(style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn brand_style_uses_bright_orange_on_dark_backgrounds() {
        let expected = Style::default().fg(best_color((220, 151, 32))).bold();

        assert_eq!(primary_style_for(Some((0, 0, 0))), expected);
    }

    #[test]
    fn unknown_background_preserves_terminal_text_colors() {
        for style in [primary_style_for(None), secondary_style_for(None)] {
            assert_eq!(style.fg, Some(Color::Reset));
            assert_eq!(style.bg, None);
        }
    }

    #[test]
    fn brand_palette_has_readable_contrast_on_light_and_dark_terminals() {
        fn luminance(rgb: (u8, u8, u8)) -> f64 {
            let linear = |value: u8| {
                let value = f64::from(value) / 255.0;
                if value <= 0.04045 {
                    value / 12.92
                } else {
                    ((value + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * linear(rgb.0) + 0.7152 * linear(rgb.1) + 0.0722 * linear(rgb.2)
        }
        for (background, colors) in [
            (
                (250, 248, 245),
                [LIGHT_BG_PRIMARY_RGB, LIGHT_BG_SECONDARY_RGB],
            ),
            ((24, 24, 24), [DARK_BG_PRIMARY_RGB, DARK_BG_SECONDARY_RGB]),
        ] {
            for color in colors.into_iter().chain((0..32).map(|step| {
                crate::elpis_motion::pigment(f64::from(step) / 32.0, 0.0, is_light(background))
            })) {
                let foreground = luminance(color);
                let background = luminance(background);
                let contrast =
                    (foreground.max(background) + 0.05) / (foreground.min(background) + 0.05);
                assert!(contrast >= 4.5, "{color:?}: contrast {contrast}");
            }
        }
    }
}
