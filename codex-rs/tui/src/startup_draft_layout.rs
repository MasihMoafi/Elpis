//! First-frame owned layout: the banner stays at the top and the normal composer at the bottom.
//! Measurement, paint, and cursor placement use the same bottom rectangle, including both footers.
//! The Context Ledger's column is held from the first frame, as on the live screen.

use crossterm::cursor::SetCursorStyle;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::widgets::Widget;

use super::StartupDraftPump;
use super::StartupDraftSessionAction;
use crate::bottom_pane::CommandPopupPlacement;
use crate::bottom_pane::ComposerRenderOptions;
use crate::render::renderable::Renderable;
use crate::render::renderable::RenderableItem;
use crate::terminal_hyperlinks::HyperlinkParagraph;

pub(super) struct OwnedStartupLayout<'a> {
    pump: &'a StartupDraftPump,
    bottom: RenderableItem<'a>,
}

impl<'a> OwnedStartupLayout<'a> {
    pub(super) fn new(pump: &'a StartupDraftPump) -> Self {
        Self {
            pump,
            bottom: pump
                .bottom_pane
                .as_renderable_with_options(ComposerRenderOptions {
                    separate_status_line: true,
                    command_popup_placement: CommandPopupPlacement::Overlay,
                    ..ComposerRenderOptions::default()
                }),
        }
    }

    /// The part of `area` left of the Ledger's column, which the live screen also reserves.
    fn main_area(&self, area: Rect) -> Rect {
        Rect {
            width: area.width
                - crate::chatwidget::ledger_column_width_for(
                    area.width,
                    self.pump.context_ledger_width,
                ),
            ..area
        }
    }

    pub(super) fn bottom_area(&self, area: Rect) -> Rect {
        let height = self.bottom.desired_height(area.width).min(area.height);
        Rect {
            y: area.bottom().saturating_sub(height),
            height,
            ..area
        }
    }
}

impl Renderable for OwnedStartupLayout<'_> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        let full = area;
        let area = self.main_area(area);
        let bottom = self.bottom_area(area);
        let lines = self.pump.header.display_hyperlink_lines(area.width);
        let paragraph = HyperlinkParagraph::new(&lines, Style::default());
        let header = Rect {
            height: u16::try_from(paragraph.line_count(area.width))
                .unwrap_or(u16::MAX)
                .min(bottom.y.saturating_sub(area.y)),
            ..area
        };
        paragraph.render(header, buf);
        let message = match self.pump.session_action {
            StartupDraftSessionAction::New | StartupDraftSessionAction::NewFromCommandCenter => {
                None
            }
            StartupDraftSessionAction::Resume => Some("  Resuming session…"),
            StartupDraftSessionAction::Fork => Some("  Forking session…"),
        };
        if let Some(message) = message
            && header.bottom() < bottom.y
        {
            message.dim().render(
                Rect {
                    y: header.bottom(),
                    height: 1,
                    ..area
                },
                buf,
            );
        }
        self.bottom.render(bottom, buf);
        // Elpis: the Ledger's column is there from the first frame, level with where the live
        // Ledger starts (one row below the header, like the first transcript line), so a slow
        // start never looks like the Ledger is missing.
        let ledger = Rect {
            x: area.right(),
            width: full.width - area.width,
            ..full
        };
        if ledger.width > 0 {
            crate::chatwidget::render_startup_ledger_column(ledger, header.bottom() + 1, buf);
        }
    }

    fn desired_height(&self, width: u16) -> u16 {
        let width = self.main_area(Rect::new(0, 0, width, 0)).width;
        let lines = self.pump.header.display_hyperlink_lines(width);
        u16::try_from(HyperlinkParagraph::new(&lines, Style::default()).line_count(width))
            .unwrap_or(u16::MAX)
            .saturating_add(self.bottom.desired_height(width))
    }

    fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)> {
        self.bottom
            .cursor_pos(self.bottom_area(self.main_area(area)))
    }

    fn cursor_style(&self, area: Rect) -> SetCursorStyle {
        self.bottom
            .cursor_style(self.bottom_area(self.main_area(area)))
    }
}

#[cfg(test)]
#[path = "startup_draft_layout_tests.rs"]
mod tests;
