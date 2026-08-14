use crate::displacement::FileDisplacement;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Deduplication strategy for agent search results.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DedupStrategy {
    /// No deduplication; returns all matches and full requested context lines.
    None,
    /// Intelligently collapse previously seen context lines and merge overlapping blocks.
    #[default]
    Adaptive,
    /// Suppress matches that fall on lines previously visited in the session.
    SuppressSeen,
    /// Aggregate matches at the AST symbol/block level.
    BlockLevel,
}

/// A line in the search result's surrounding context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextLine {
    /// 1-indexed line number.
    pub line_number: usize,
    /// The string content of the line.
    pub content: String,
    /// True if this line contains the search match itself.
    pub is_match: bool,
    /// True if this line was previously visited/shown in an earlier query.
    pub previously_seen: bool,
    /// True if this line is a collapsed/summarized indicator.
    pub is_collapsed: bool,
}

/// Telemetry and statistics regarding deduplication for this query.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DedupStats {
    pub total_raw_matches: usize,
    pub suppressed_matches_count: usize,
    pub collapsed_context_lines_count: usize,
    pub novel_matches_count: usize,
}

/// Tracks code regions and symbols visited across an agent's interactive session turns.
#[derive(Debug, Clone, Default)]
pub struct VisitedTracker {
    visited_lines: HashMap<PathBuf, HashSet<usize>>,
    visited_symbols: HashSet<(PathBuf, String)>,
    visited_queries: HashSet<String>,
}

impl VisitedTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records that a range of 1-indexed lines in `path` was inspected.
    pub fn record_visit(&mut self, path: &Path, lines: std::ops::Range<usize>) {
        let entry = self.visited_lines.entry(path.to_path_buf()).or_default();
        for line in lines {
            entry.insert(line);
        }
    }

    /// Records that a single 1-indexed line in `path` was inspected.
    pub fn record_line(&mut self, path: &Path, line: usize) {
        self.visited_lines
            .entry(path.to_path_buf())
            .or_default()
            .insert(line);
    }

    /// Records that an AST symbol (e.g. `UserManager::authenticate`) was visited.
    pub fn record_symbol(&mut self, path: &Path, symbol_path: &str) {
        self.visited_symbols
            .insert((path.to_path_buf(), symbol_path.to_string()));
    }

    /// Checks if a line was previously visited.
    pub fn is_line_visited(&self, path: &Path, line: usize) -> bool {
        self.visited_lines
            .get(path)
            .map(|set| set.contains(&line))
            .unwrap_or(false)
    }

    /// Checks if an AST symbol was previously visited.
    pub fn is_symbol_visited(&self, path: &Path, symbol_path: &str) -> bool {
        self.visited_symbols
            .contains(&(path.to_path_buf(), symbol_path.to_string()))
    }

    /// Checks if an entire range `[start_line, end_line]` was already visited.
    pub fn is_range_completely_visited(
        &self,
        path: &Path,
        start_line: usize,
        end_line: usize,
    ) -> bool {
        if let Some(set) = self.visited_lines.get(path) {
            (start_line..=end_line).all(|l| set.contains(&l))
        } else {
            false
        }
    }

    /// Records that a query string was executed.
    pub fn record_query(&mut self, query: &str) {
        self.visited_queries.insert(query.to_string());
    }

    /// Clears all session tracking.
    pub fn clear(&mut self) {
        self.visited_lines.clear();
        self.visited_symbols.clear();
        self.visited_queries.clear();
    }
}

/// Applies adaptive deduplication to raw search matches.
pub fn deduplicate_matches<M, F>(
    matches: Vec<M>,
    strategy: DedupStrategy,
    tracker: &mut VisitedTracker,
    get_info: F,
) -> (Vec<M>, DedupStats)
where
    F: Fn(&M) -> (PathBuf, FileDisplacement, Option<String>, Vec<ContextLine>),
    M: Clone,
{
    let total_raw = matches.len();
    if strategy == DedupStrategy::None {
        let stats = DedupStats {
            total_raw_matches: total_raw,
            suppressed_matches_count: 0,
            collapsed_context_lines_count: 0,
            novel_matches_count: total_raw,
        };
        return (matches, stats);
    }

    let mut filtered_matches = Vec::new();
    let mut suppressed_count = 0;
    let mut collapsed_lines_count = 0;

    for m in matches {
        let (path, disp, symbol_path, context_lines) = get_info(&m);

        // Under SuppressSeen: if the match line was already visited in session, skip it
        if strategy == DedupStrategy::SuppressSeen {
            if tracker.is_line_visited(&path, disp.start_line) {
                suppressed_count += 1;
                continue;
            }
        }

        // Count collapsed context lines
        let collapsed = context_lines.iter().filter(|c| c.previously_seen).count();
        collapsed_lines_count += collapsed;

        // Record lines in tracker for future turns
        for cl in &context_lines {
            tracker.record_line(&path, cl.line_number);
        }
        if let Some(sym) = symbol_path {
            tracker.record_symbol(&path, &sym);
        }

        filtered_matches.push(m);
    }

    let novel_count = filtered_matches.len();
    let stats = DedupStats {
        total_raw_matches: total_raw,
        suppressed_matches_count: suppressed_count,
        collapsed_context_lines_count: collapsed_lines_count,
        novel_matches_count: novel_count,
    };

    (filtered_matches, stats)
}
