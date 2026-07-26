// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use crate::color::blend;
use crate::color::is_light;
use crate::terminal_palette::StdoutColorLevel;
use crate::terminal_palette::best_color;
use crate::terminal_palette::default_bg;
use crate::terminal_palette::default_fg;
use crate::terminal_palette::rgb_color;
use crate::terminal_palette::stdout_color_level;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::style::Stylize;

const LIGHT_BG_PRIMARY_RGB: (u8, u8, u8) = (0, 111, 133);
const DARK_BG_PRIMARY_RGB: (u8, u8, u8) = (70, 220, 242);
const LIGHT_BG_SECONDARY_RGB: (u8, u8, u8) = (0, 130, 153);
const DARK_BG_SECONDARY_RGB: (u8, u8, u8) = (120, 230, 248);
const LIGHT_BG_STATUS_RGB: (u8, u8, u8) = (0, 98, 120);
const DARK_BG_STATUS_RGB: (u8, u8, u8) = (100, 222, 242);
// Decorative table rules should remain visible without competing with cell content.
const TABLE_SEPARATOR_FG_ALPHA: f32 = 0.20;

pub fn user_message_style() -> Style {
    user_message_style_for(default_bg())
}

pub fn proposed_plan_style() -> Style {
    proposed_plan_style_for(default_bg())
}

/// Returns a low-contrast rule style for separators within markdown tables.
pub(crate) fn table_separator_style() -> Style {
    table_separator_style_for(default_fg(), default_bg(), stdout_color_level())
}

/// Returns the shared accent style for active or selected TUI controls.
pub(crate) fn accent_style() -> Style {
    accent_style_for(default_bg())
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

/// Returns the Elpis cyan used for meaningful status symbols.
pub(crate) fn status_symbol_style() -> Style {
    status_style_for(default_bg())
}

/// Returns the style for a user-authored message using the provided terminal background.
pub fn user_message_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style {
    match terminal_bg {
        Some(bg) => Style::default().bg(user_message_bg(bg)),
        None => Style::default(),
    }
}

pub fn proposed_plan_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style {
    match terminal_bg {
        Some(bg) => Style::default().bg(proposed_plan_bg(bg)),
        None => Style::default(),
    }
}

/// Returns the shared accent style for the provided terminal background.
pub(crate) fn accent_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style {
    primary_style_for(terminal_bg)
}

fn primary_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style {
    Style::default()
        .fg(best_color(adaptive_palette_color(
            terminal_bg,
            LIGHT_BG_PRIMARY_RGB,
            DARK_BG_PRIMARY_RGB,
        )))
        .bold()
}

fn secondary_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style {
    Style::default().fg(best_color(adaptive_palette_color(
        terminal_bg,
        LIGHT_BG_SECONDARY_RGB,
        DARK_BG_SECONDARY_RGB,
    )))
}

fn status_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style {
    Style::default().fg(best_color(adaptive_palette_color(
        terminal_bg,
        LIGHT_BG_STATUS_RGB,
        DARK_BG_STATUS_RGB,
    )))
}

fn adaptive_palette_color(
    terminal_bg: Option<(u8, u8, u8)>,
    light_bg: (u8, u8, u8),
    dark_bg: (u8, u8, u8),
) -> (u8, u8, u8) {
    if terminal_bg.is_some_and(is_light) {
        light_bg
    } else {
        dark_bg
    }
}

fn table_separator_style_for(
    terminal_fg: Option<(u8, u8, u8)>,
    terminal_bg: Option<(u8, u8, u8)>,
    color_level: StdoutColorLevel,
) -> Style {
    let (Some(fg), Some(bg)) = (terminal_fg, terminal_bg) else {
        return Style::default().dim();
    };
    let separator_rgb = blend(fg, bg, TABLE_SEPARATOR_FG_ALPHA);
    match color_level {
        StdoutColorLevel::TrueColor => Style::default().fg(rgb_color(separator_rgb)),
        StdoutColorLevel::Ansi256 => Style::default().fg(best_color(separator_rgb)),
        StdoutColorLevel::Ansi16 | StdoutColorLevel::Unknown => Style::default().dim(),
    }
}

#[allow(clippy::disallowed_methods)]
pub fn user_message_bg(terminal_bg: (u8, u8, u8)) -> Color {
    let (top, alpha) = if is_light(terminal_bg) {
        (LIGHT_BG_PRIMARY_RGB, 0.06)
    } else {
        (DARK_BG_PRIMARY_RGB, 0.12)
    };
    best_color(blend(top, terminal_bg, alpha))
}

#[allow(clippy::disallowed_methods)]
pub fn proposed_plan_bg(terminal_bg: (u8, u8, u8)) -> Color {
    user_message_bg(terminal_bg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use ratatui::style::Modifier;

    #[test]
    fn accent_style_uses_darker_cyan_on_light_backgrounds() {
        let style = accent_style_for(Some((255, 255, 255)));

        assert_eq!(style.fg, Some(best_color(LIGHT_BG_PRIMARY_RGB)));
        assert!(style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn accent_style_uses_cyan_on_dark_or_unknown_backgrounds() {
        let expected = Style::default().fg(best_color(DARK_BG_PRIMARY_RGB)).bold();

        assert_eq!(accent_style_for(Some((0, 0, 0))), expected);
        assert_eq!(accent_style_for(/*terminal_bg*/ None), expected);
    }

    #[test]
    fn table_separator_blends_toward_dark_background() {
        let style = table_separator_style_for(
            Some((255, 255, 255)),
            Some((0, 0, 0)),
            StdoutColorLevel::TrueColor,
        );

        assert_eq!(style.fg, Some(rgb_color((51, 51, 51))));
    }

    #[test]
    fn table_separator_blends_toward_light_background() {
        let style = table_separator_style_for(
            Some((0, 0, 0)),
            Some((255, 255, 255)),
            StdoutColorLevel::TrueColor,
        );

        assert_eq!(style.fg, Some(rgb_color((204, 204, 204))));
    }

    #[test]
    fn table_separator_dims_when_palette_aware_color_is_unavailable() {
        let expected = Style::default().dim();

        assert_eq!(
            table_separator_style_for(
                Some((255, 255, 255)),
                Some((0, 0, 0)),
                StdoutColorLevel::Ansi16,
            ),
            expected
        );
        assert_eq!(
            table_separator_style_for(
                /*terminal_fg*/ None,
                Some((0, 0, 0)),
                StdoutColorLevel::TrueColor,
            ),
            expected
        );
    }
}
