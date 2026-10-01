//! The Elpis identity line (" Elpis · model X · location Y · title") above the composer, and the
//! turn clock the paced Elpis motion samples.
//!
//! Copied from Elpis v0.3.0 `chatwidget/rendering.rs` (`IdentityLineRenderable`,
//! `render_identity_line`) and `chatwidget/status_surfaces.rs`
//! (`terminal_title_animation_elapsed_at`), tag `stage0-stop-bleeding`.

use std::time::Duration;
use std::time::Instant;

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
        let animate_identity =
            self.local_settings.tui.animations && self.turn_lifecycle.agent_turn_running;
        let mut spans = if animate_identity {
            let elapsed = self
                .turn_lifecycle
                .goal_status_active_turn_started_at
                .map(|started| started.elapsed())
                .unwrap_or_else(crate::elpis_motion::elapsed);
            let (sample_at, next_frame_in) = crate::elpis_motion::paced_motion(elapsed);
            self.frame_requester.schedule_frame_in(next_frame_in);
            crate::elpis_motion::animated_text_at(" Elpis ", sample_at)
        } else {
            crate::elpis_motion::animated_text(" Elpis ", /*animated*/ false)
        };
        for span in &mut spans {
            span.style = span.style.add_modifier(ratatui::style::Modifier::BOLD);
        }
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
        if let Some(title) = self.thread_name.as_deref().and_then(super::normalize_thread_name) {
            spans.extend([" · ".dim(), Span::raw(title)]);
        }
        Line::from(spans).render(area, buf);
    }

    pub(super) fn terminal_title_animation_elapsed_at(&self, now: Instant) -> Duration {
        self.turn_lifecycle
            .goal_status_active_turn_started_at
            .map(|started| now.saturating_duration_since(started))
            .unwrap_or_else(|| now.saturating_duration_since(self.terminal_title_animation_origin))
    }
}
