//! Color effects for the retained Context Ledger.

use crate::color::{blend, is_light};
use crate::terminal_palette::{best_color, default_bg};
use ratatui::{style::Style, text::Span};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// One complete pass of the highlight, from just before the first glyph to
/// just past the last.
const SWEEP: Duration = Duration::from_millis(800);

/// TachyonFX's `Interpolation::SineInOut`, the same curve v0.3.0 used.
fn sine_in_out(t: f32) -> f32 {
    -((std::f32::consts::PI * t).cos() - 1.0) / 2.0
}

pub(crate) fn elapsed() -> Duration {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed()
}

/// How much faster the Elpis motion runs than the rates it was first tuned at.
/// The shimmer and the colour drift keep their shape; they just move.
const SPEED: f64 = 3.0;

pub(crate) fn pigment(position: f64, seconds: f64, light: bool) -> (u8, u8, u8) {
    // The Deus Ex gold family (style/elpis.rs); deeper ink on light terminals.
    let colors = if light {
        [(128, 88, 10), (104, 72, 4), (140, 96, 12)]
    } else {
        [(229, 187, 104), (255, 226, 160), (214, 170, 90)]
    };
    let offset = (position + seconds * SPEED / 24.0).rem_euclid(1.0) * 3.0;
    let index = offset.floor() as usize;
    let mix = sine_in_out(offset.fract() as f32);
    blend(colors[(index + 1) % 3], colors[index], mix)
}

pub(crate) fn accent_style() -> Style {
    let Some(background) = default_bg() else {
        return Style::default().fg(ratatui::style::Color::Reset);
    };
    Style::default().fg(best_color(pigment(0.35, 0.0, is_light(background))))
}

pub(crate) fn text(text: &str) -> Vec<Span<'static>> {
    gradient_text_at(text, Duration::ZERO)
}

pub(crate) fn animated_text(text: &str, animated: bool) -> Vec<Span<'static>> {
    gradient_text_at(text, if animated { elapsed() } else { Duration::ZERO })
}

fn gradient_text_at(text: &str, time: Duration) -> Vec<Span<'static>> {
    let Some(background) = default_bg() else {
        return text
            .graphemes(true)
            .map(|glyph| {
                Span::styled(
                    glyph.to_owned(),
                    Style::default().fg(ratatui::style::Color::Reset),
                )
            })
            .collect();
    };
    let width = text.width().max(1) as f64;
    let light = is_light(background);
    let half_width = (width * 0.1).max(3.0);
    let sweep = SWEEP.as_secs_f64();
    let position = (time.as_secs_f64() % sweep) / sweep * (width + 2.0 * half_width) - half_width;
    let mut column = 0.0;
    text.graphemes(true)
        .map(|glyph| {
            let center = column + glyph.width() as f64 / 2.0;
            column += glyph.width() as f64;
            let distance = ((center - position).abs() / half_width).min(1.0);
            let intensity = 0.425 * (1.0 + (std::f64::consts::PI * distance).cos());
            let base = pigment(center / width * 0.75, time.as_secs_f64(), light);
            // A white sweep must not erase the label against the light composer wash.
            let (base, intensity) = if light {
                (blend(base, (0, 0, 0), 0.8), intensity.min(0.1))
            } else {
                (base, intensity)
            };
            let highlight = (255, 255, 255);
            Span::styled(
                glyph.to_owned(),
                Style::default().fg(best_color(blend(highlight, base, intensity as f32))),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn light_activity_labels_remain_readable_through_the_white_sweep() {
        fn luminance(rgb: (u8, u8, u8)) -> f64 {
            let linear = |v: u8| {
                let v = f64::from(v) / 255.0;
                if v <= 0.04045 {
                    v / 12.92
                } else {
                    ((v + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * linear(rgb.0) + 0.7152 * linear(rgb.1) + 0.0722 * linear(rgb.2)
        }
        for bg in [(255, 255, 255), (245, 243, 237), (238, 232, 216)] {
            crate::terminal_palette::with_test_default_colors(
                crate::terminal_probe::DefaultColors {
                    fg: (18, 18, 18),
                    bg,
                },
                || {
                    for millis in (0..2500).step_by(40) {
                        for span in gradient_text_at(
                            "Elpis Full Access Elpising",
                            Duration::from_millis(millis),
                        ) {
                            let Some(ratatui::style::Color::Rgb(r, g, b)) = span.style.fg else {
                                panic!("expected truecolor");
                            };
                            let contrast = (luminance(bg) + 0.05) / (luminance((r, g, b)) + 0.05);
                            assert!(
                                contrast >= 4.5,
                                "{} at {millis}ms has contrast {contrast}",
                                span.content
                            );
                        }
                    }
                },
            );
        }
    }

    #[test]
    fn activity_highlight_preserves_every_grapheme_at_every_phase() {
        let label = "Elpising… 文 e\u{301}";
        for millis in (0..5000).step_by(40) {
            let spans = gradient_text_at(label, Duration::from_millis(millis));
            assert_eq!(
                spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>(),
                label
            );
            assert_eq!(spans.len(), label.graphemes(true).count());
        }
    }

    use super::*;

    #[test]
    fn unknown_background_keeps_terminal_foreground_without_a_white_highlight() {
        assert_eq!(default_bg(), None);
        let fallback = Style::default().fg(ratatui::style::Color::Reset);
        assert_eq!(accent_style(), fallback);
        for millis in (0..2500).step_by(40) {
            for span in gradient_text_at("Elpising… 文", Duration::from_millis(millis)) {
                assert_eq!(span.style, fallback);
            }
        }
        let area = Rect::new(0, 0, 20, 1);
        let mut buffer = Buffer::empty(area);
        let line =
            ratatui::text::Line::from(gradient_text_at("Full Access", Duration::from_secs(1)))
                .style(Style::default().fg(ratatui::style::Color::Yellow));
        ratatui::widgets::Widget::render(ratatui::widgets::Paragraph::new(line), area, &mut buffer);
        for cell in buffer
            .content
            .iter()
            .filter(|cell| !cell.symbol().trim().is_empty())
        {
            assert_eq!(cell.fg, ratatui::style::Color::Reset);
        }
        for bg in [(255, 255, 255), (17, 18, 20)] {
            crate::terminal_palette::with_test_default_colors(
                crate::terminal_probe::DefaultColors {
                    fg: (120, 120, 120),
                    bg,
                },
                || {
                    assert!(
                        gradient_text_at("Elpis", Duration::from_secs(1))
                            .iter()
                            .all(|span| span.style.fg.is_some())
                    )
                },
            );
        }
    }

    #[test]
    fn animated_labels_change_color_without_changing_text() {
        // Part-way through the colour cycle, not a whole number of them: at the
        // period this runs at, a sample on the boundary reads the same as zero
        // and the assertion below would be measuring the period, not motion.
        let sample = Duration::from_millis(2_500);
        let first = gradient_text_at("Read Search Full access", Duration::ZERO);
        let later = gradient_text_at("Read Search Full access", sample);
        assert_ne!(
            pigment(0.0, 0.0, false),
            pigment(0.0, sample.as_secs_f64(), false)
        );
        assert_eq!(
            first.iter().map(|s| s.content.as_ref()).collect::<String>(),
            later.iter().map(|s| s.content.as_ref()).collect::<String>()
        );
        assert_eq!(animated_text("Elpis", false), text("Elpis"));
    }

    #[test]
    fn gradient_moves_gently() {
        // Part-way through the cycle, for the same reason as above.
        let sample = Duration::from_millis(2_500);
        assert_ne!(
            pigment(0.2, 0.0, false),
            pigment(0.2, sample.as_secs_f64(), false)
        );
        for light in [false, true] {
            let a = pigment(0.2, 0.0, light);
            let b = pigment(0.2, Duration::from_millis(40).as_secs_f64(), light);
            assert!(a.0.abs_diff(b.0) <= 2 && a.1.abs_diff(b.1) <= 2 && a.2.abs_diff(b.2) <= 2);
        }
    }
}
