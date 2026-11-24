//! A one-column scrollbar using the measured heights of rendered messages.
//!
//! Estimate unseen messages from measured heights without laying out the full history.

use super::*;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use ratatui::style::Modifier;
use ratatui::style::Style;
use std::collections::BTreeMap;

/// Scrollbar state; the column stays reserved once the conversation first overflows the screen,
/// so text does not rewrap back and forth at the boundary.
#[derive(Default)]
pub(super) struct Scrollbar {
    reserved: bool,
    track: Option<Rect>,
    dragging: bool,
    measured: BTreeMap<usize, (EntryKey, usize)>,
    estimate: usize,
    width: u16,
    count: usize,
}

impl Scrollbar {
    fn rows_before(&self, index: usize) -> usize {
        let mut unmeasured = index;
        let mut rows = 0;
        for (_, (_, height)) in self.measured.range(..index) {
            unmeasured -= 1;
            rows += height;
        }
        rows + unmeasured * self.estimate
    }

    fn entry_at_row(&self, mut row: usize) -> (usize, usize) {
        let mut next = 0;
        for (&index, &(_, height)) in &self.measured {
            let unseen_rows = (index - next) * self.estimate;
            if row < unseen_rows {
                return (next + row / self.estimate, row % self.estimate);
            }
            row -= unseen_rows;
            if row < height {
                return (index, row);
            }
            row -= height;
            next = index + 1;
        }
        (next + row / self.estimate, row % self.estimate)
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
            let count = self.scrollbar.count;
            let measured = &mut self.scrollbar.measured;
            measured.retain(|index, (key, _)| {
                *index < count
                    && cells
                        .get(*index)
                        .map(EntryKey::cell)
                        .unwrap_or(EntryKey::Live)
                        == *key
            });
            for row in &self.visible {
                measured.insert(row.index, (row.key, row.layout.row_count().max(1)));
            }
            // The live answer's current height is known, but its growth tells us nothing
            // about the unseen history. Limit the influence of tall committed entries too.
            let (rows, samples) = measured
                .range(..cells.len())
                .fold((0_usize, 0_usize), |(sum, count), (_, (_, height))| {
                    (sum + height, count + 1)
                });
            self.scrollbar.estimate = rows.checked_div(samples).unwrap_or(1).clamp(1, 16);
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
            let (index, target_row) = self.scrollbar.entry_at_row(position);
            let index =
                index.min((cells.len() + usize::from(self.live.is_some())).saturating_sub(1));
            self.jump_to_entry(cells, index);
            // Layout work stays bounded to the selected entry and the latest viewport.
            if let Some(layout) = self.layout(cells, index) {
                let row = target_row.min(layout.row_count().saturating_sub(1));
                // Use the same lower limit as wheel scrolling, including near-bottom targets.
                if (index, row) >= self.bottom_start(cells) {
                    self.jump_to_latest();
                    return true;
                }
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
