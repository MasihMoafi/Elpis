//! Colors used by the retained Elpis context controls and Ledger.

use crate::color::is_light;
use crate::terminal_palette::best_color;
use crate::terminal_palette::default_bg;
use crate::terminal_palette::effective_stdout_color_level;
use ratatui::style::Color;
use ratatui::style::Style;

// Gold is the product accent; context categories and
// success/error colors are independent semantic palettes. Use deeper ink on light
// terminal backgrounds. The theme covers only the Elpis wrapper, never transcript colors.
pub(super) const LIGHT_BG_PRIMARY_RGB: (u8, u8, u8) = (146, 112, 0);
pub(super) const DARK_BG_PRIMARY_RGB: (u8, u8, u8) = (235, 198, 75);
pub(crate) const CONTEXT_LIGHT_RGB: (u8, u8, u8) = (110, 125, 0);
pub(crate) const CONTEXT_DARK_RGB: (u8, u8, u8) = (189, 206, 85);
// Rules are lines, not text, so they need 3:1 against the terminal, not 4.5:1.
const LIGHT_BG_RULE_RGB: (u8, u8, u8) = (122, 150, 144);
const DARK_BG_RULE_RGB: (u8, u8, u8) = (78, 122, 114);

/// Returns the shared Elpis style for product titles.
pub(crate) fn brand_style() -> Style {
    primary_style_for(default_bg())
}

/// Solid gold endpoints keep the Ledger title readable even between sweeps.
pub(crate) fn ledger_title_styles() -> (Style, Style) {
    let bg = default_bg();
    (
        text_style_for(bg, LIGHT_BG_PRIMARY_RGB, (212, 168, 0)).not_bold(),
        text_style_for(bg, (104, 76, 0), (246, 205, 43)).not_bold(),
    )
}

/// Olive context heading emphasis, resolved against the terminal's actual background.
pub(crate) fn context_style() -> Style {
    text_style_for(default_bg(), CONTEXT_LIGHT_RGB, CONTEXT_DARK_RGB)
}

/// Teal identifies sections and controls; enabled state uses olive separately.
pub(crate) fn section_style() -> Style {
    text_style_for(default_bg(), (0, 124, 120), (91, 200, 192))
}

/// Pink identifies session names in the footer.
pub(crate) fn session_name_style() -> Style {
    text_style_for(default_bg(), (211, 54, 130), (255, 153, 194))
}

fn text_style_for(bg: Option<(u8, u8, u8)>, light: (u8, u8, u8), dark: (u8, u8, u8)) -> Style {
    Style::default().fg(bg.map_or(Color::Reset, |bg| {
        super::contrast::foreground(
            if is_light(bg) { light } else { dark },
            Some(bg),
            effective_stdout_color_level(),
        )
    }))
}

/// Returns the quiet teal line style for wrapper borders and the Ledger rule.
pub(crate) fn rule_style() -> Style {
    rule_style_for(default_bg())
}

fn primary_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style {
    text_style_for(terminal_bg, LIGHT_BG_PRIMARY_RGB, DARK_BG_PRIMARY_RGB).bold()
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
    use ratatui::style::Modifier;

    #[test]
    fn brand_style_uses_deep_gold_on_light_backgrounds() {
        assert_eq!(
            adaptive_palette_color(
                Some((255, 255, 255)),
                LIGHT_BG_PRIMARY_RGB,
                DARK_BG_PRIMARY_RGB
            ),
            best_color(LIGHT_BG_PRIMARY_RGB),
        );
        let style = primary_style_for(Some((255, 255, 255)));

        assert_eq!(style.fg, Some(best_color(LIGHT_BG_PRIMARY_RGB)));
        assert!(style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn brand_style_uses_bright_gold_on_dark_backgrounds() {
        let expected = Style::default().fg(best_color(DARK_BG_PRIMARY_RGB)).bold();

        assert_eq!(primary_style_for(Some((0, 0, 0))), expected);
    }

    #[test]
    fn unknown_background_preserves_terminal_text_colors() {
        for style in [primary_style_for(None), rule_style_for(None)] {
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
        for background in [(255, 255, 255), (250, 248, 245), (24, 24, 24)] {
            crate::terminal_palette::with_test_default_colors(
                crate::terminal_probe::DefaultColors {
                    fg: (128, 128, 128),
                    bg: background,
                },
                || {
                    let (title_resting, title_peak) = ledger_title_styles();
                    for style in [
                        title_resting,
                        title_peak,
                        brand_style(),
                        context_style(),
                        section_style(),
                        session_name_style(),
                    ] {
                        let Some(Color::Rgb(r, g, b)) = style.fg else {
                            panic!("expected RGB")
                        };
                        let (a, b) = (luminance((r, g, b)), luminance(background));
                        assert!((a.max(b) + 0.05) / (a.min(b) + 0.05) >= 4.5);
                    }
                },
            );
        }
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
