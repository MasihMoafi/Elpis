//! Orange-to-yellow motion composed with TachyonFX. Never paint over draft text.
//!
//! Copied from Elpis v0.3.0 (tag `stage0-stop-bleeding`). Two adaptations: the streamed
//! text reveal (`TextReveal`) is not wired into this build yet and is left out, and the one
//! TachyonFX curve still used, sine-in-out, is inlined so the crate is not a dependency.
use crate::color::{blend, is_light};
use crate::terminal_palette::{best_color, default_bg};
use ratatui::{buffer::Buffer, layout::Rect, style::Style, text::Span};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub(crate) const FRAME_TICK: Duration = Duration::from_millis(40);
/// One complete pass of the highlight, from just before the first glyph to
/// just past the last. The paced cycle runs whole sweeps so the motion always
/// comes to rest with the highlight off the text.
const SWEEP: Duration = Duration::from_millis(800);
const MOTION_WAIT: Duration = Duration::from_secs(4);

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
    let colors = if light {
        [(160, 95, 0), (133, 108, 0), (150, 100, 0)]
    } else {
        [(220, 139, 32), (230, 179, 52), (208, 174, 49)]
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

pub(crate) fn animated_text_at(text: &str, time: Duration) -> Vec<Span<'static>> {
    gradient_text_at(text, time)
}

/// Run one complete shimmer, then leave the terminal untouched long enough for
/// native click-and-drag selection to remain stable.
///
/// The wait starts only once a whole sweep has finished, so the highlight has
/// already left the text when the motion settles. The sample only ever moves
/// forward, so the next sweep picks the colour up where the last one left it
/// instead of snapping back to the start.
pub(crate) fn paced_motion(elapsed: Duration) -> (Duration, Duration) {
    let cycle = SWEEP + MOTION_WAIT;
    let swept = SWEEP * u32::try_from(elapsed.as_nanos() / cycle.as_nanos()).unwrap_or(u32::MAX);
    let position_nanos = u64::try_from(elapsed.as_nanos() % cycle.as_nanos()).unwrap_or(u64::MAX);
    let position = Duration::from_nanos(position_nanos);
    if position < SWEEP {
        (
            swept + position,
            FRAME_TICK.min(SWEEP.saturating_sub(position)),
        )
    } else {
        (swept + SWEEP, cycle.saturating_sub(position))
    }
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
                - sine_in_out(
                    f32::from(x - area.x) / f32::from(area.width.saturating_sub(1).max(1)),
                );
            cell.set_bg(best_color(blend(wash, background, amount)));
        }
    }
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
    fn paced_motion_rests_on_a_finished_sweep_and_never_rewinds() {
        assert_eq!(paced_motion(Duration::ZERO), (Duration::ZERO, FRAME_TICK));
        assert_eq!(paced_motion(SWEEP), (SWEEP, MOTION_WAIT));
        assert_eq!(
            paced_motion(Duration::from_secs(1)),
            (SWEEP, Duration::from_millis(3_800))
        );
        // A new sweep resumes from the colour the last one settled on.
        assert_eq!(paced_motion(SWEEP + MOTION_WAIT), (SWEEP, FRAME_TICK));
        assert_eq!(
            paced_motion(SWEEP + MOTION_WAIT + SWEEP),
            (SWEEP * 2, MOTION_WAIT)
        );
        let mut previous = Duration::ZERO;
        for millis in (0..20_000).step_by(37) {
            let (sample, _) = paced_motion(Duration::from_millis(millis));
            assert!(sample >= previous, "the motion rewound at {millis}ms");
            previous = sample;
        }
    }

    #[test]
    fn the_paced_rest_leaves_no_highlight_sitting_on_the_text() {
        crate::terminal_palette::with_test_default_colors(
            crate::terminal_probe::DefaultColors {
                fg: (222, 222, 219),
                bg: (17, 18, 20),
            },
            || {
                let label = "Elpising…";
                let (rest, wait) = paced_motion(SWEEP + Duration::from_secs(1));
                assert!(wait > FRAME_TICK, "the sample must be taken during a wait");
                let width = label.width().max(1) as f64;
                let mut column = 0.0;
                for (span, glyph) in gradient_text_at(label, rest)
                    .iter()
                    .zip(label.graphemes(true))
                {
                    let center = column + glyph.width() as f64 / 2.0;
                    column += glyph.width() as f64;
                    assert_eq!(
                        span.style.fg,
                        Some(best_color(pigment(
                            center / width * 0.75,
                            rest.as_secs_f64(),
                            false
                        ))),
                        "{glyph} still wears the highlight where the motion stopped"
                    );
                }
            },
        );
    }

    #[test]
    fn gradient_moves_gently_and_reduced_motion_is_static() {
        let area = Rect::new(0, 0, 30, 5);
        let mut original = Buffer::empty(area);
        original[(8, 2)].set_symbol("文");
        let mut first = original.clone();
        let mut later = original.clone();
        // Part-way through the cycle, for the same reason as above.
        let sample = Duration::from_millis(2_500);
        paint_frame(area, &mut first, Duration::ZERO, true);
        paint_frame(area, &mut later, sample, true);
        assert_ne!(
            pigment(0.2, 0.0, false),
            pigment(0.2, sample.as_secs_f64(), false)
        );
        assert_eq!(first[(8, 2)], original[(8, 2)]);
        paint_frame(area, &mut later, sample, false);
        assert_eq!(first, later);
        for light in [false, true] {
            let a = pigment(0.2, 0.0, light);
            let b = pigment(0.2, FRAME_TICK.as_secs_f64(), light);
            assert!(a.0.abs_diff(b.0) <= 2 && a.1.abs_diff(b.1) <= 2 && a.2.abs_diff(b.2) <= 2);
        }
    }
}
