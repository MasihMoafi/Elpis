// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Render composition for the main chat widget surface.

use super::*;
use ratatui::text::Span;

#[cfg(test)]
mod selection_tests {
    use super::*;

    #[test]
    fn live_snapshot_copies_only_visible_source_rows_without_the_bullet() {
        let displayed = std::cell::RefCell::new(Vec::new());
        let cell = history_cell::StreamingAgentTailCell::new(
            vec!["hidden".into(), "visible界".into(), "last".into()],
            true,
        );
        let area = Rect::new(3, 7, 12, 2);
        let mut buffer = Buffer::empty(area);
        TranscriptAreaRenderable {
            child: &cell,
            displayed: &displayed,
            top: 0,
            right: 0,
        }
        .render(area, &mut buffer);
        let snapshot = displayed.borrow_mut().pop().expect("displayed cell");
        assert_eq!(snapshot.area, area);
        let rows =
            crate::pager_overlay::Selection::new(snapshot.lines, area.width, snapshot.scroll)
                .into_visible_rows(area.height);
        let mut selection = crate::pager_overlay::Selection::new(rows, area.width, 0);
        selection.start(area, area.x, area.y);
        selection.update(area, area.right(), area.bottom());
        assert_eq!(selection.text(), "visible界\nlast");
        let visible: String = (area.x..area.right())
            .map(|x| buffer[(x, area.y)].symbol())
            .collect();
        assert!(visible.contains("visible界"));
        assert!(!visible.contains("hidden"));
    }

    #[test]
    fn zero_height_live_cell_does_not_leave_selectable_rows() {
        let displayed = std::cell::RefCell::new(Vec::new());
        let cell = history_cell::PlainHistoryCell::new(vec!["invisible".into()]);
        let area = Rect::new(0, 0, 10, 0);
        TranscriptAreaRenderable {
            child: &cell,
            displayed: &displayed,
            top: 0,
            right: 0,
        }
        .render(area, &mut Buffer::empty(area));
        assert!(displayed.borrow().is_empty());
    }
}

impl ChatWidget {
    pub(super) fn as_renderable(&self) -> RenderableItem<'_> {
        let active_cell_right_reserve = 0;
        let active_cell_renderable = match &self.transcript.active_cell {
            Some(cell) => RenderableItem::Owned(Box::new(TranscriptAreaRenderable {
                child: cell.as_ref(),
                displayed: &self.displayed_live_cells,
                top: 0,
                right: active_cell_right_reserve,
            })),
            None => RenderableItem::Owned(Box::new(())),
        };
        let active_hook_cell_renderable = match &self.active_hook_cell {
            Some(cell) if cell.should_render() => {
                RenderableItem::Owned(Box::new(TranscriptAreaRenderable {
                    child: cell,
                    displayed: &self.displayed_live_cells,
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
                    displayed: &self.displayed_live_cells,
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

/// The branded identity line separates the transcript from the composer below it.
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
    displayed: &'a std::cell::RefCell<Vec<DisplayedLiveCell>>,
    top: u16,
    right: u16,
}

pub(super) struct DisplayedLiveCell {
    area: Rect,
    lines: Vec<HyperlinkLine>,
    scroll: usize,
}

impl Renderable for TranscriptAreaRenderable<'_> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        let area = self.child_area(area);
        let lines = self.child.display_hyperlink_lines(area.width);
        let paragraph = Paragraph::new(Text::from(crate::terminal_hyperlinks::visible_lines(
            lines.clone(),
        )))
        .wrap(Wrap { trim: false });
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
        if !area.is_empty() {
            self.displayed.borrow_mut().push(DisplayedLiveCell {
                area,
                lines,
                scroll: usize::from(y),
            });
        }
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
    pub(crate) fn clear_displayed_live_rows(&self) {
        self.displayed_live_cells.borrow_mut().clear();
    }

    pub(crate) fn displayed_live_rows(&self) -> Vec<(Rect, Vec<HyperlinkLine>)> {
        self.displayed_live_cells
            .borrow()
            .iter()
            .map(|cell| {
                let rows = crate::pager_overlay::Selection::new(
                    cell.lines.clone(),
                    cell.area.width,
                    cell.scroll,
                )
                .into_visible_rows(cell.area.height);
                (cell.area, rows)
            })
            .collect()
    }

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
        self.displayed_live_cells.borrow_mut().clear();
        let ledger_width = self.context_ledger_width(area.width);
        let chat_area = Rect::new(
            area.x,
            area.y,
            area.width.saturating_sub(ledger_width),
            area.height,
        );
        self.as_renderable().render(chat_area, buf);
        let stream_height = self
            .transcript
            .active_cell
            .as_ref()
            .map(|cell| cell.desired_height(chat_area.width))
            .unwrap_or(0)
            .min(self.composer_top_offset(chat_area.width).saturating_sub(1));
        let stream_area = Rect::new(chat_area.x, chat_area.y, chat_area.width, stream_height);
        let stream_animating = self.stream_motion.borrow_mut().render(
            buf,
            stream_area,
            self.config.animations
                && (self.has_active_agent_stream() || self.has_active_plan_stream()),
            true,
        );
        if stream_animating {
            self.frame_requester
                .schedule_frame_in(crate::elpis_motion::FRAME_TICK);
        }
        if let Some((ledger_desired_height, ledger_lines)) =
            self.context_ledger_lines_with_height(ledger_width)
        {
            // Top-align the ledger with the composer box and let it run downward. It is
            // never trimmed to fit: `desired_height` reserves the rows it needs below
            // that point. Bottom-anchoring it instead (the previous behavior) made a tall
            // ledger start level with the last chat message and overhang the status line.
            let ledger_top = area
                .y
                .saturating_add(self.composer_top_offset(chat_area.width));
            let ledger_height = ledger_desired_height.min(
                area.y
                    .saturating_add(area.height)
                    .saturating_sub(ledger_top),
            );
            self.render_context_ledger_lines(
                Rect::new(
                    chat_area.x.saturating_add(chat_area.width),
                    ledger_top,
                    ledger_width,
                    ledger_height,
                ),
                buf,
                ledger_lines,
            );
            let ledger_area = Rect::new(chat_area.right(), ledger_top, ledger_width, ledger_height);
            if self.ledger_motion.borrow_mut().render(
                buf,
                ledger_area,
                self.config.animations,
                false,
            ) {
                self.frame_requester
                    .schedule_frame_in(crate::elpis_motion::FRAME_TICK);
            }
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
        if ledger_width > 0 && self.context_ledger_has_focus() {
            return None;
        }
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
        self.bottom_pane.set_composer_selection_header_area(area);
        if area.is_empty() {
            return;
        }
        let model = self.current_model();
        let location = format_directory_display(self.status_line_cwd(), /*max_width*/ None);
        let animate_identity = self.config.animations && self.turn_lifecycle.agent_turn_running;
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
        spans.extend([
            "· model ".dim(),
            Span::raw(model),
            " · location ".dim(),
            location.dim(),
        ]);
        Line::from(spans).render(area, buf);
    }
}
