//! Orange-to-yellow motion composed with TachyonFX. Never paint over draft text.
use crate::color::{blend, is_light};
use crate::terminal_palette::{best_color, default_bg};
use ratatui::{buffer::Buffer, layout::Rect, style::Style, text::Span};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub(crate) const FRAME_TICK: Duration = Duration::from_millis(125);

pub(crate) fn elapsed() -> Duration {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed()
}

pub(crate) fn pigment(position: f64, seconds: f64, light: bool) -> (u8, u8, u8) {
    let colors = if light {
        [(160, 95, 0), (133, 108, 0), (150, 100, 0)]
    } else {
        [(220, 139, 32), (230, 179, 52), (208, 174, 49)]
    };
    let offset = (position + seconds / 24.0).rem_euclid(1.0) * 3.0;
    let index = offset.floor() as usize;
    let mix = tachyonfx::Interpolation::SineInOut.alpha(offset.fract() as f32);
    blend(colors[(index + 1) % 3], colors[index], mix)
}

pub(crate) fn accent_style() -> Style {
    Style::default().fg(best_color(pigment(
        0.35,
        0.0,
        default_bg().is_some_and(is_light),
    )))
}

pub(crate) fn text(text: &str) -> Vec<Span<'static>> {
    gradient_text_at(text, Duration::ZERO)
}

pub(crate) fn animated_text(text: &str, animated: bool) -> Vec<Span<'static>> {
    gradient_text_at(text, if animated { elapsed() } else { Duration::ZERO })
}

fn gradient_text_at(text: &str, time: Duration) -> Vec<Span<'static>> {
    let count = text.chars().count().max(1) as f64;
    let light = default_bg().is_some_and(is_light);
    text.chars()
        .enumerate()
        .map(|(index, ch)| {
            Span::styled(
                ch.to_string(),
                Style::default().fg(best_color(pigment(
                    index as f64 / count * 0.75,
                    time.as_secs_f64(),
                    light,
                ))),
            )
        })
        .collect()
}

pub(crate) fn paint_frame(area: Rect, buf: &mut Buffer, time: Duration, animated: bool) {
    let area = area.intersection(buf.area);
    if area.width < 3 || area.height < 3 {
        return;
    }
    let seconds = if animated { time.as_secs_f64() } else { 0.0 };
    let light = default_bg().is_some_and(is_light);
    let width = area.width - 1;
    let height = area.height - 1;
    for y in 0..=height {
        for x in 0..=width {
            if x != 0 && x != width && y != 0 && y != height {
                continue;
            }
            buf[(area.x + x, area.y + y)]
                .set_symbol(if x == 0 { "│" } else { " " })
                .set_style(Style::default().remove_modifier(ratatui::style::Modifier::BOLD))
                .set_fg(best_color(pigment(
                    f64::from(y) / f64::from(height),
                    seconds * (24.0 / 5.6),
                    light,
                )));
        }
    }
}

/// The selected Quiet Rail wash fades into the terminal background without
/// changing draft text, selection colors, or activity effects.
pub(crate) fn paint_surface(area: Rect, buf: &mut Buffer) {
    let Some(background) = default_bg() else {
        return;
    };
    let area = area.intersection(buf.area);
    let base = crate::style::composer_style()
        .bg
        .unwrap_or(ratatui::style::Color::Reset);
    let wash = if is_light(background) {
        (238, 232, 216)
    } else {
        (33, 31, 25)
    };
    for y in area.y..area.bottom() {
        for x in area.x..area.right() {
            let cell = &mut buf[(x, y)];
            if cell.bg != base && cell.bg != ratatui::style::Color::Reset {
                continue;
            }
            let amount = 1.0
                - tachyonfx::Interpolation::SineInOut
                    .alpha(f32::from(x - area.x) / f32::from(area.width.saturating_sub(1).max(1)));
            cell.set_bg(best_color(blend(wash, background, amount)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_gradient_preserves_draft_styles_selection_and_neighbors() {
        crate::terminal_palette::with_test_default_colors(
            crate::terminal_probe::DefaultColors {
                fg: (222, 222, 219),
                bg: (17, 18, 20),
            },
            || {
                let mut buf = Buffer::empty(Rect::new(0, 0, 30, 5));
                buf.set_string(
                    2,
                    2,
                    "Keep my draft",
                    Style::default().fg(ratatui::style::Color::White),
                );
                buf[(3, 2)].set_bg(ratatui::style::Color::Blue);
                let original = buf.clone();
                paint_surface(Rect::new(0, 1, 25, 3), &mut buf);
                assert_ne!(buf[(0, 1)].bg, buf[(24, 1)].bg);
                assert_eq!(buf[(3, 2)], original[(3, 2)]);
                for (before, after) in original.content.iter().zip(&buf.content) {
                    assert_eq!(before.symbol(), after.symbol());
                    assert_eq!(before.fg, after.fg);
                    assert_eq!(before.modifier, after.modifier);
                }
                assert_eq!(buf[(29, 4)], original[(29, 4)]);
            },
        );
    }
    #[test]
    fn animated_labels_change_color_without_changing_text() {
        let first = gradient_text_at("Read Search Full access", Duration::ZERO);
        let later = gradient_text_at("Read Search Full access", Duration::from_secs(8));
        assert_ne!(pigment(0.0, 0.0, false), pigment(0.0, 8.0, false));
        assert_eq!(
            first.iter().map(|s| s.content.as_ref()).collect::<String>(),
            later.iter().map(|s| s.content.as_ref()).collect::<String>()
        );
        assert_eq!(animated_text("Elpis", false), text("Elpis"));
    }
    #[test]
    fn gradient_moves_gently_and_reduced_motion_is_static() {
        let area = Rect::new(0, 0, 30, 5);
        let mut original = Buffer::empty(area);
        original[(8, 2)].set_symbol("文");
        let mut first = original.clone();
        let mut later = original.clone();
        paint_frame(area, &mut first, Duration::ZERO, true);
        paint_frame(area, &mut later, Duration::from_secs(8), true);
        assert_ne!(pigment(0.2, 0.0, false), pigment(0.2, 8.0, false));
        assert_eq!(first[(8, 2)], original[(8, 2)]);
        paint_frame(area, &mut later, Duration::from_secs(8), false);
        assert_eq!(first, later);
        for light in [false, true] {
            let a = pigment(0.2, 0.0, light);
            let b = pigment(0.2, FRAME_TICK.as_secs_f64(), light);
            assert!(a.0.abs_diff(b.0) <= 2 && a.1.abs_diff(b.1) <= 2 && a.2.abs_diff(b.2) <= 2);
        }
    }
}
