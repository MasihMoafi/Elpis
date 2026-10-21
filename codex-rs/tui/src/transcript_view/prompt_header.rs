//! Keep the prompt associated with the first visible answer in a presentation-only top row.
//! Selection addresses the original prompt; the header never adds transcript content.
//! A header that yields at a turn boundary stays hidden while that viewport and top row are held.

use super::*;
use crate::history_cell::UserHistoryCell;
use crate::history_cell::sanitize_user_text;
use crate::line_truncation::truncate_line_with_ellipsis_if_overflow;
use unicode_segmentation::UnicodeSegmentation;

/// Screen columns in the abbreviated header address the original prompt's source offsets.
pub(super) struct PinnedPrompt {
    pub(super) area: Rect,
    pub(super) index: usize,
    pub(super) key: EntryKey,
    pub(super) layout: Arc<TextLayout>,
    positions: Vec<usize>,
    content_columns: std::ops::Range<usize>,
}

impl PinnedPrompt {
    pub(super) fn new(
        area: Rect,
        index: usize,
        key: EntryKey,
        layout: Arc<TextLayout>,
        header: &Line<'_>,
    ) -> Self {
        let source = layout.text();
        let mut offset = source.len() - source.trim_start().len();
        let mut positions = vec![offset; 2]; // The prompt marker is display-only.
        let displayed = header.to_string();
        for grapheme in displayed
            .strip_prefix("› ")
            .unwrap_or(&displayed)
            .graphemes(true)
        {
            let next = if grapheme == " " {
                source.len() - source[offset..].trim_start().len()
            } else if source[offset..].starts_with(grapheme) {
                offset + grapheme.len()
            } else {
                // An ellipsis or attachment label has no corresponding source text.
                break;
            };
            positions.extend(std::iter::repeat_n(
                offset,
                crate::width::display_width(grapheme),
            ));
            offset = next;
        }
        let content_columns = 2..positions.len();
        positions.push(offset);
        Self {
            area,
            index,
            key,
            layout,
            positions,
            content_columns,
        }
    }

    pub(super) fn hit_test(&self, column: u16) -> (Anchor, Arc<TextLayout>) {
        let column = usize::from(column.saturating_sub(self.area.x));
        let offset = self.positions[column.min(self.positions.len() - 1)];
        (
            Anchor {
                key: self.key,
                index: self.index,
                offset,
                row_bias: 0,
            },
            Arc::clone(&self.layout),
        )
    }

    pub(super) fn highlight(&self, start: Anchor, end: Anchor, buf: &mut Buffer) {
        if self.index < start.index || self.index > end.index {
            return;
        }
        let begin = if self.key == start.key {
            start.offset
        } else {
            0
        };
        let finish = if self.key == end.key {
            end.offset
        } else {
            self.layout.text().len()
        };
        for column in self.content_columns.clone() {
            let offset = self.positions[column];
            let next = self.positions[column + 1..]
                .iter()
                .copied()
                .find(|next| *next > offset)
                .unwrap_or(offset);
            if offset < finish && next > begin {
                buf.set_style(
                    Rect::new(self.area.x + column as u16, self.area.y, 1, 1),
                    crate::style::selection_style(),
                );
            }
        }
    }
}

/// Remember only a header canceled at a turn boundary, not a missing preceding prompt.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct SuppressedHeader {
    pub(super) viewport: Rect,
    pub(super) key: EntryKey,
    pub(super) row: usize,
}

pub(super) fn line(
    cells: &[Arc<dyn HistoryCell>],
    first: usize,
    width: u16,
) -> Option<Line<'static>> {
    let prompt = cells[index(cells, first, width)?]
        .as_any()
        .downcast_ref::<UserHistoryCell>()?;
    // Bound work even for pasted multi-megabyte prompts; sanitize before painting controls.
    let prefix: String = prompt.message.chars().take(/*n*/ 512).collect();
    let message = sanitize_user_text(prefix.into())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let message = if message.is_empty() {
        "[attachments]".to_owned()
    } else {
        message
    };
    Some(truncate_line_with_ellipsis_if_overflow(
        Line::from(vec![
            if prompt.spoken {
                "› ".red().bold()
            } else {
                "› ".bold().dim()
            },
            message.into(),
        ])
        .style(crate::style::history_prompt_style()),
        usize::from(width.saturating_sub(1)),
    ))
}

pub(super) fn index(cells: &[Arc<dyn HistoryCell>], first: usize, width: u16) -> Option<usize> {
    // A prompt that is still visible supplies its own context. Only pin a preceding prompt.
    if width < 16
        || cells
            .get(first)
            .and_then(|cell| cell.as_any().downcast_ref::<UserHistoryCell>())
            .is_some_and(UserHistoryCell::has_visible_content)
    {
        return None;
    }
    cells[..first.min(cells.len())].iter().rposition(|cell| {
        cell.as_any()
            .downcast_ref::<UserHistoryCell>()
            .is_some_and(UserHistoryCell::has_visible_content)
    })
}

#[cfg(test)]
#[path = "prompt_header_tests.rs"]
mod tests;
