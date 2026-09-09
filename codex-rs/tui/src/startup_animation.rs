//! Elpis startup identity rendered while existing startup work is pending.

use std::future::Future;
use std::io;
use std::time::Duration;
use std::time::Instant;

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Clear;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;
use ratatui::widgets::WidgetRef;
use tokio_stream::Stream;
use tokio_stream::StreamExt;

use crate::tui::Tui;
use crate::tui::TuiEvent;

const LOGO_PIXELS: [&str; 9] = [
    "████████████   ██            ███████████     ████    ████████████ ",
    "████████████   ██            ████████████    ████    ████████████ ",
    "██             ██            ██        ███   ████    ██           ",
    "██             ██            ██        ███   ████    ██           ",
    "██████████     ██            ████████████    ████    ████████████ ",
    "██             ██            ███████████     ████              ██ ",
    "██             ██            ██              ████              ██ ",
    "████████████   ███████████   ██              ████    ████████████ ",
    "████████████   ███████████   ██              ████    ████████████ ",
];

const MIN_LOGO_EXTRA_WIDTH: u16 = 4;
const MIN_LOGO_HEIGHT: u16 = 14;
const FRAME_TICK: Duration = Duration::from_millis(40);
const SWEEP_DURATION_SECS: f64 = 1.2;
const CYCLE_DURATION_SECS: f64 = 4.0;

#[derive(Clone, Copy, Debug)]
struct StartupPalette {
    id: &'static str,
    name: &'static str,
    top: (u8, u8, u8),
    mid: (u8, u8, u8),
    bottom: (u8, u8, u8),
    flare: (u8, u8, u8),
    accent: (u8, u8, u8),
}

const PALETTES: [StartupPalette; 6] = [
    StartupPalette {
        id: "solar",
        name: "Solar Flare",
        top: (255, 235, 50),
        mid: (255, 145, 0),
        bottom: (230, 45, 0),
        flare: (255, 240, 90),
        accent: (255, 235, 50),
    },
    StartupPalette {
        id: "cyberpunk",
        name: "Cyberpunk",
        top: (0, 255, 230),
        mid: (0, 210, 130),
        bottom: (10, 110, 80),
        flare: (180, 255, 250),
        accent: (0, 255, 230),
    },
    StartupPalette {
        id: "synthwave",
        name: "Synthwave",
        top: (255, 40, 180),
        mid: (170, 20, 240),
        bottom: (60, 10, 160),
        flare: (255, 190, 255),
        accent: (255, 40, 180),
    },
    StartupPalette {
        id: "frost",
        name: "Glacial Frost",
        top: (220, 245, 255),
        mid: (70, 160, 255),
        bottom: (20, 50, 140),
        flare: (255, 255, 255),
        accent: (220, 245, 255),
    },
    StartupPalette {
        id: "crimson",
        name: "Blood Crimson",
        top: (255, 60, 60),
        mid: (200, 10, 40),
        bottom: (80, 0, 20),
        flare: (255, 200, 200),
        accent: (255, 70, 70),
    },
    StartupPalette {
        id: "matrix",
        name: "Phosphor Matrix",
        top: (80, 255, 80),
        mid: (20, 190, 40),
        bottom: (5, 70, 15),
        flare: (200, 255, 200),
        accent: (80, 255, 80),
    },
];

#[cfg(test)]
const PALETTE_IDS: [&str; 6] = [
    "solar",
    "cyberpunk",
    "synthwave",
    "frost",
    "crimson",
    "matrix",
];

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum StartupWait<T> {
    Completed(T),
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StartupInput {
    Cancel,
    Redraw,
    SelectPalette(usize),
    NextPalette,
    Ignore,
}

pub(crate) struct StartupAnimation {
    animations_enabled: bool,
    palette_index: usize,
}

/// Retained as ordinary terminal history; it scrolls with the conversation.
#[derive(Debug)]
pub(crate) struct StartupIdentityHistoryCell {
    palette: StartupPalette,
    compact: bool,
}

impl crate::history_cell::HistoryCell for StartupIdentityHistoryCell {
    fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
        if width == 0 {
            return Vec::new();
        }
        let logo_width = LOGO_PIXELS
            .iter()
            .map(|row| row.trim_end().chars().count())
            .max()
            .unwrap_or(0);
        if self.compact || usize::from(width) < logo_width {
            return vec![Line::styled(
                if width >= 5 { "ELPIS" } else { "E" },
                Style::default()
                    .fg(rgb(self.palette.accent))
                    .add_modifier(Modifier::BOLD),
            )];
        }
        LOGO_PIXELS
            .iter()
            .enumerate()
            .map(|(row_index, row)| {
                Line::from(
                    row.trim_end()
                        .chars()
                        .enumerate()
                        .map(|(column_index, symbol)| {
                            Span::styled(
                                symbol.to_string(),
                                Style::default().fg(logo_color(
                                    self.palette,
                                    row_index,
                                    column_index,
                                    Duration::ZERO,
                                    false,
                                )),
                            )
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .collect()
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        vec![Line::from("Elpis")]
    }
}

impl StartupAnimation {
    pub(crate) fn new(animations_enabled: bool) -> Self {
        Self {
            animations_enabled,
            palette_index: 0,
        }
    }

    #[cfg(test)]
    fn palette_id(&self) -> &'static str {
        PALETTES[self.palette_index].id
    }

    pub(crate) fn set_animations_enabled(&mut self, enabled: bool) {
        self.animations_enabled = enabled;
    }

    pub(crate) fn into_history_cell(self, terminal_height: u16) -> StartupIdentityHistoryCell {
        StartupIdentityHistoryCell {
            palette: PALETTES[self.palette_index],
            compact: terminal_height < 24,
        }
    }

    fn classify_key(key: KeyEvent) -> StartupInput {
        if key.kind != KeyEventKind::Press {
            return StartupInput::Ignore;
        }
        match key.code {
            KeyCode::Esc => StartupInput::Cancel,
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                StartupInput::Cancel
            }
            KeyCode::Char('.') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                StartupInput::NextPalette
            }
            KeyCode::Char(key @ '1'..='6') => {
                StartupInput::SelectPalette((key as u8 - b'1') as usize)
            }
            _ => StartupInput::Ignore,
        }
    }

    fn apply_input(&mut self, input: StartupInput) {
        match input {
            StartupInput::SelectPalette(index) if index < PALETTES.len() => {
                self.palette_index = index;
            }
            StartupInput::NextPalette => {
                self.palette_index = (self.palette_index + 1) % PALETTES.len();
            }
            StartupInput::Cancel
            | StartupInput::Redraw
            | StartupInput::SelectPalette(_)
            | StartupInput::Ignore => {}
        }
    }

    #[cfg(test)]
    fn handle_key(&mut self, key: KeyEvent) -> StartupInput {
        let input = Self::classify_key(key);
        self.apply_input(input);
        input
    }

    fn render_at(&self, area: Rect, buf: &mut Buffer, elapsed: Duration, status: &str) {
        Clear.render(area, buf);
        if area.width == 0 || area.height == 0 {
            return;
        }

        let logo_width = LOGO_PIXELS
            .iter()
            .map(|row| row.chars().count() as u16)
            .max()
            .unwrap_or(0);
        if area.width < logo_width.saturating_add(MIN_LOGO_EXTRA_WIDTH)
            || area.height < MIN_LOGO_HEIGHT
        {
            self.render_compact(area, buf, status);
            return;
        }

        let palette = PALETTES[self.palette_index];
        let origin_y = area.y;
        let origin_x = area.x;

        let title = Line::from(vec![
            Span::styled(
                palette.name,
                Style::default()
                    .fg(rgb(palette.accent))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  [{} · {}]", self.palette_index + 1, palette.id),
                Style::default().fg(Color::DarkGray),
            ),
        ]);
        Paragraph::new(title).render(Rect::new(area.x, origin_y, area.width, 1), buf);

        let logo_y = origin_y.saturating_add(2);
        let animated_elapsed = if self.animations_enabled {
            elapsed
        } else {
            Duration::ZERO
        };
        for (row_index, row) in LOGO_PIXELS.iter().enumerate() {
            let y = logo_y.saturating_add(row_index as u16);
            for (column_index, symbol) in row.chars().enumerate() {
                if symbol == ' ' {
                    continue;
                }
                let x = origin_x.saturating_add(column_index as u16);
                if x >= area.right() || y >= area.bottom() {
                    continue;
                }
                let color = logo_color(
                    palette,
                    row_index,
                    column_index,
                    animated_elapsed,
                    self.animations_enabled,
                );
                buf[(x, y)].set_symbol("█").set_fg(color);
            }
        }

        let status_y = logo_y.saturating_add(LOGO_PIXELS.len() as u16 + 1);
        let status_line = Line::from(vec![
            Span::styled(
                "Elpis",
                Style::default()
                    .fg(rgb(palette.accent))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(" is starting · {status}"),
                Style::default().fg(Color::Gray),
            ),
        ]);
        Paragraph::new(status_line).render(Rect::new(area.x, status_y, area.width, 1), buf);
        if status_y.saturating_add(1) < area.bottom() {
            Paragraph::new(Line::styled(
                "1-6 palette · Ctrl+. next · Esc/Ctrl+C cancel",
                Style::default().fg(Color::DarkGray),
            ))
            .render(
                Rect::new(area.x, status_y.saturating_add(1), area.width, 1),
                buf,
            );
        }
    }

    fn render_compact(&self, area: Rect, buf: &mut Buffer, status: &str) {
        let palette = PALETTES[self.palette_index];
        let start_y = area.y;
        Paragraph::new(Line::from(vec![
            Span::styled(
                "Elpis",
                Style::default()
                    .fg(rgb(palette.accent))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" is starting", Style::default().fg(Color::Gray)),
        ]))
        .render(Rect::new(area.x, start_y, area.width, 1), buf);
        if start_y.saturating_add(1) < area.bottom() {
            Paragraph::new(Line::styled(status, Style::default().fg(Color::DarkGray))).render(
                Rect::new(area.x, start_y.saturating_add(1), area.width, 1),
                buf,
            );
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
        let inputs = tui.event_stream().map(input_from_tui_event);
        drive_startup(self, work, inputs, FRAME_TICK, |animation, elapsed| {
            tui.draw(u16::MAX, |frame| {
                let view = StartupAnimationView {
                    animation,
                    elapsed,
                    status,
                };
                frame.render_widget_ref(&view, frame.area());
            })
        })
        .await
    }
}

struct StartupAnimationView<'a> {
    animation: &'a StartupAnimation,
    elapsed: Duration,
    status: &'a str,
}

impl WidgetRef for &StartupAnimationView<'_> {
    fn render_ref(&self, area: Rect, buf: &mut Buffer) {
        self.animation
            .render_at(area, buf, self.elapsed, self.status);
    }
}

fn rgb((red, green, blue): (u8, u8, u8)) -> Color {
    Color::Rgb(red, green, blue)
}

fn interpolate_channel(start: u8, end: u8, amount: f64) -> u8 {
    (f64::from(start) + (f64::from(end) - f64::from(start)) * amount)
        .round()
        .clamp(0.0, 255.0) as u8
}

fn interpolate_color(start: (u8, u8, u8), end: (u8, u8, u8), amount: f64) -> Color {
    Color::Rgb(
        interpolate_channel(start.0, end.0, amount),
        interpolate_channel(start.1, end.1, amount),
        interpolate_channel(start.2, end.2, amount),
    )
}

fn logo_color(
    palette: StartupPalette,
    row: usize,
    column: usize,
    elapsed: Duration,
    animated: bool,
) -> Color {
    let elapsed_secs = elapsed.as_secs_f64();
    if animated {
        let cycle_time = elapsed_secs % CYCLE_DURATION_SECS;
        if cycle_time < SWEEP_DURATION_SECS {
            let logo_width = LOGO_PIXELS[0].chars().count() as f64;
            let sweep_x = (cycle_time / SWEEP_DURATION_SECS) * (logo_width + 10.0) - 4.0;
            if ((column as f64) - sweep_x).abs() < 3.5 {
                return rgb(palette.flare);
            }
        }
    }

    let last_row = LOGO_PIXELS.len().saturating_sub(1).max(1) as f64;
    let y_normalized = row as f64 / last_row;
    let ripple = if animated {
        0.22 * ((column as f64 * 0.22) - elapsed_secs * 2.0 + row as f64 * 0.32).sin()
    } else {
        0.0
    };
    let amount = ((1.0 - y_normalized) + ripple).clamp(0.0, 1.0);
    if amount > 0.5 {
        interpolate_color(palette.mid, palette.top, (amount - 0.5) * 2.0)
    } else {
        interpolate_color(palette.bottom, palette.mid, amount * 2.0)
    }
}

fn input_from_tui_event(event: TuiEvent) -> StartupInput {
    match event {
        TuiEvent::Key(key) => StartupAnimation::classify_key(key),
        TuiEvent::Draw | TuiEvent::Resize => StartupInput::Redraw,
        TuiEvent::Paste(_) | TuiEvent::Mouse(_) => StartupInput::Ignore,
    }
}

async fn drive_startup<T, F, S, D>(
    animation: &mut StartupAnimation,
    work: F,
    inputs: S,
    tick: Duration,
    mut draw: D,
) -> io::Result<StartupWait<T>>
where
    F: Future<Output = T>,
    S: Stream<Item = StartupInput> + Unpin,
    D: FnMut(&StartupAnimation, Duration) -> io::Result<()>,
{
    draw(animation, Duration::ZERO)?;
    let started_at = Instant::now();
    let mut input_open = true;
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + tick, tick);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tokio::pin!(work);
    tokio::pin!(inputs);

    loop {
        tokio::select! {
            biased;
            result = &mut work => return Ok(StartupWait::Completed(result)),
            input = inputs.next(), if input_open => {
                let Some(input) = input else {
                    input_open = false;
                    continue;
                };
                if input == StartupInput::Cancel {
                    return Ok(StartupWait::Cancelled);
                }
                animation.apply_input(input);
                if matches!(input, StartupInput::Redraw | StartupInput::SelectPalette(_) | StartupInput::NextPalette) {
                    draw(animation, started_at.elapsed())?;
                }
            }
            _ = ticker.tick(), if animation.animations_enabled => {
                draw(animation, started_at.elapsed())?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history_cell::HistoryCell;
    use crossterm::event::KeyCode;
    use crossterm::event::KeyModifiers;
    use ratatui::style::Color;
    use std::cell::Cell;
    use std::convert::Infallible;
    use std::rc::Rc;
    use std::time::Instant;
    use tokio_stream::iter;

    fn rendered(
        animation: &StartupAnimation,
        width: u16,
        height: u16,
        elapsed: Duration,
    ) -> Buffer {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        animation.render_at(area, &mut buf, elapsed, "Preparing context");
        buf
    }

    fn text(buf: &Buffer) -> String {
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn large_frame_contains_supplied_logo() {
        let buf = rendered(
            &StartupAnimation::new(/*animations_enabled*/ true),
            /*width*/ 100,
            /*height*/ 24,
            Duration::ZERO,
        );
        let rendered = text(&buf);

        assert!(
            rendered.matches('█').count() > 250,
            "expected the supplied nine-row block logo, got:\n{rendered}"
        );
        assert!(rendered.contains("Preparing context"));
    }

    #[test]
    fn startup_logo_is_anchored_at_upper_left() {
        let area = Rect::new(5, 3, 100, 24);
        let mut buf = Buffer::empty(area);
        StartupAnimation::new(true).render_at(area, &mut buf, Duration::ZERO, "Preparing context");

        assert_eq!(buf[(area.x, area.y)].symbol(), "S");
        assert_eq!(buf[(area.x, area.y + 2)].symbol(), "█");
    }

    #[test]
    fn retained_identity_keeps_selected_palette_above_following_chat() {
        let mut animation = StartupAnimation::new(false);
        animation.handle_key(KeyEvent::new(KeyCode::Char('4'), KeyModifiers::NONE));
        let identity = animation.into_history_cell(40);
        let opening = identity.display_lines(100);
        assert_eq!(opening.len(), LOGO_PIXELS.len());
        assert_eq!(opening[0].spans[0].style.fg, Some(rgb(PALETTES[3].top)));

        let area = Rect::new(0, 0, 100, 20);
        let mut before = Buffer::empty(area);
        Paragraph::new(opening.clone()).render(area, &mut before);
        let mut transcript = opening;
        transcript.push(Line::from("You: explain this code"));
        transcript.push(Line::from("Elpis: the entry point starts the runtime."));
        let mut after = Buffer::empty(area);
        Paragraph::new(transcript).render(area, &mut after);

        for y in 0..LOGO_PIXELS.len() as u16 {
            for x in 0..area.width {
                assert_eq!(before[(x, y)], after[(x, y)]);
            }
        }
        assert_eq!(after[(0, LOGO_PIXELS.len() as u16)].symbol(), "Y");
        assert_eq!(identity.raw_lines(), vec![Line::from("Elpis")]);
    }

    #[test]
    fn retained_identity_reflows_without_wrapping_or_cropping() {
        let identity = StartupAnimation::new(false).into_history_cell(40);
        for width in [0, 1, 4, 5, 32, 64, 65, 80] {
            let lines = identity.display_lines(width);
            assert!(lines.iter().all(|line| line.width() <= usize::from(width)));
            if width == 0 {
                assert!(lines.is_empty());
            } else if width < 65 {
                assert_eq!(lines.len(), 1);
            }
        }
        let short_terminal = StartupAnimation::new(false).into_history_cell(12);
        assert_eq!(short_terminal.display_lines(100).len(), 1);
    }

    #[test]
    fn enabled_animation_changes_color_across_frames() {
        let animation = StartupAnimation::new(/*animations_enabled*/ true);
        let first = rendered(&animation, 100, 24, Duration::ZERO);
        let later = rendered(&animation, 100, 24, Duration::from_millis(480));
        let colored_cells = |buf: &Buffer| {
            buf.content
                .iter()
                .filter(|cell| cell.fg != Color::Reset)
                .map(|cell| cell.fg)
                .collect::<Vec<_>>()
        };

        assert_ne!(colored_cells(&first), colored_cells(&later));
    }

    #[test]
    fn disabled_animation_is_stable() {
        let animation = StartupAnimation::new(/*animations_enabled*/ false);
        let first = rendered(&animation, 100, 24, Duration::ZERO);
        let later = rendered(&animation, 100, 24, Duration::from_millis(480));

        assert_eq!(first, later);
    }

    #[test]
    fn small_frame_uses_compact_fallback() {
        let buf = rendered(
            &StartupAnimation::new(/*animations_enabled*/ true),
            /*width*/ 32,
            /*height*/ 4,
            Duration::from_millis(480),
        );
        let rendered = text(&buf);

        assert!(rendered.contains("Elpis is starting"));
        assert!(!rendered.contains('█'));
    }

    #[test]
    fn number_keys_select_all_supplied_palettes() {
        let mut animation = StartupAnimation::new(/*animations_enabled*/ true);
        for (index, key) in ['1', '2', '3', '4', '5', '6'].into_iter().enumerate() {
            assert_eq!(
                animation.handle_key(KeyEvent::new(KeyCode::Char(key), KeyModifiers::NONE)),
                StartupInput::SelectPalette(index)
            );
            assert_eq!(animation.palette_id(), PALETTE_IDS[index]);
        }
    }

    #[test]
    fn escape_and_ctrl_c_cancel() {
        let mut animation = StartupAnimation::new(/*animations_enabled*/ true);
        assert_eq!(
            animation.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            StartupInput::Cancel
        );
        assert_eq!(
            animation.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            StartupInput::Cancel
        );
    }

    #[tokio::test]
    async fn pending_work_is_redrawn_until_completion() -> Result<(), Infallible> {
        let mut animation = StartupAnimation::new(/*animations_enabled*/ true);
        let draws = Rc::new(Cell::new(0_u32));
        let draw_count = Rc::clone(&draws);
        let result = drive_startup(
            &mut animation,
            tokio::time::sleep(Duration::from_millis(32)),
            tokio_stream::empty(),
            Duration::from_millis(5),
            move |_, _| {
                draw_count.set(draw_count.get() + 1);
                Ok(())
            },
        )
        .await
        .expect("driver succeeds");

        assert!(matches!(result, StartupWait::Completed(())));
        assert!(draws.get() >= 3, "only {} frame(s) were drawn", draws.get());
        Ok(())
    }

    #[tokio::test]
    async fn cancel_input_wins_over_pending_work() {
        let mut animation = StartupAnimation::new(/*animations_enabled*/ true);
        let outcome = tokio::time::timeout(
            Duration::from_millis(50),
            drive_startup(
                &mut animation,
                std::future::pending::<()>(),
                iter([StartupInput::Cancel]),
                Duration::from_millis(5),
                |_, _| Ok(()),
            ),
        )
        .await
        .expect("cancel should not wait for startup work")
        .expect("driver succeeds");

        assert!(matches!(outcome, StartupWait::Cancelled));
    }

    #[tokio::test]
    async fn ready_work_has_no_cosmetic_minimum_delay() {
        let mut animation = StartupAnimation::new(/*animations_enabled*/ true);
        let started = Instant::now();
        let outcome = drive_startup(
            &mut animation,
            std::future::ready(42),
            tokio_stream::empty(),
            Duration::from_secs(1),
            |_, _| Ok(()),
        )
        .await
        .expect("driver succeeds");

        assert_eq!(outcome, StartupWait::Completed(42));
        assert!(started.elapsed() < Duration::from_millis(50));
    }
}
