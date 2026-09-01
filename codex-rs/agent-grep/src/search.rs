use crate::ast::{AstContextExtractor, Language, SymbolScope};
use crate::dedup::{ContextLine, DedupStats, DedupStrategy, VisitedTracker, deduplicate_matches};
use crate::displacement::{FileDisplacement, LineIndex};
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Search query configuration for agent-grep.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentGrepQuery {
    /// Search pattern or regex.
    pub pattern: String,
    /// Whether the pattern is a regular expression.
    pub is_regex: bool,
    /// Case-sensitive matching.
    pub case_sensitive: bool,
    /// Root path to search.
    pub path: Option<PathBuf>,
    /// File glob includes (e.g. `["*.rs", "*.py"]`).
    pub includes: Vec<String>,
    /// File glob excludes.
    pub excludes: Vec<String>,
    /// Maximum number of matches to return.
    pub max_results: usize,
    /// Surrounding context lines to extract within AST boundaries.
    pub context_lines: usize,
    /// Deduplication strategy.
    pub dedup_strategy: DedupStrategy,
    /// Specific language override.
    pub language: Option<Language>,
}

impl Default for AgentGrepQuery {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            is_regex: false,
            case_sensitive: true,
            path: None,
            includes: Vec::new(),
            excludes: Vec::new(),
            max_results: 50,
            context_lines: 2,
            dedup_strategy: DedupStrategy::Adaptive,
            language: None,
        }
    }
}

/// A single structure-aware search match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentGrepMatch {
    /// Path to the matched file.
    pub file_path: PathBuf,
    /// Exact line, column, and byte displacements.
    pub displacement: FileDisplacement,
    /// The exact text substring that matched.
    pub matched_text: String,
    /// The full line content containing the match.
    pub line_content: String,
    /// Enclosing AST scope (function/class signature, scope hierarchy, range).
    pub structural_context: Option<SymbolScope>,
    /// Surrounding context lines with deduplication tags.
    pub context_lines: Vec<ContextLine>,
}

/// Aggregated search results from agent-grep.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AgentGrepResults {
    pub matches: Vec<AgentGrepMatch>,
    pub total_match_count: usize,
    pub dedup_stats: DedupStats,
}

/// Core agent-grep execution engine.
#[derive(Debug, Clone, Default)]
pub struct AgentGrepEngine;

impl AgentGrepEngine {
    pub fn new() -> Self {
        Self
    }

    /// Searches in-memory content of a single file.
    pub fn search_content(
        &self,
        path: &Path,
        content: &str,
        query: &AgentGrepQuery,
        tracker: &mut VisitedTracker,
    ) -> AgentGrepResults {
        let regex = match self.compile_regex(query) {
            Ok(r) => r,
            Err(_) => return AgentGrepResults::default(),
        };

        let line_index = LineIndex::new(content);
        let lang = query.language.unwrap_or_else(|| Language::from_path(path));
        let extractor = AstContextExtractor::new(lang);
        let scopes = extractor.extract_scopes(content);
        let lines: Vec<&str> = content.lines().collect();

        let mut raw_matches = Vec::new();

        for mat in regex.find_iter(content) {
            if raw_matches.len() >= query.max_results {
                break;
            }

            let byte_offset = mat.start();
            let byte_len = mat.len();
            let matched_text = mat.as_str().to_string();

            let disp = line_index.displacement_for_span_with_source(content, byte_offset, byte_len);
            let line_idx = disp.start_line.saturating_sub(1);
            let line_content = lines.get(line_idx).copied().unwrap_or("").to_string();

            // Find enclosing AST scope
            let enclosing_scope = extractor
                .find_enclosing_scope(&scopes, byte_offset)
                .cloned();

            // Compute context lines bounded by AST scope or file limits
            let scope_start_line = enclosing_scope
                .as_ref()
                .map(|s| s.line_range.start)
                .unwrap_or(1);
            let scope_end_line = enclosing_scope
                .as_ref()
                .map(|s| s.line_range.end)
                .unwrap_or(lines.len());

            let ctx_start = disp
                .start_line
                .saturating_sub(query.context_lines)
                .max(scope_start_line)
                .max(1);
            let ctx_end = (disp.end_line + query.context_lines)
                .min(scope_end_line)
                .min(lines.len());

            let mut context_lines = Vec::new();
            for l_num in ctx_start..=ctx_end {
                let l_idx = l_num - 1;
                let c_text = lines.get(l_idx).copied().unwrap_or("").to_string();
                let is_m = l_num == disp.start_line;
                let seen = !is_m && tracker.is_line_visited(path, l_num);

                context_lines.push(ContextLine {
                    line_number: l_num,
                    content: c_text,
                    is_match: is_m,
                    previously_seen: seen,
                    is_collapsed: false,
                });
            }

            raw_matches.push(AgentGrepMatch {
                file_path: path.to_path_buf(),
                displacement: disp,
                matched_text,
                line_content,
                structural_context: enclosing_scope,
                context_lines,
            });
        }

        let (filtered, stats) = deduplicate_matches(
            raw_matches,
            query.dedup_strategy,
            tracker,
            |m: &AgentGrepMatch| {
                (
                    m.file_path.clone(),
                    m.displacement.clone(),
                    m.structural_context.as_ref().map(|s| s.path.join("::")),
                    m.context_lines.clone(),
                )
            },
        );

        let total_count = filtered.len();
        AgentGrepResults {
            matches: filtered,
            total_match_count: total_count,
            dedup_stats: stats,
        }
    }

    /// Searches directory tree recursively with gitignore respect and glob filters.
    pub fn search_dir(
        &self,
        dir: &Path,
        query: &AgentGrepQuery,
        tracker: &mut VisitedTracker,
    ) -> anyhow::Result<AgentGrepResults> {
        let mut builder = WalkBuilder::new(dir);
        builder.hidden(false);
        builder.git_ignore(true);

        let walker = builder.build();
        let mut all_matches = Vec::new();
        let mut total_suppressed = 0;
        let mut total_collapsed = 0;
        let mut total_raw = 0;

        for result in walker {
            let entry = match result {
                Ok(e) => e,
                Err(_) => continue,
            };

            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            // Apply includes filter if present
            if !query.includes.is_empty() {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let matched_include = query.includes.iter().any(|pattern| {
                    if let Ok(glob) = glob::Pattern::new(pattern) {
                        glob.matches(file_name) || glob.matches_path(path)
                    } else {
                        file_name.ends_with(pattern.trim_start_matches('*'))
                    }
                });
                if !matched_include {
                    continue;
                }
            }

            // Apply excludes filter if present
            if !query.excludes.is_empty() {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let matched_exclude = query.excludes.iter().any(|pattern| {
                    if let Ok(glob) = glob::Pattern::new(pattern) {
                        glob.matches(file_name) || glob.matches_path(path)
                    } else {
                        file_name.ends_with(pattern.trim_start_matches('*'))
                    }
                });
                if matched_exclude {
                    continue;
                }
            }

            // Read file content
            let content = match fs::read_to_string(path) {
                Ok(c) => c,
                Err(_) => continue, // Skip binary or unreadable files
            };

            let file_results = self.search_content(path, &content, query, tracker);
            total_raw += file_results.dedup_stats.total_raw_matches;
            total_suppressed += file_results.dedup_stats.suppressed_matches_count;
            total_collapsed += file_results.dedup_stats.collapsed_context_lines_count;

            for m in file_results.matches {
                all_matches.push(m);
                if all_matches.len() >= query.max_results {
                    break;
                }
            }

            if all_matches.len() >= query.max_results {
                break;
            }
        }

        let novel_count = all_matches.len();
        let total_count = all_matches.len();

        Ok(AgentGrepResults {
            matches: all_matches,
            total_match_count: total_count,
            dedup_stats: DedupStats {
                total_raw_matches: total_raw,
                suppressed_matches_count: total_suppressed,
                collapsed_context_lines_count: total_collapsed,
                novel_matches_count: novel_count,
            },
        })
    }

    fn compile_regex(&self, query: &AgentGrepQuery) -> Result<Regex, regex::Error> {
        let pattern = if query.is_regex {
            query.pattern.clone()
        } else {
            regex::escape(&query.pattern)
        };

        RegexBuilder::new(&pattern)
            .case_insensitive(!query.case_sensitive)
            .multi_line(true)
            .build()
    }
}
