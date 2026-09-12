use std::ops::Range;
use std::sync::Arc;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;
use ratatui::widgets::Wrap;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::terminal_hyperlinks::HyperlinkLine;
use crate::terminal_hyperlinks::mark_buffer_hyperlinks;
use crate::terminal_hyperlinks::remap_wrapped_line;

pub(super) struct Selection {
    rows: Vec<HyperlinkLine>,
    anchor: (usize, usize),
    focus: (usize, usize),
    pub(super) scroll: usize,
    pub(super) dragging: bool,
}

impl Selection {
    pub(super) fn new(lines: Vec<HyperlinkLine>, width: u16, scroll: usize) -> Self {
        let mut rows = Vec::new();
        if width > 0 {
            for line in lines {
                let paragraph = Paragraph::new(line.line.clone()).wrap(Wrap { trim: false });
                let height = paragraph.line_count(width).max(1).min(u16::MAX as usize) as u16;
                let area = Rect::new(0, 0, width, height);
                let mut buffer = Buffer::empty(area);
                paragraph.render(area, &mut buffer);
                let wrapped = (0..height)
                    .map(|y| {
                        let mut spans: Vec<Span<'static>> = Vec::new();
                        let mut x = 0;
                        while x < width {
                            let cell = &buffer[(x, y)];
                            if let Some(last) = spans.last_mut()
                                && last.style == cell.style()
                            {
                                last.content.to_mut().push_str(cell.symbol());
                            } else {
                                spans.push(Span::styled(cell.symbol().to_owned(), cell.style()));
                            }
                            x += cell.symbol().width().max(1) as u16;
                        }
                        while spans
                            .last()
                            .is_some_and(|span| span.content.trim_end().is_empty())
                        {
                            spans.pop();
                        }
                        if let Some(last) = spans.last_mut() {
                            let end = last.content.trim_end().len();
                            last.content.to_mut().truncate(end);
                        }
                        Line::from(spans).style(line.line.style)
                    })
                    .collect();
                rows.extend(remap_wrapped_line(&line, wrapped));
            }
        }
        Self {
            rows,
            anchor: (0, 0),
            focus: (0, 0),
            scroll,
            dragging: false,
        }
    }

    pub(super) fn len(&self) -> usize {
        self.rows.len()
    }

    pub(super) fn start(&mut self, area: Rect, x: u16, y: u16) {
        self.anchor = self.position(area, x, y);
        self.focus = self.anchor;
        self.dragging = true;
    }

    pub(super) fn update(&mut self, area: Rect, x: u16, y: u16) {
        self.focus = self.position(area, x, y);
    }

    fn position(&self, area: Rect, x: u16, y: u16) -> (usize, usize) {
        let visible_y = y.min(area.bottom().saturating_sub(1));
        let row = self
            .scroll
            .saturating_add(visible_y.saturating_sub(area.y) as usize)
            .min(self.rows.len().saturating_sub(1));
        let column = if y < area.y {
            0
        } else if y >= area.bottom() {
            area.width
        } else {
            x.saturating_sub(area.x).min(area.width)
        };
        (row, column as usize)
    }

    fn columns(&self, row: usize) -> Range<usize> {
        let (start, end) = if self.anchor <= self.focus {
            (self.anchor, self.focus)
        } else {
            (self.focus, self.anchor)
        };
        if row < start.0 || row > end.0 {
            return 0..0;
        }
        let left = if row == start.0 { start.1 } else { 0 };
        let right = if row == end.0 { end.1 } else { usize::MAX };
        left..right
    }

    fn fragments(&self, row: usize) -> Vec<(Range<usize>, Range<usize>)> {
        let columns = self.columns(row);
        if columns.is_empty() {
            return Vec::new();
        }
        let line = &self.rows[row];
        let source = line.selection_source();
        let text: String = line
            .line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        let mut column = 0;
        let mut fragments = Vec::new();
        for (byte, grapheme) in text.grapheme_indices(true) {
            let end_column = column + grapheme.width();
            if column < columns.end && end_column > columns.start {
                for span in &source.spans {
                    let start = byte.max(span.displayed_bytes.start);
                    let end = (byte + grapheme.len()).min(span.displayed_bytes.end);
                    if start < end {
                        fragments.push((
                            column..end_column,
                            span.source_bytes.start + start - span.displayed_bytes.start
                                ..span.source_bytes.start + end - span.displayed_bytes.start,
                        ));
                    }
                }
            }
            column = end_column;
        }
        fragments
    }

    pub(super) fn text(&self) -> String {
        let mut out = String::new();
        if self.rows.is_empty() {
            return out;
        }
        let mut previous: Option<(Arc<str>, usize)> = None;
        let mut blank_rows = 0;
        for row in self.anchor.0.min(self.focus.0)..=self.anchor.0.max(self.focus.0) {
            let source = self.rows[row].selection_source();
            let fragments = self.fragments(row);
            if fragments.is_empty() {
                if !out.is_empty() && !self.columns(row).is_empty() {
                    blank_rows += 1;
                }
                continue;
            }
            for (_, bytes) in fragments {
                if let Some((text, end)) = &previous {
                    if Arc::ptr_eq(text, &source.text) {
                        if *end <= bytes.start {
                            out.push_str(&source.text[*end..bytes.start]);
                        }
                    } else {
                        out.extend(std::iter::repeat_n('\n', blank_rows + 1));
                    }
                }
                out.push_str(&source.text[bytes.clone()]);
                previous = Some((Arc::clone(&source.text), bytes.end));
                blank_rows = 0;
            }
        }
        out
    }

    pub(super) fn render(&mut self, area: Rect, buf: &mut Buffer) {
        self.scroll = self
            .scroll
            .min(self.rows.len().saturating_sub(area.height as usize));
        for (offset, line) in self
            .rows
            .iter()
            .skip(self.scroll)
            .take(area.height as usize)
            .enumerate()
        {
            let y = area.y + offset as u16;
            let row_area = Rect::new(area.x, y, area.width, 1);
            buf.set_style(row_area, line.line.style);
            Paragraph::new(line.line.clone()).render(row_area, buf);
            mark_buffer_hyperlinks(buf, row_area, std::slice::from_ref(line), 0);
            for (columns, _) in self.fragments(self.scroll + offset) {
                for column in columns.start..columns.end.min(area.width as usize) {
                    buf[(area.x + column as u16, y)]
                        .set_style(ratatui::style::Style::new().add_modifier(Modifier::REVERSED));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_hyperlinks::prefix_hyperlink_lines;

    #[test]
    fn holding_selection_preserves_background_on_padding_and_empty_rows() {
        use ratatui::style::Color;
        use ratatui::style::Style;
        let style = Style::new().bg(Color::Blue);
        let lines = vec![
            Line::from("draft").style(style),
            Line::default().style(style),
        ];
        let area = Rect::new(0, 0, 12, 2);
        let mut expected = Buffer::empty(area);
        Paragraph::new(lines.clone())
            .style(style)
            .render(area, &mut expected);
        let mut selection = Selection::new(
            lines.into_iter().map(HyperlinkLine::new).collect(),
            area.width,
            0,
        );
        let mut actual = Buffer::empty(area);
        selection.render(area, &mut actual);
        assert_eq!(actual, expected);
    }

    #[test]
    fn copy_skips_prompt_and_soft_wraps_in_both_directions() {
        let lines = prefix_hyperlink_lines(
            vec![HyperlinkLine::from("alpha   beta 文 gamma")],
            "› ".into(),
            "  ".into(),
        );
        let mut selection = Selection::new(lines, 10, 0);
        let area = Rect::new(4, 5, 10, selection.len() as u16);
        selection.start(area, area.x, area.y);
        selection.update(area, area.right(), area.bottom() - 1);
        assert_eq!(selection.text(), "alpha   beta 文 gamma");
        std::mem::swap(&mut selection.anchor, &mut selection.focus);
        assert_eq!(selection.text(), "alpha   beta 文 gamma");
    }

    #[test]
    fn copy_preserves_real_newlines_and_does_not_copy_unselected_rows() {
        let mut selection =
            Selection::new(vec!["first".into(), "second".into(), "third".into()], 20, 0);
        let area = Rect::new(0, 0, 20, 3);
        selection.start(area, 2, 0);
        selection.update(area, 3, 1);
        assert_eq!(selection.text(), "rst\nsec");
        selection.start(area, 0, 0);
        assert_eq!(selection.text(), "");
    }

    #[test]
    fn dragging_into_footer_stops_at_last_visible_source_row() {
        let mut selection = Selection::new(
            vec!["first".into(), "second".into(), "hidden".into()],
            20,
            0,
        );
        let area = Rect::new(3, 5, 20, 2);
        selection.start(area, area.x, area.y);
        selection.update(area, 0, area.bottom() + 3);
        assert_eq!(selection.text(), "first\nsecond");
    }
}
