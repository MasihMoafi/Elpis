use serde::{Deserialize, Serialize};

/// Precise coordinates and byte offsets of a code span or match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileDisplacement {
    /// 1-indexed start line.
    pub start_line: usize,
    /// 1-indexed end line.
    pub end_line: usize,
    /// 1-indexed start column (in UTF-8 characters).
    pub start_col: usize,
    /// 1-indexed end column (in UTF-8 characters).
    pub end_col: usize,
    /// 0-indexed byte offset in the source file.
    pub byte_offset: usize,
    /// Length of the matched span in bytes.
    pub byte_len: usize,
}

/// Fast line/column index builder for a file source.
#[derive(Debug, Clone)]
pub struct LineIndex {
    line_starts: Vec<usize>,
    source_len: usize,
}

impl LineIndex {
    /// Builds a line index from the given source string.
    pub fn new(source: &str) -> Self {
        let mut line_starts = vec![0];
        for (i, b) in source.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i + 1);
            }
        }
        Self {
            line_starts,
            source_len: source.len(),
        }
    }

    /// Returns total line count (at least 1).
    pub fn total_lines(&self) -> usize {
        self.line_starts.len()
    }

    /// Converts a byte offset to a 1-indexed line and 1-indexed column.
    pub fn line_col(&self, source: &str, byte_offset: usize) -> (usize, usize) {
        let clamped_offset = byte_offset.min(self.source_len);
        let line_idx = match self.line_starts.binary_search(&clamped_offset) {
            Ok(idx) => idx,
            Err(idx) => idx.saturating_sub(1),
        };

        let line_start = self.line_starts[line_idx];
        let line_str = if clamped_offset > line_start && clamped_offset <= source.len() {
            &source[line_start..clamped_offset]
        } else {
            ""
        };
        let col = line_str.chars().count() + 1;
        (line_idx + 1, col)
    }

    /// Generates a `FileDisplacement` for the given byte range.
    pub fn displacement_for_span_with_source(
        &self,
        source: &str,
        byte_offset: usize,
        byte_len: usize,
    ) -> FileDisplacement {
        let (start_line, start_col) = self.line_col(source, byte_offset);
        let end_offset = byte_offset.saturating_add(byte_len);
        let (end_line, end_col) = self.line_col(source, end_offset);

        FileDisplacement {
            start_line,
            end_line,
            start_col,
            end_col,
            byte_offset,
            byte_len,
        }
    }

    /// Helper for string when source is indexed.
    pub fn displacement_for_span(&self, byte_offset: usize, byte_len: usize) -> FileDisplacement {
        let clamped_start = byte_offset.min(self.source_len);
        let line_idx = match self.line_starts.binary_search(&clamped_start) {
            Ok(idx) => idx,
            Err(idx) => idx.saturating_sub(1),
        };
        let line_start = self.line_starts[line_idx];
        let col = clamped_start.saturating_sub(line_start) + 1;

        let end_offset = clamped_start.saturating_add(byte_len).min(self.source_len);
        let end_line_idx = match self.line_starts.binary_search(&end_offset) {
            Ok(idx) => idx,
            Err(idx) => idx.saturating_sub(1),
        };
        let end_line_start = self.line_starts[end_line_idx];
        let end_col = end_offset.saturating_sub(end_line_start) + 1;

        FileDisplacement {
            start_line: line_idx + 1,
            end_line: end_line_idx + 1,
            start_col: col,
            end_col,
            byte_offset,
            byte_len,
        }
    }

    /// Returns the byte range for a 1-indexed line.
    pub fn line_byte_range(&self, line_1_indexed: usize) -> std::ops::Range<usize> {
        if line_1_indexed == 0 || line_1_indexed > self.line_starts.len() {
            return 0..0;
        }
        let start = self.line_starts[line_1_indexed - 1];
        let end = if line_1_indexed < self.line_starts.len() {
            self.line_starts[line_1_indexed]
        } else {
            self.source_len
        };
        start..end
    }
}
