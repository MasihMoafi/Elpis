//! A single quiet dissolve while startup work runs; never retained in history.
use crate::tui::{Tui, TuiEvent};
use crossterm::event::{KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    text::Line,
    widgets::{Clear, Paragraph, Widget},
};
use std::future::Future;
use std::io;
use std::time::{Duration, Instant};
use tachyonfx::Shader;
use tokio_stream::StreamExt;

const HOLD: Duration = Duration::from_millis(1400);
const DISSOLVE: Duration = Duration::from_millis(900);
const TICK: Duration = Duration::from_millis(40);

pub(crate) enum StartupWait<T> {
    Completed(T),
    Cancelled,
}

pub(crate) struct StartupAnimation {
    animations_enabled: bool,
    started: Instant,
    dissolve: tachyonfx::Effect,
}

impl StartupAnimation {
    pub(crate) fn new(animations_enabled: bool) -> Self {
        Self {
            animations_enabled,
            started: Instant::now(),
            dissolve: tachyonfx::fx::dissolve((
                DISSOLVE.as_millis() as u32,
                tachyonfx::Interpolation::SineInOut,
            )),
        }
    }

    pub(crate) fn set_animations_enabled(&mut self, enabled: bool) {
        self.animations_enabled = enabled;
    }

    fn render_at(&self, area: Rect, buf: &mut Buffer, elapsed: Duration, status: &str) {
        Clear.render(area, buf);
        if area.is_empty() {
            return;
        }
        let title = Rect::new(
            area.x.saturating_add(1).min(area.right() - 1),
            area.y,
            area.width.saturating_sub(1).min(5),
            1,
        );
        if !self.animations_enabled || elapsed < HOLD + DISSOLVE {
            Paragraph::new(Line::from(crate::elpis_motion::text("Elpis"))).render(title, buf);
            if self.animations_enabled && elapsed > HOLD {
                // Reuse the same random mask: vanished letters must not flicker
                // back into view when the next frame is drawn.
                self.dissolve
                    .clone()
                    .process((elapsed - HOLD).into(), buf, title);
            }
        }
        if area.height > 2 {
            Paragraph::new(format!("Starting · {status}"))
                .style(crate::elpis_motion::accent_style())
                .render(Rect::new(area.x, area.y + 2, area.width, 1), buf);
        }
    }

    pub(crate) async fn wait_for<T, F>(
        &mut self,
        tui: &mut Tui,
        status: &str,
        work: F,
    ) -> io::Result<StartupWait<T>>
    where
        F: Future<Output = T>,
    {
        // A single bounded entrance overlaps initialization. Later startup phases
        // share this clock and cannot replay it or add another delay.
        let minimum = if self.animations_enabled {
            HOLD + DISSOLVE
        } else {
            Duration::ZERO
        };
        let remaining = minimum.saturating_sub(self.started.elapsed());
        let work = async {
            let (value, ()) = tokio::join!(work, tokio::time::sleep(remaining));
            value
        };
        tokio::pin!(work);
        let mut input = tui.event_stream();
        let mut ticks = tokio::time::interval(TICK);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut input_open = true;
        loop {
            tokio::select! {
                biased;
                value = &mut work => return Ok(StartupWait::Completed(value)),
                event = input.next(), if input_open => match event {
                    Some(TuiEvent::Key(key)) if key.kind == KeyEventKind::Press
                        && (key.code == KeyCode::Esc || (key.code == KeyCode::Char('c')
                            && key.modifiers.contains(KeyModifiers::CONTROL))) =>
                        return Ok(StartupWait::Cancelled),
                    None => input_open = false,
                    _ => {},
                },
                _ = ticks.tick() => {
                    tui.draw(3, |frame| self.render_at(frame.area(), frame.buffer_mut(),
                        self.started.elapsed(), status))?;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "manual actual-widget motion capture; set ELPIS_VISUAL_DIR"]
    fn export_selected_startup_review() {
        let root = std::path::PathBuf::from(std::env::var("ELPIS_VISUAL_DIR").unwrap());
        std::fs::create_dir_all(&root).unwrap();
        let mut frames = Vec::new();
        let animation = StartupAnimation::new(true);
        for ms in (0..2800).step_by(40) {
            let mut buf = Buffer::empty(Rect::new(0, 0, 40, 3));
            animation.render_at(buf.area, &mut buf, Duration::from_millis(ms), "loading");
            frames.push(
                serde_json::json!({"width":buf.area.width,"height":buf.area.height,
                "cells":buf.content.iter().map(|c| serde_json::json!({"s":c.symbol(),
                    "fg":format!("{:?}",c.fg),"bg":format!("{:?}",c.bg)})).collect::<Vec<_>>()}),
            );
        }
        std::fs::write(
            root.join("startup-frames.json"),
            serde_json::to_vec(&frames).unwrap(),
        )
        .unwrap();
    }
    fn frame(enabled: bool, elapsed: Duration, width: u16) -> Buffer {
        let mut buf = Buffer::empty(Rect::new(0, 0, width, 3));
        StartupAnimation::new(enabled).render_at(buf.area, &mut buf, elapsed, "loading");
        buf
    }
    fn title(buf: &Buffer) -> String {
        (0..buf.area.width).map(|x| buf[(x, 0)].symbol()).collect()
    }
    #[test]
    fn startup_name_stays_readable_before_dissolving() {
        for ms in [0, 400, 800, 1200, 1400] {
            assert!(title(&frame(true, Duration::from_millis(ms), 30)).contains("Elpis"));
        }
    }

    #[test]
    fn title_dissolves_once_and_does_not_return() {
        assert!(title(&frame(true, Duration::ZERO, 30)).contains("Elpis"));
        for ms in [2300, 3000, 5000] {
            assert!(
                title(&frame(true, Duration::from_millis(ms), 30))
                    .trim()
                    .is_empty()
            );
        }
    }

    #[test]
    fn dissolved_letters_never_reappear_between_frames() {
        let animation = StartupAnimation::new(true);
        let area = Rect::new(0, 0, 30, 3);
        let mut previous = Buffer::empty(area);
        animation.render_at(area, &mut previous, Duration::ZERO, "loading");
        for ms in (1400..2400).step_by(10) {
            let mut next = Buffer::empty(area);
            animation.render_at(area, &mut next, Duration::from_millis(ms), "loading");
            for x in 1..6 {
                if previous[(x, 0)].symbol() == " " {
                    assert_eq!(next[(x, 0)].symbol(), " ");
                }
            }
            previous = next;
        }
    }
    #[test]
    fn disabled_motion_is_stable_and_narrow_frames_are_safe() {
        assert_eq!(
            frame(false, Duration::ZERO, 30),
            frame(false, Duration::from_secs(8), 30)
        );
        for width in 0..7 {
            frame(true, Duration::from_millis(400), width);
        }
    }
}
