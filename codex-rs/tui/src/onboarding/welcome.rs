//! Shared welcome header for the existing sign-in and Bedrock onboarding pickers.

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

use crate::onboarding::onboarding_screen::KeyboardHandler;
use crate::onboarding::onboarding_screen::StepStateProvider;

use super::onboarding_screen::StepState;

pub(crate) struct WelcomeWidget {
    pub is_logged_in: bool,
}

impl KeyboardHandler for WelcomeWidget {
    fn handle_key_event(&mut self, _key_event: KeyEvent) {}
}

impl WelcomeWidget {
    pub(crate) fn new(is_logged_in: bool) -> Self {
        Self { is_logged_in }
    }
}

impl WidgetRef for &WelcomeWidget {
    fn render_ref(&self, area: Rect, buf: &mut Buffer) {
        Clear.render(area, buf);
        Paragraph::new(vec![Line::from(vec![
            "  ".into(),
            "Welcome to ".into(),
            crate::branding::PRODUCT_NAME.bold(),
        ])])
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
    use pretty_assertions::assert_eq;

    /// The welcome is a line of text: no logo or animation is drawn above or beside it.
    #[test]
    fn welcome_is_one_line_of_text_whatever_the_size() {
        let widget = WelcomeWidget::new(/*is_logged_in*/ false);
        for (width, height) in [(160, 48), (64, 41), (40, 10)] {
            let area = Rect::new(/*x*/ 0, /*y*/ 0, width, height);
            let mut buf = Buffer::empty(area);
            (&widget).render_ref(area, &mut buf);
            let rows: Vec<String> = (0..height)
                .map(|y| {
                    (0..width)
                        .map(|x| buf[(x, y)].symbol())
                        .collect::<String>()
                        .trim_end()
                        .to_owned()
                })
                .filter(|row| !row.is_empty())
                .collect();
            assert_eq!(
                rows,
                vec![format!("  Welcome to {}", crate::branding::PRODUCT_NAME)],
                "{width}x{height}"
            );
        }
    }
}
