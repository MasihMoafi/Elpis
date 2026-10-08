//! Elpis palette: the composer surface and the quiet teal rules around the composer, popups
//! and the Context Ledger. Product titles are bold in the terminal's own text color. Teal switch
//! colors live with the Ledger (`smart_prune_on_colors`).
//!
//! Copied from the Elpis v0.3.0 additions to `style.rs` (tag `stage0-stop-bleeding`);
//! kept in its own file so the upstream `style.rs` carries only a re-export seam.

use crate::color::blend;
use crate::color::is_light;
use crate::terminal_palette::best_color;
use crate::terminal_palette::default_bg;
use ratatui::style::Color;
use ratatui::style::Style;

// Rules are lines, not text, so they need 3:1 against the terminal, not 4.5:1.
const LIGHT_BG_RULE_RGB: (u8, u8, u8) = (122, 150, 144);
const DARK_BG_RULE_RGB: (u8, u8, u8) = (78, 122, 114);

pub(crate) fn composer_bg_rgb(bg: (u8, u8, u8)) -> (u8, u8, u8) {
    blend((128, 128, 128), bg, if is_light(bg) { 0.035 } else { 0.06 })
}

pub(crate) fn composer_style() -> Style {
    Style::default().bg(default_bg()
        .map(|bg| best_color(composer_bg_rgb(bg)))
        .unwrap_or(Color::Reset))
}

/// Returns the shared Elpis style for product titles: bold, in the terminal's own text color.
pub(crate) fn brand_style() -> Style {
    Style::default().bold()
}

/// Returns the border style for the focused composer.
pub(crate) fn composer_border_style() -> Style {
    rule_style()
}

/// Returns the border style for popup surfaces.
pub(crate) fn popup_border_style() -> Style {
    rule_style()
}

/// Returns the quiet teal line style for wrapper borders and the Ledger rule.
pub(crate) fn rule_style() -> Style {
    rule_style_for(default_bg())
}

fn rule_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style {
    Style::default().fg(adaptive_palette_color(
        terminal_bg,
        LIGHT_BG_RULE_RGB,
        DARK_BG_RULE_RGB,
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

    #[test]
    fn unknown_background_preserves_terminal_text_colors() {
        let style = rule_style_for(None);
        assert_eq!(style.fg, Some(Color::Reset));
        assert_eq!(style.bg, None);
    }

    #[test]
    fn rules_are_visible_lines_on_light_and_dark_terminals() {
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
        for (background, rule) in [
            ((255, 255, 255), LIGHT_BG_RULE_RGB),
            ((24, 24, 24), DARK_BG_RULE_RGB),
        ] {
            let (a, b) = (luminance(rule), luminance(background));
            let contrast = (a.max(b) + 0.05) / (a.min(b) + 0.05);
            assert!(contrast >= 3.0, "{rule:?}: contrast {contrast}");
            assert!(
                contrast < 4.5,
                "{rule:?}: a rule must stay quieter than text"
            );
        }
    }
}
