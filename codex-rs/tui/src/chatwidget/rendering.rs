// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Render composition for the main chat widget surface.

use super::*;

impl ChatWidget {
    pub(super) fn as_renderable(&self) -> RenderableItem<'_> {
        let active_cell_right_reserve = 0;
        let active_cell_renderable = match &self.transcript.active_cell {
            Some(cell) => RenderableItem::Owned(Box::new(TranscriptAreaRenderable {
                child: cell.as_ref(),
                top: 0,
                right: active_cell_right_reserve,
            })),
            None => RenderableItem::Owned(Box::new(())),
        };
        let active_hook_cell_renderable = match &self.active_hook_cell {
            Some(cell) if cell.should_render() => {
                RenderableItem::Owned(Box::new(TranscriptAreaRenderable {
                    child: cell,
                    top: 0,
                    right: active_cell_right_reserve,
                }))
            }
            _ => RenderableItem::Owned(Box::new(())),
        };
        let mut flex = FlexRenderable::new();
        flex.push(/*flex*/ 1, active_cell_renderable);
        flex.push(/*flex*/ 0, active_hook_cell_renderable);
        if let Some(cell) = self.pending_token_activity_output() {
            flex.push(
                /*flex*/ 1,
                RenderableItem::Owned(Box::new(TranscriptAreaRenderable {
                    child: cell,
                    top: 0,
                    right: active_cell_right_reserve,
                })),
            );
        }
        if let Some(cell) = self.pending_rate_limit_reset_hint() {
            flex.push(
                /*flex*/ 1,
                RenderableItem::Owned(Box::new(TranscriptAreaRenderable {
                    child: cell,
                    top: 0,
                    right: active_cell_right_reserve,
                })),
            );
        }
        flex.push(
            /*flex*/ 0,
            RenderableItem::Owned(Box::new(IdentityLineRenderable { chat_widget: self })).inset(
                Insets::tlbr(
                    /*top*/ 1, /*left*/ 0, /*bottom*/ 0, /*right*/ 0,
                ),
            ),
        );
        flex.push(
            /*flex*/ 0,
            RenderableItem::Owned(Box::new(BottomPaneComposerReserveRenderable {
                bottom_pane: &self.bottom_pane,
                right_reserve: active_cell_right_reserve,
            }))
            .inset(Insets::tlbr(
                /*top*/ 0, /*left*/ 0, /*bottom*/ 0, /*right*/ 0,
            )),
        );
        RenderableItem::Owned(Box::new(flex))
    }
}

/// The cyan identity line (model, context used, location), positioned directly below the
/// composer rather than at the very top of the screen -- separated from both the transcript
/// above and the composer it follows, instead of stuck against the last chat message.
struct IdentityLineRenderable<'a> {
    chat_widget: &'a ChatWidget,
}

impl Renderable for IdentityLineRenderable<'_> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        self.chat_widget.render_identity_line(area, buf);
    }

    fn desired_height(&self, _width: u16) -> u16 {
        1
    }
}

struct BottomPaneComposerReserveRenderable<'a> {
    bottom_pane: &'a BottomPane,
    right_reserve: u16,
}

impl Renderable for BottomPaneComposerReserveRenderable<'_> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        self.bottom_pane
            .render_with_composer_right_reserve(area, buf, self.right_reserve);
    }

    fn desired_height(&self, width: u16) -> u16 {
        self.bottom_pane
            .desired_height_with_composer_right_reserve(width, self.right_reserve)
    }

    fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)> {
        self.bottom_pane
            .cursor_pos_with_composer_right_reserve(area, self.right_reserve)
    }

    fn cursor_style(&self, area: Rect) -> crossterm::cursor::SetCursorStyle {
        self.bottom_pane
            .cursor_style_with_composer_right_reserve(area, self.right_reserve)
    }
}

struct TranscriptAreaRenderable<'a> {
    child: &'a dyn HistoryCell,
    top: u16,
    right: u16,
}

impl Renderable for TranscriptAreaRenderable<'_> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        let area = self.child_area(area);
        let lines = self.child.display_lines(area.width);
        let paragraph = Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false });
        let y = if area.height == 0 {
            0
        } else {
            let overflow = paragraph
                .line_count(area.width)
                .saturating_sub(usize::from(area.height));
            u16::try_from(overflow).unwrap_or(u16::MAX)
        };
        Clear.render(area, buf);
        paragraph.scroll((y, 0)).render(area, buf);
    }

    fn desired_height(&self, width: u16) -> u16 {
        let child_width = width.saturating_sub(self.right).max(1);
        HistoryCell::desired_height(self.child, child_width) + self.top
    }
}

impl TranscriptAreaRenderable<'_> {
    fn child_area(&self, area: Rect) -> Rect {
        let y = area.y.saturating_add(self.top);
        let height = area.height.saturating_sub(self.top);
        Rect::new(
            area.x,
            y,
            area.width.saturating_sub(self.right).max(1),
            height,
        )
    }
}

impl ChatWidget {
    /// Rows from the top of the chat column down to the top edge of the composer box.
    /// The composer is the last child of the chat flex, so this is the column's full
    /// height minus the composer's own height.
    fn composer_top_offset(&self, chat_width: u16) -> u16 {
        let reserve = 0;
        let composer_height = self
            .bottom_pane
            .desired_height_with_composer_right_reserve(chat_width, reserve);
        self.as_renderable()
            .desired_height(chat_width)
            .saturating_sub(composer_height)
    }
}

impl Renderable for ChatWidget {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        let ledger_width = self.context_ledger_width(area.width);
        let chat_area = Rect::new(
            area.x,
            area.y,
            area.width.saturating_sub(ledger_width),
            area.height,
        );
        self.as_renderable().render(chat_area, buf);
        if ledger_width > 0 {
            // Top-align the ledger with the composer box and let it run downward. It is
            // never trimmed to fit: `desired_height` reserves the rows it needs below
            // that point. Bottom-anchoring it instead (the previous behavior) made a tall
            // ledger start level with the last chat message and overhang the status line.
            let ledger_top = area
                .y
                .saturating_add(self.composer_top_offset(chat_area.width));
            let ledger_height = self.context_ledger_desired_height(ledger_width).min(
                area.y
                    .saturating_add(area.height)
                    .saturating_sub(ledger_top),
            );
            self.render_context_ledger(
                Rect::new(
                    chat_area.x.saturating_add(chat_area.width),
                    ledger_top,
                    ledger_width,
                    ledger_height,
                ),
                buf,
            );
        }
        self.last_rendered_width.set(Some(area.width as usize));
    }

    fn desired_height(&self, width: u16) -> u16 {
        let ledger_width = self.context_ledger_width(width);
        let chat_width = width.saturating_sub(ledger_width);
        let chat_height = self.as_renderable().desired_height(chat_width);
        // The ledger starts at the composer's top edge, so the widget needs that offset
        // plus the ledger's full height -- otherwise the panel would be clipped instead
        // of the layout growing to hold it.
        let ledger_height = self.context_ledger_desired_height(ledger_width);
        chat_height.max(self.composer_top_offset(chat_width) + ledger_height)
    }

    fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)> {
        let ledger_width = self.context_ledger_width(area.width);
        let content_area = Rect::new(
            area.x,
            area.y,
            area.width.saturating_sub(ledger_width),
            area.height,
        );
        self.as_renderable().cursor_pos(content_area)
    }

    fn cursor_style(&self, area: Rect) -> crossterm::cursor::SetCursorStyle {
        self.as_renderable().cursor_style(area)
    }
}

impl ChatWidget {
    fn render_identity_line(&self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        let model = self.current_model();
        let location = format_directory_display(self.status_line_cwd(), /*max_width*/ None);
        Line::from(vec![
            " Elpis ".cyan().bold(),
            "· model ".dim(),
            model.cyan(),
            " · location ".dim(),
            location.cyan(),
        ])
        .render(area, buf);
    }
}
