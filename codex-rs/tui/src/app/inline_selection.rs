use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseButton;
use crossterm::event::MouseEventKind;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::layout::Rect;

use super::App;
use crate::pager_overlay::Selection;
use crate::tui::Tui;
use crate::tui::TuiEvent;

pub(super) struct InlineHistorySelection {
    area: Rect,
    paint_areas: Vec<Rect>,
    selection: Selection,
}

impl InlineHistorySelection {
    fn paint(&mut self, tui: &mut Tui) -> std::io::Result<()> {
        let mut buffer = Buffer::empty(self.area);
        self.selection.render(self.area, &mut buffer);
        tui.draw_selection_buffer(&buffer, &self.paint_areas)
    }
}

impl App {
    pub(super) fn handle_inline_history_selection(
        &mut self,
        tui: &mut Tui,
        event: &TuiEvent,
    ) -> std::io::Result<bool> {
        if matches!(event, TuiEvent::Resize) {
            tui.invalidate_saved_history_rows();
            self.chat_widget.clear_displayed_live_rows();
        }
        if self.overlay.is_some() {
            self.inline_history_selection = None;
            return Ok(false);
        }
        match event {
            TuiEvent::Mouse(mouse) if mouse.kind == MouseEventKind::Down(MouseButton::Left) => {
                let viewport = tui.terminal.viewport_area;
                let history = tui.terminal.history_rows();
                let history_area = Rect::new(
                    0,
                    viewport.y.saturating_sub(history.len() as u16),
                    viewport.width,
                    history.len() as u16,
                );
                let mut segments = self.chat_widget.displayed_live_rows();
                segments.insert(0, (history_area, history.to_vec()));
                segments.retain(|(area, _)| !area.is_empty());
                if segments
                    .iter()
                    .any(|(area, _)| area.contains(Position::new(mouse.column, mouse.row)))
                {
                    let area = segments
                        .iter()
                        .map(|(area, _)| *area)
                        .reduce(|area, next| area.union(next))
                        .expect("mouse is inside a displayed segment");
                    let mut rows = vec![
                        crate::terminal_hyperlinks::HyperlinkLine::from("");
                        usize::from(area.height)
                    ];
                    let mut paint_areas = Vec::new();
                    for (segment, lines) in segments {
                        for (offset, line) in lines.into_iter().enumerate() {
                            rows[usize::from(segment.y - area.y) + offset] = line;
                        }
                        paint_areas.push(segment);
                    }
                    let mut selection = Selection::new(rows, area.width, 0);
                    selection.start(area, mouse.column, mouse.row);
                    self.inline_history_selection = Some(InlineHistorySelection {
                        area,
                        paint_areas,
                        selection,
                    });
                    return Ok(true);
                }
            }
            TuiEvent::Mouse(mouse) => {
                if let Some(held) = &mut self.inline_history_selection {
                    match mouse.kind {
                        MouseEventKind::Drag(MouseButton::Left)
                        | MouseEventKind::Up(MouseButton::Left) => {
                            held.selection.update(held.area, mouse.column, mouse.row);
                            held.paint(tui)?;
                            if mouse.kind == MouseEventKind::Up(MouseButton::Left) {
                                held.selection.dragging = false;
                                self.copy_inline_history_selection();
                                tui.frame_requester().schedule_frame();
                            }
                            return Ok(true);
                        }
                        _ => {}
                    }
                }
            }
            TuiEvent::Key(key)
                if key.code == KeyCode::Char('c')
                    && key.modifiers.contains(KeyModifiers::CONTROL) =>
            {
                if self
                    .inline_history_selection
                    .as_ref()
                    .is_some_and(|held| !held.selection.text().is_empty())
                {
                    self.copy_inline_history_selection();
                    return Ok(true);
                }
            }
            TuiEvent::Draw if self.inline_history_selection.is_some() => return Ok(true),
            TuiEvent::Resize => {
                self.inline_history_selection = None;
                return Ok(false);
            }
            _ => {}
        }
        if let Some(mut held) = self.inline_history_selection.take() {
            held.selection.start(held.area, held.area.x, held.area.y);
            held.paint(tui)?;
            tui.frame_requester().schedule_frame();
            if matches!(event, TuiEvent::Key(key) if key.code == KeyCode::Esc) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn copy_inline_history_selection(&mut self) {
        let Some(held) = &self.inline_history_selection else {
            return;
        };
        let text = held.selection.text();
        if text.is_empty() {
            self.inline_history_selection = None;
            return;
        }
        match crate::clipboard_copy::copy_to_clipboard(&text) {
            Ok(Some(lease)) => self.chat_widget.retain_clipboard_lease(lease),
            Ok(None) => {}
            Err(error) => {
                self.inline_history_selection = None;
                self.chat_widget.add_error_message(error);
            }
        }
    }
}
