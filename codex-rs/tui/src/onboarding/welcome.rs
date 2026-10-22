//! Shared welcome header for the sign-in and Bedrock onboarding pickers.
//! The Elpis mark occupies the blossom's fixed stage above the choices.

use crossterm::event::KeyEvent;
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

use crate::empty_state_animation::HEIGHT;
use crate::empty_state_animation::WIDTH;
use crate::empty_state_animation::render_mark;
use crate::onboarding::onboarding_screen::KeyboardHandler;
use crate::onboarding::onboarding_screen::StepStateProvider;

use super::onboarding_screen::StepState;

pub(crate) struct WelcomeWidget {
    pub is_logged_in: bool,
    mark_enabled: bool,
    mark_hidden: Cell<bool>,
    layout_area: Cell<Option<Rect>>,
}

impl KeyboardHandler for WelcomeWidget {
    fn handle_key_event(&mut self, _key_event: KeyEvent) {}
}

impl WelcomeWidget {
    pub(crate) fn new(is_logged_in: bool, mark_enabled: bool) -> Self {
        Self {
            is_logged_in,
            mark_enabled,
            mark_hidden: Cell::new(false),
            layout_area: Cell::new(None),
        }
    }

    pub(crate) fn set_mark_hidden(&self, hidden: bool) {
        self.mark_hidden.set(hidden);
    }

    pub(crate) fn update_layout_area(&self, area: Rect) {
        self.layout_area.set(Some(area));
    }
}

impl WidgetRef for &WelcomeWidget {
    fn render_ref(&self, area: Rect, buf: &mut Buffer) {
        Clear.render(area, buf);
        // Onboarding measures in the full viewport, then paints into a shorter
        // rectangle. Both passes must use the same visibility decision.
        let layout_area = self.layout_area.get().unwrap_or(area);
        let show_logo = self.mark_enabled
            && !self.mark_hidden.get()
            && layout_area.width >= 64
            && layout_area.height >= 41;
        if show_logo {
            render_mark(Rect::new(area.x, area.y, WIDTH, HEIGHT), buf);
        }
        let logo_rows = if show_logo { HEIGHT + 1 } else { 0 };
        let text_area = Rect::new(
            area.x,
            area.y + logo_rows,
            area.width,
            area.height.saturating_sub(logo_rows),
        );
        Paragraph::new(Line::from(vec![
            "  ".into(),
            "Welcome to ".into(),
            crate::branding::PRODUCT_NAME.bold(),
        ]))
        .wrap(Wrap { trim: false })
        .render(text_area, buf);
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
    use pretty_assertions::assert_eq;

    fn visible(buffer: &Buffer) -> String {
        buffer
            .content
            .chunks(usize::from(buffer.area.width))
            .map(|row| {
                row.iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim_end()
            .to_owned()
    }

    fn has_mark(buffer: &Buffer) -> bool {
        buffer.content.iter().any(|cell| {
            cell.symbol()
                .chars()
                .any(|c| ('\u{2801}'..='\u{28ff}').contains(&c))
        })
    }

    #[test]
    fn welcome_draws_elpis_mark_in_the_reserved_stage() {
        for width in [80, 120] {
            let widget = WelcomeWidget::new(false, true);
            let area = Rect::new(0, 0, width, 41);
            let mut buf = Buffer::empty(area);
            (&widget).render_ref(area, &mut buf);
            assert!(has_mark(&buf));
            assert!(
                visible(&buf)
                    .lines()
                    .nth(22)
                    .unwrap()
                    .contains("Welcome to Elpis")
            );
        }
    }

    #[test]
    fn welcome_disabled_and_small_viewports_keep_the_text() {
        for (enabled, width, height) in [
            (false, 80, 41),
            (true, 63, 41),
            (true, 80, 40),
            (true, 0, 0),
        ] {
            let widget = WelcomeWidget::new(false, enabled);
            let area = Rect::new(0, 0, width, height);
            let mut buf = Buffer::empty(area);
            (&widget).render_ref(area, &mut buf);
            assert!(!has_mark(&buf));
            if width != 0 {
                assert_eq!(visible(&buf), "  Welcome to Elpis");
            }
        }
    }

    #[test]
    fn welcome_mark_keeps_default_foreground_and_layout() {
        let widget = WelcomeWidget::new(false, true);
        let area = Rect::new(0, 0, 80, 41);
        let mut buf = Buffer::empty(area);
        (&widget).render_ref(area, &mut buf);
        let first = buf.clone();
        (&widget).render_ref(area, &mut buf);
        assert!(has_mark(&buf));
        assert_eq!(buf, first);
        assert!(
            buf.content
                .iter()
                .all(|cell| cell.fg == ratatui::style::Color::Reset)
        );
    }

    #[test]
    fn welcome_copyable_auth_material_hides_the_stage() {
        let widget = WelcomeWidget::new(false, true);
        widget.set_mark_hidden(true);
        let area = Rect::new(0, 0, 80, 41);
        let mut buf = Buffer::empty(area);
        (&widget).render_ref(area, &mut buf);
        assert_eq!(visible(&buf), "  Welcome to Elpis");
    }

    #[test]
    fn welcome_mark_snapshots() {
        use crate::terminal_palette::with_test_default_colors;
        use crate::terminal_probe::DefaultColors;
        for (theme, fg, bg) in [
            ("light", (30, 30, 30), (255, 255, 255)),
            ("dark", (220, 220, 220), (15, 20, 37)),
        ] {
            with_test_default_colors(DefaultColors { fg, bg }, || {
                for width in [80, 120] {
                    let widget = WelcomeWidget::new(false, true);
                    let area = Rect::new(0, 0, width, 41);
                    let mut buf = Buffer::empty(area);
                    (&widget).render_ref(area, &mut buf);
                    insta::assert_debug_snapshot!(format!("elpis_welcome_{theme}_{width}"), buf);
                }
            });
        }
    }
}
