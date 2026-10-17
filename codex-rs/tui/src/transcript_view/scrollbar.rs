//! A one-column scrollbar using the measured heights of recently visible messages.
//!
//! Unseen messages are estimated at one row, so scrolling never lays out the full history.

use super::*;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use ratatui::style::Modifier;
use ratatui::style::Style;

/// Scrollbar state; the column stays reserved once the conversation first overflows the screen,
/// so text does not rewrap back and forth at the boundary.
#[derive(Default)]
pub(super) struct Scrollbar {
    reserved: bool,
    track: Option<Rect>,
    dragging: bool,
    measured: Vec<(usize, EntryKey, usize)>,
    width: u16,
    count: usize,
}

impl Scrollbar {
    fn rows_before(&self, index: usize) -> usize {
        index
            + self
                .measured
                .iter()
                .filter(|(i, _, _)| *i < index)
                .map(|(_, _, rows)| rows.saturating_sub(1))
                .sum::<usize>()
    }

    fn entry_at_row(&self, row: usize, count: usize) -> (usize, usize) {
        let mut measured: Vec<_> = self
            .measured
            .iter()
            .filter(|(i, _, _)| *i < count)
            .collect();
        measured.sort_unstable_by_key(|(index, _, _)| *index);
        let mut extra = 0;
        for (index, _, height) in measured {
            let start = index + extra;
            if row < start {
                return (row.saturating_sub(extra), 0);
            }
            if row < start + height {
                return (*index, row - start);
            }
            extra += height.saturating_sub(1);
        }
        (row.saturating_sub(extra).min(count.saturating_sub(1)), 0)
    }
}

impl TranscriptView {
    /// Whether the transcript should leave its last column to the scrollbar.
    pub(crate) fn reserves_scrollbar(&self) -> bool {
        self.scrollbar.reserved
    }

    /// Draw the scrollbar in `track` after the body. Returns true when the column was just
    /// reserved, so the caller redraws the body one column narrower.
    pub(crate) fn render_scrollbar(
        &mut self,
        track: Rect,
        buf: &mut Buffer,
        cells: &[Arc<dyn HistoryCell>],
    ) -> bool {
        self.scrollbar.track = None;
        if cells.is_empty() {
            self.scrollbar.reserved = false;
            self.scrollbar.measured.clear();
            return false;
        }
        let top_on_screen = self
            .visible
            .first()
            .is_some_and(|row| row.index == 0 && row.row == 0);
        if !self.scrollbar.reserved {
            self.scrollbar.reserved = !self.visible.is_empty() && !top_on_screen;
            return self.scrollbar.reserved;
        }
        let (Some(first), Some(last)) = (self.visible.first(), self.visible.last()) else {
            return false;
        };
        if track.is_empty() {
            return false;
        }
        if self.scrollbar.width != self.area.width {
            self.scrollbar.measured.clear();
            self.scrollbar.width = self.area.width;
            self.scrollbar.dragging = false;
        }
        if !self.scrollbar.dragging {
            self.scrollbar.count = cells.len().max(last.index + 1);
            self.scrollbar.measured.retain(|(index, key, _)| {
                *index <= cells.len()
                    && cells
                        .get(*index)
                        .map(EntryKey::cell)
                        .unwrap_or(EntryKey::Live)
                        == *key
            });
            for row in &self.visible {
                self.scrollbar
                    .measured
                    .retain(|(index, _, _)| *index != row.index);
                self.scrollbar
                    .measured
                    .push((row.index, row.key, row.layout.row_count().max(1)));
            }
            // Bound work to the recent viewport, like the layout cache.
            let excess = self.scrollbar.measured.len().saturating_sub(64);
            self.scrollbar.measured.drain(..excess);
        }
        let at = |row: &VisibleRow, past: usize| {
            (self.scrollbar.rows_before(row.index) + row.row + past) as f64
        };
        let total = self.scrollbar.rows_before(self.scrollbar.count) as f64;
        let height = usize::from(track.height);
        let top = ((at(first, 0) / total * height as f64) as usize).min(height - 1);
        let bottom = ((at(last, 1) / total * height as f64).ceil() as usize).clamp(top + 1, height);
        for y in 0..track.height {
            let (symbol, style) = if (top..bottom).contains(&usize::from(y)) {
                ("┃", Style::default())
            } else {
                ("│", Style::default().add_modifier(Modifier::DIM))
            };
            buf[(track.x, track.y + y)]
                .set_symbol(symbol)
                .set_style(style);
        }
        self.scrollbar.track = Some(track);
        false
    }

    /// Press or drag on the scrollbar to jump to the message at that height; the last row
    /// returns to the latest message.
    pub(super) fn handle_scrollbar_mouse(
        &mut self,
        event: MouseEvent,
        cells: &[Arc<dyn HistoryCell>],
    ) -> bool {
        let Some(track) = self.scrollbar.track else {
            self.scrollbar.dragging = false;
            return false;
        };
        match event.kind {
            MouseEventKind::Down(MouseButton::Left)
                if track.contains(ratatui::layout::Position::new(event.column, event.row)) =>
            {
                self.scrollbar.dragging = true;
            }
            MouseEventKind::Drag(MouseButton::Left) if self.scrollbar.dragging => {}
            MouseEventKind::Up(MouseButton::Left) if self.scrollbar.dragging => {
                self.scrollbar.dragging = false;
                return true;
            }
            _ => return false,
        }
        let row = event.row.saturating_sub(track.y).min(track.height - 1);
        if row + 1 == track.height {
            self.jump_to_latest();
        } else {
            let height = usize::from(track.height);
            let position =
                usize::from(row) * self.scrollbar.rows_before(self.scrollbar.count) / height;
            let (index, target_row) = self.scrollbar.entry_at_row(position, self.scrollbar.count);
            let index =
                index.min((cells.len() + usize::from(self.live.is_some())).saturating_sub(1));
            self.jump_to_entry(cells, index);
            // Only lay out the selected entry; unseen history remains unrendered.
            if let Some(layout) = self.layout(cells, index) {
                let row = target_row.min(layout.row_count().saturating_sub(1));
                let offset = layout.position_at(row, 0);
                self.position = Position::Reading(Anchor {
                    key: self.entry_key(cells, index),
                    index,
                    offset,
                    row_bias: layout.row_for_offset(offset) as isize - row as isize,
                });
            }
        }
        true
    }
}
