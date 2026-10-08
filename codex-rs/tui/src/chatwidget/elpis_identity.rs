//! The Elpis identity line (" Elpis · model X · location Y · title") above the composer.
//!
//! Copied from Elpis v0.3.0 `chatwidget/rendering.rs` (`IdentityLineRenderable`,
//! `render_identity_line`), tag `stage0-stop-bleeding`.

use super::ChatWidget;
use crate::render::renderable::Renderable;
use crate::status::format_directory_display;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Widget;

/// The branded identity line separates the transcript from the composer below it.
pub(super) struct IdentityLineRenderable<'a> {
    pub(super) chat_widget: &'a ChatWidget,
}

impl Renderable for IdentityLineRenderable<'_> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        self.chat_widget.render_identity_line(area, buf);
    }

    fn desired_height(&self, _width: u16) -> u16 {
        1
    }
}

impl ChatWidget {
    fn render_identity_line(&self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let model = self.current_model();
        let location = format_directory_display(self.status_line_cwd(), /*max_width*/ None);
        let mut spans = vec![" Elpis ".bold()];
        // The reasoning effort follows the model, so Alt+, and Alt+. are visible as they act.
        spans.extend([
            "· model ".dim(),
            Span::raw(model),
            Span::raw(" "),
            self.reasoning_display_name().dim(),
            " · location ".dim(),
            location.dim(),
        ]);
        // The generated conversation title, which upstream shows in its footer status line.
        if let Some(title) = self
            .thread_name
            .as_deref()
            .and_then(super::normalize_thread_name)
        {
            spans.extend([" · ".dim(), Span::raw(title)]);
        }
        Line::from(spans).render(area, buf);
    }
}
