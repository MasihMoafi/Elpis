//! Orange-to-yellow motion composed with TachyonFX. Never paint over draft text.
use crate::color::{blend, is_light};
use crate::terminal_palette::{best_color, default_bg};
use ratatui::{buffer::Buffer, layout::Rect, style::Style, text::Span};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub(crate) const FRAME_TICK: Duration = Duration::from_millis(125);
pub(crate) const REVEAL_DURATION: Duration = Duration::from_millis(420);
// Leave a frame after the shader settles before moving text into scrollback.
pub(crate) const REVEAL_COMMIT_AGE: Duration = Duration::from_millis(500);

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

pub(crate) fn elpising_effect() -> tachyonfx::Effect {
    use tachyonfx::{Interpolation, fx};
    fx::repeating(fx::sequence(&[
        fx::sleep(1800),
        fx::dissolve((900, Interpolation::SineInOut)),
        fx::coalesce((900, Interpolation::SineInOut)),
    ]))
}

pub(crate) fn accent_style() -> Style {
    Style::default().fg(best_color(pigment(
        0.35,
        0.0,
        default_bg().is_some_and(is_light),
    )))
}

pub(crate) fn text(text: &str) -> Vec<Span<'static>> {
    let count = text.chars().count().max(1) as f64;
    let light = default_bg().is_some_and(is_light);
    text.chars()
        .enumerate()
        .map(|(index, ch)| {
            Span::styled(
                ch.to_string(),
                Style::default().fg(best_color(pigment(index as f64 / count * 0.75, 0.0, light))),
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

/// Canonical text is saved before effects, so settled text never restarts.
#[derive(Default)]
pub(crate) struct CoalescingText {
    previous: Option<Buffer>,
    reveals: Vec<(Rect, Vec<String>, tachyonfx::Effect)>,
    last_frame: Option<Instant>,
}

impl CoalescingText {
    pub(crate) fn render(
        &mut self,
        buf: &mut Buffer,
        area: Rect,
        enabled: bool,
        animate_initial: bool,
    ) -> bool {
        use tachyonfx::Shader;
        let area = area.intersection(buf.area);
        let now = Instant::now();
        let delta = self
            .last_frame
            .replace(now)
            .map(|last| now.saturating_duration_since(last))
            .unwrap_or(Duration::from_millis(1))
            .min(Duration::from_millis(100));
        // Committed rows leave the front of the mutable stream. Retain the
        // suffix's effects rather than making younger text flash fully visible.
        if let Some(old) = self.previous.as_mut()
            && old.area.width == area.width
            && old.area.height > area.height
            && area.height > 0
        {
            let offset = (0..=old.area.height - area.height).find(|offset| {
                (2..area.width).all(|x| {
                    old[(old.area.x + x, old.area.y + offset)].symbol()
                        == buf[(area.x + x, area.y)].symbol()
                })
            });
            if let Some(offset) = offset {
                let first_y = old.area.y + offset;
                self.reveals.retain(|(rect, _, _)| {
                    rect.y >= first_y && rect.bottom() <= first_y + area.height
                });
                old.content
                    .drain(..usize::from(offset) * usize::from(area.width));
                old.content
                    .truncate(usize::from(area.height) * usize::from(area.width));
                old.area.y = first_y;
                old.area.height = area.height;
            }
        }
        // Preserve ongoing effects when terminal scrolling moves the viewport.
        if let Some(old) = self.previous.as_mut()
            && old.area.width == area.width
            && old.area.height <= area.height
        {
            let dx = i32::from(area.x) - i32::from(old.area.x);
            let dy = i32::from(area.y) - i32::from(old.area.y);
            for (rect, _, _) in &mut self.reveals {
                rect.x = (i32::from(rect.x) + dx).max(0) as u16;
                rect.y = (i32::from(rect.y) + dy).max(0) as u16;
            }
            old.area.x = area.x;
            old.area.y = area.y;
        }
        let resized = self.previous.as_ref().is_some_and(|old| {
            !old.area.is_empty()
                && (old.area.x != area.x
                    || old.area.y != area.y
                    || old.area.width != area.width
                    || old.area.height > area.height)
        });
        if !enabled || resized {
            self.reveals.clear();
        }
        let mut canonical = Buffer::empty(area);
        for y in area.y..area.bottom() {
            for x in area.x..area.right() {
                canonical[(x, y)] = buf[(x, y)].clone();
            }
        }
        if enabled && !resized && (self.previous.is_some() || animate_initial) {
            for y in area.y..area.bottom() {
                let mut x = area.x;
                while x < area.right() {
                    let changed = |x| {
                        !canonical[(x, y)].symbol().trim().is_empty()
                            && self.previous.as_ref().is_none_or(|old| {
                                !old.area.contains((x, y).into())
                                    || old[(x, y)].symbol() != canonical[(x, y)].symbol()
                            })
                    };
                    if !changed(x) {
                        x += 1;
                        continue;
                    }
                    let start = x;
                    while x < area.right() && changed(x) {
                        x += 1;
                    }
                    let rect = Rect::new(start, y, x - start, 1);
                    let symbols = (start..x)
                        .map(|col| canonical[(col, y)].symbol().to_owned())
                        .collect();
                    self.reveals.push((
                        rect,
                        symbols,
                        tachyonfx::fx::coalesce((
                            REVEAL_DURATION.as_millis() as u32,
                            tachyonfx::Interpolation::SineOut,
                        )),
                    ));
                }
            }
        }
        self.previous = Some(canonical);
        self.reveals.retain_mut(|(rect, symbols, effect)| {
            if !area.contains((rect.x, rect.y).into())
                || rect.right() > area.right()
                || symbols
                    .iter()
                    .enumerate()
                    .any(|(i, s)| buf[(rect.x + i as u16, rect.y)].symbol() != s)
            {
                return false;
            }
            effect.process(delta.into(), buf, *rect);
            !effect.done()
        });
        !self.reveals.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn committing_front_row_does_not_finish_younger_rows_effect() {
        let area = Rect::new(0, 0, 40, 4);
        let mut motion = CoalescingText::default();
        let mut buf = Buffer::empty(area);
        buf.set_string(0, 0, "  Older row", Style::default());
        buf.set_string(0, 1, "  Younger row", Style::default());
        assert!(motion.render(&mut buf, Rect::new(0, 0, 40, 2), true, true));
        let younger_effects = motion
            .reveals
            .iter()
            .filter(|(rect, _, _)| rect.y == 1)
            .count();
        let mut next = Buffer::empty(area);
        next.set_string(0, 0, "  Younger row", Style::default());
        assert!(motion.render(&mut next, Rect::new(0, 0, 40, 1), true, true));
        assert_eq!(motion.reveals.len(), younger_effects);
        assert!(motion.reveals.iter().all(|(rect, _, _)| rect.y == 0));
    }

    #[test]
    fn moving_stream_viewport_preserves_reveal_progress() {
        let mut motion = CoalescingText::default();
        let mut initial = Buffer::empty(Rect::new(0, 0, 40, 8));
        initial.set_string(0, 3, "Text stays in motion", Style::default());
        let canonical = initial.clone();
        assert!(motion.render(&mut initial, Rect::new(0, 3, 30, 1), true, true));
        motion.last_frame = Some(Instant::now() - Duration::from_millis(100));
        initial = canonical;
        assert!(motion.render(&mut initial, Rect::new(0, 3, 30, 1), true, true));
        let pending_effects = motion.reveals.len();
        let mut moved = Buffer::empty(initial.area);
        moved.set_string(0, 1, "Text stays in motion", Style::default());
        assert!(motion.render(&mut moved, Rect::new(0, 1, 30, 1), true, true));
        assert_eq!(
            motion.reveals.len(),
            pending_effects,
            "moving must not restart the effect"
        );
        assert_eq!(motion.reveals[0].0.y, 1);
        for x in 0..20 {
            if initial[(x, 3)].symbol() != " " {
                assert_eq!(moved[(x, 1)].symbol(), initial[(x, 3)].symbol());
            }
        }
    }

    #[test]
    fn elpising_holds_readable_text_before_dissolving() {
        use tachyonfx::Shader;
        let mut canonical = Buffer::empty(Rect::new(0, 0, 20, 1));
        canonical.set_string(0, 0, "Elpising…", Style::default());
        let mut effect = elpising_effect();
        for _ in 0..17 {
            let mut rendered = canonical.clone();
            effect.process(
                Duration::from_millis(100).into(),
                &mut rendered,
                canonical.area,
            );
            assert_eq!(rendered, canonical);
        }
    }

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
    fn coalesce_settles_without_replaying_and_reduced_motion_preserves_text() {
        let area = Rect::new(0, 0, 30, 2);
        let mut canonical = Buffer::empty(area);
        canonical.set_string(0, 0, "Hello 文", Style::default());
        let mut motion = CoalescingText::default();
        let mut first = canonical.clone();
        assert!(motion.render(&mut first, area, true, true));
        assert_ne!(first, canonical);
        for _ in 0..6 {
            motion.last_frame = Some(Instant::now() - Duration::from_millis(100));
            motion.render(&mut canonical.clone(), area, true, true);
        }
        let mut settled = canonical.clone();
        assert!(!motion.render(&mut settled, area, true, true));
        assert_eq!(settled, canonical);
        canonical.set_string(0, 1, "New text", Style::default());
        let mut changed = canonical.clone();
        assert!(motion.render(&mut changed, area, true, true));
        for x in 0..area.width {
            assert_eq!(changed[(x, 0)], canonical[(x, 0)]);
        }
        let mut still = canonical.clone();
        assert!(!motion.render(&mut still, area, false, true));
        assert_eq!(still, canonical);
        assert!(!motion.render(&mut still, Rect::new(0, 0, 20, 2), true, true));
    }
    #[test]
    fn tachyonfx_dissolves_letters_without_touching_background_or_other_cells() {
        use tachyonfx::Shader;
        crate::terminal_palette::with_test_default_colors(
            crate::terminal_probe::DefaultColors {
                fg: (35, 35, 35),
                bg: (255, 255, 255),
            },
            || {
                let mut original = Buffer::empty(Rect::new(0, 0, 20, 1));
                for (index, span) in text("Elpising…").iter().enumerate() {
                    original[(index as u16, 0)]
                        .set_symbol(&span.content)
                        .set_style(span.style);
                }
                let mut rendered = original.clone();
                let mut effect = elpising_effect();
                effect.process(
                    Duration::from_millis(2699).into(),
                    &mut rendered,
                    Rect::new(0, 0, 9, 1),
                );
                assert_ne!(rendered, original);
                for x in 0..20 {
                    assert_eq!(rendered[(x, 0)].bg, original[(x, 0)].bg);
                }
                assert_eq!(rendered[(12, 0)], original[(12, 0)]);
            },
        );
        for light in [false, true] {
            for step in 0..100 {
                let (r, g, b) = pigment(f64::from(step) / 100.0, 0.0, light);
                assert!(r >= g && g > b, "palette must stay orange/yellow");
            }
        }
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
