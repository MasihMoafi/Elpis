//! The welcome frame player, retained from the blossom's visible-time scheduler.
//! Geometry and lighting are generated from the desktop's Elpis SVG instead.

use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;

pub(crate) const FRAME_INTERVAL: Duration = Duration::from_millis(50);
const SPIN_DURATION: Duration = Duration::from_millis(10_800);
pub(crate) const WIDTH: u16 = 60;
pub(crate) const HEIGHT: u16 = 21;
const FRAME_BYTES: usize = WIDTH as usize * HEIGHT as usize * 4;
const FRAMES: &[u8] = include_bytes!("frames/elpis.bin");

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Presentation {
    Animated,
    Static,
    Hidden,
}

#[derive(Default)]
pub(crate) struct EmptyStateAnimation {
    spin_elapsed: Duration,
    last_frame: Option<Instant>,
}

impl EmptyStateAnimation {
    pub(crate) fn pause_clock(&mut self) {
        self.last_frame = None;
    }

    pub(crate) fn render_in(
        &mut self,
        area: Rect,
        buffer: &mut Buffer,
        presentation: Presentation,
    ) -> Option<Duration> {
        self.render_in_at(area, buffer, presentation, Instant::now())
    }

    fn render_in_at(
        &mut self,
        area: Rect,
        buffer: &mut Buffer,
        presentation: Presentation,
        now: Instant,
    ) -> Option<Duration> {
        if presentation == Presentation::Hidden
            || area.width != WIDTH
            || area.height != HEIGHT
            || area.intersection(buffer.area) != area
        {
            self.pause_clock();
            return None;
        }
        if presentation == Presentation::Static {
            self.pause_clock();
            Self::paint_frame(area, buffer, FRAMES.len() / FRAME_BYTES - 1);
            return None;
        }
        if let Some(previous) = self.last_frame.replace(now) {
            self.spin_elapsed += now.saturating_duration_since(previous);
        }
        let frame = (self.spin_elapsed.min(SPIN_DURATION).as_millis() / FRAME_INTERVAL.as_millis())
            as usize;
        Self::paint_frame(area, buffer, frame);
        (self.spin_elapsed < SPIN_DURATION).then_some(FRAME_INTERVAL)
    }

    fn paint_frame(area: Rect, buffer: &mut Buffer, frame: usize) {
        let light = crate::terminal_palette::default_bg().is_some_and(crate::color::is_light);
        let colors = crate::terminal_palette::effective_stdout_color_level();
        for (index, cell) in FRAMES[frame * FRAME_BYTES..(frame + 1) * FRAME_BYTES]
            .chunks_exact(4)
            .enumerate()
            .filter(|(_, cell)| cell[0] != 0)
        {
            let rgb = (cell[1], cell[2], cell[3]);
            // The SVG's pale gold needs a darker pigment against a light terminal.
            let rgb = if light {
                crate::color::blend(rgb, (0, 0, 0), 0.5)
            } else {
                rgb
            };
            let color = if colors == crate::terminal_palette::StdoutColorLevel::Ansi256 {
                // Retain the blossom player's bounded palette cache so searches
                // do not compete with keyboard handling on every frame.
                static COLORS: [OnceLock<Color>; 4096] = [const { OnceLock::new() }; 4096];
                let (r, g, b) = (rgb.0 >> 4, rgb.1 >> 4, rgb.2 >> 4);
                let index = usize::from(r) * 256 + usize::from(g) * 16 + usize::from(b);
                *COLORS[index].get_or_init(|| {
                    crate::terminal_palette::best_color_for_level(
                        (r * 16 + 8, g * 16 + 8, b * 16 + 8),
                        colors,
                    )
                })
            } else {
                crate::terminal_palette::best_color_for_level(rgb, colors)
            };
            buffer[(area.x + index as u16 % WIDTH, area.y + index as u16 / WIDTH)]
                .set_char(char::from_u32(0x2800 + u32::from(cell[0])).unwrap_or(' '))
                .set_fg(color);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn welcome_player_advances_settles_and_pauses_while_hidden() {
        let area = Rect::new(0, 0, WIDTH, HEIGHT);
        let mut buffer = Buffer::empty(area);
        let mut animation = EmptyStateAnimation::default();
        let start = Instant::now();
        assert_eq!(
            animation.render_in_at(area, &mut buffer, Presentation::Animated, start),
            Some(FRAME_INTERVAL)
        );
        assert_eq!(
            animation.render_in_at(
                area,
                &mut buffer,
                Presentation::Animated,
                start + Duration::from_millis(1250)
            ),
            Some(FRAME_INTERVAL)
        );
        let elapsed = animation.spin_elapsed;
        assert_eq!(
            animation.render_in_at(
                area,
                &mut buffer,
                Presentation::Hidden,
                start + Duration::from_secs(50)
            ),
            None
        );
        animation.render_in_at(
            area,
            &mut buffer,
            Presentation::Animated,
            start + Duration::from_secs(100),
        );
        assert_eq!(animation.spin_elapsed, elapsed);
        assert_eq!(
            animation.render_in_at(
                area,
                &mut buffer,
                Presentation::Animated,
                start + Duration::from_secs(111)
            ),
            None
        );
    }

    #[test]
    fn welcome_frames_keep_the_mark_visible_during_the_sweep() {
        assert_eq!(FRAMES.len(), 217 * FRAME_BYTES);
        let first = &FRAMES[..FRAME_BYTES];
        let last = &FRAMES[216 * FRAME_BYTES..];
        assert_eq!(first, last);
        assert_ne!(first, &FRAMES[40 * FRAME_BYTES..41 * FRAME_BYTES]);
        for frame in FRAMES.chunks_exact(FRAME_BYTES) {
            assert!(frame.chunks_exact(4).filter(|cell| cell[0] != 0).count() > 300);
        }
    }

    #[test]
    fn welcome_static_player_never_schedules_redraws() {
        let area = Rect::new(0, 0, WIDTH, HEIGHT);
        let mut buffer = Buffer::empty(area);
        assert_eq!(
            EmptyStateAnimation::default().render_in(area, &mut buffer, Presentation::Static),
            None
        );
        assert!(buffer.content.iter().any(|cell| cell.symbol() != " "));
    }
}
