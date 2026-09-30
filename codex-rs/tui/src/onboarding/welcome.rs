//! Shared welcome header for the existing sign-in and Bedrock onboarding pickers.
//!
//! Elpis: v0.3.0's ASCII animation sits above the welcome line; Codex's `>_` logo is never
//! drawn. While the user types or the terminal is unfocused the frame holds still, dimmed.

use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::prelude::Widget;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::widgets::Clear;
use ratatui::widgets::Paragraph;
use ratatui::widgets::WidgetRef;
use ratatui::widgets::Wrap;
use std::cell::Cell;

use crate::ascii_animation::AsciiAnimation;
use crate::empty_state_animation::Presentation;
use crate::key_hint::KeyBindingListExt;
use crate::onboarding::keys;
use crate::onboarding::onboarding_screen::KeyboardHandler;
use crate::onboarding::onboarding_screen::StepStateProvider;
use crate::tui::FrameRequester;

use super::onboarding_screen::StepState;

const MIN_ANIMATION_HEIGHT: u16 = 37;
const MIN_ANIMATION_WIDTH: u16 = 60;

pub(crate) struct WelcomeWidget {
    pub is_logged_in: bool,
    animation: AsciiAnimation,
    animations_enabled: bool,
    presentation: Cell<Presentation>,
    focused: Cell<bool>,
    layout_area: Cell<Option<Rect>>,
}

impl KeyboardHandler for WelcomeWidget {
    /// Switch to another animation variant when the logo shortcut fires.
    ///
    /// The key list includes compatibility variants for terminals that report
    /// modifier bits differently.
    fn handle_key_event(&mut self, key_event: KeyEvent) {
        if !self.animations_enabled {
            return;
        }
        if key_event.kind == KeyEventKind::Press && keys::TOGGLE_ANIMATION.is_pressed(key_event) {
            let _ = self.animation.pick_random_variant();
        }
    }
}

impl WelcomeWidget {
    pub(crate) fn new(
        is_logged_in: bool,
        request_frame: FrameRequester,
        animations_enabled: bool,
    ) -> Self {
        Self {
            is_logged_in,
            animation: AsciiAnimation::new(request_frame),
            animations_enabled,
            presentation: Cell::new(Presentation::Animated),
            focused: Cell::new(/*value*/ true),
            layout_area: Cell::new(None),
        }
    }

    pub(crate) fn update_layout_area(&self, area: Rect) {
        self.layout_area.set(Some(area));
    }

    pub(crate) fn set_presentation(&self, presentation: Presentation) {
        self.presentation.set(presentation);
    }

    pub(crate) fn set_focused(&self, focused: bool) {
        self.focused.set(focused);
    }
}

impl WidgetRef for &WelcomeWidget {
    fn render_ref(&self, area: Rect, buf: &mut Buffer) {
        Clear.render(area, buf);
        let layout_area = self.layout_area.get().unwrap_or(area);
        // Skip the animation entirely when the viewport is too small so we don't clip frames.
        let show_animation = self.animations_enabled
            && self.presentation.get() != Presentation::Hidden
            && layout_area.height >= MIN_ANIMATION_HEIGHT
            && layout_area.width >= MIN_ANIMATION_WIDTH;
        let faded = !self.focused.get() || self.presentation.get() == Presentation::Faded;

        let mut lines: Vec<Line> = Vec::new();
        if show_animation {
            if !faded {
                self.animation.schedule_next_frame();
            }
            let frame = self.animation.current_frame();
            lines.extend(frame.lines().map(|line| {
                if faded {
                    Line::from(line).dim()
                } else {
                    Line::from(line)
                }
            }));
            lines.push("".into());
        }
        lines.push(Line::from(vec![
            "  ".into(),
            "Welcome to ".into(),
            ratatui::style::Styled::set_style(
                crate::branding::PRODUCT_NAME,
                crate::style::brand_style(),
            ),
            ", with Elpis as the active runtime".into(),
        ]));

        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .render(area, buf);
    }
}

impl StepStateProvider for WelcomeWidget {
    fn get_step_state(&self) -> StepState {
        match self.is_logged_in {
            true => StepState::Hidden,
            false => StepState::Complete,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyCode;
    use crossterm::event::KeyModifiers;
    use pretty_assertions::assert_eq;

    static VARIANT_A: [&str; 1] = ["frame-a"];
    static VARIANT_B: [&str; 1] = ["frame-b"];
    static VARIANTS: [&[&str]; 2] = [&VARIANT_A, &VARIANT_B];

    fn row_containing(buf: &Buffer, needle: &str) -> Option<u16> {
        (0..buf.area.height).find(|&y| {
            let mut row = String::new();
            for x in 0..buf.area.width {
                row.push_str(buf[(x, y)].symbol());
            }
            row.contains(needle)
        })
    }

    fn welcome() -> WelcomeWidget {
        WelcomeWidget::new(
            /*is_logged_in*/ false,
            FrameRequester::test_dummy(),
            /*animations_enabled*/ true,
        )
    }

    fn with_variants() -> WelcomeWidget {
        WelcomeWidget {
            is_logged_in: false,
            animation: AsciiAnimation::with_variants(
                FrameRequester::test_dummy(),
                &VARIANTS,
                /*variant_idx*/ 0,
            ),
            animations_enabled: true,
            presentation: Cell::new(Presentation::Animated),
            focused: Cell::new(/*value*/ true),
            layout_area: Cell::new(None),
        }
    }

    #[test]
    fn welcome_renders_animation_on_first_draw() {
        let widget = welcome();
        let area = Rect::new(0, 0, MIN_ANIMATION_WIDTH, MIN_ANIMATION_HEIGHT);
        let mut buf = Buffer::empty(area);
        let frame_lines = widget.animation.current_frame().lines().count() as u16;
        (&widget).render_ref(area, &mut buf);

        let welcome_row = row_containing(&buf, "Welcome");
        assert_eq!(welcome_row, Some(frame_lines + 1));
        assert_eq!(
            row_containing(&buf, crate::branding::PRODUCT_NAME),
            welcome_row
        );
        widget.set_focused(/*focused*/ false);
        (&widget).render_ref(area, &mut buf);
        assert_eq!(row_containing(&buf, "Welcome"), welcome_row);
    }

    #[test]
    fn welcome_skips_animation_below_height_breakpoint() {
        let widget = welcome();
        let area = Rect::new(0, 0, MIN_ANIMATION_WIDTH, MIN_ANIMATION_HEIGHT - 1);
        let mut buf = Buffer::empty(area);
        (&widget).render_ref(area, &mut buf);

        assert_eq!(row_containing(&buf, "Welcome"), Some(0));
    }

    #[test]
    fn hidden_presentation_draws_no_art() {
        let widget = welcome();
        widget.set_presentation(Presentation::Hidden);
        let area = Rect::new(0, 0, MIN_ANIMATION_WIDTH, MIN_ANIMATION_HEIGHT);
        let mut buf = Buffer::empty(area);
        (&widget).render_ref(area, &mut buf);

        assert_eq!(row_containing(&buf, "Welcome"), Some(0));
    }

    /// Codex 0.159 drew its braille `>_` logo here at 160x48. The v0.3.0 art uses none.
    #[test]
    fn welcome_never_draws_the_codex_logo() {
        let widget = welcome();
        let area = Rect::new(0, 0, 160, 48);
        let mut buf = Buffer::empty(area);
        let frame_lines = widget.animation.current_frame().lines().count() as u16;
        (&widget).render_ref(area, &mut buf);

        assert_eq!(row_containing(&buf, "Welcome"), Some(frame_lines + 1));
        let braille = (0..area.height)
            .flat_map(|y| (0..area.width).map(move |x| (x, y)))
            .filter(|&(x, y)| {
                buf[(x, y)]
                    .symbol()
                    .chars()
                    .any(|c| ('\u{2800}'..='\u{28ff}').contains(&c))
            })
            .count();
        assert_eq!(braille, 0);
    }

    #[test]
    fn ctrl_dot_changes_animation_variant() {
        let mut widget = with_variants();
        let before = widget.animation.current_frame();
        widget.handle_key_event(KeyEvent::new(KeyCode::Char('.'), KeyModifiers::CONTROL));
        assert_ne!(
            before,
            widget.animation.current_frame(),
            "expected ctrl+. to switch welcome animation variant"
        );
    }

    #[test]
    fn ctrl_shift_dot_changes_animation_variant() {
        let mut widget = with_variants();
        let before = widget.animation.current_frame();
        widget.handle_key_event(KeyEvent::new(
            KeyCode::Char('.'),
            KeyModifiers::CONTROL | KeyModifiers::SHIFT,
        ));
        assert_ne!(
            before,
            widget.animation.current_frame(),
            "expected ctrl+shift+. to switch welcome animation variant"
        );
    }
}
