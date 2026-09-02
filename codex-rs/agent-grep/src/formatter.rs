use crate::search::AgentGrepResults;
use serde::{Deserialize, Serialize};

/// Output formatting mode for agent-grep results.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormatMode {
    #[default]
    Text,
    Json,
}

/// Formats the search results according to the selected format mode.
pub fn format_search_results(results: &AgentGrepResults, mode: FormatMode) -> String {
    match mode {
        FormatMode::Json => {
            serde_json::to_string_pretty(results).unwrap_or_else(|_| "{}".to_string())
        }
        FormatMode::Text => {
            let mut out = String::new();
            if results.matches.is_empty() {
                return "No matches found.".to_string();
            }

            for m in &results.matches {
                let path_str = m.file_path.to_string_lossy();
                let disp = &m.displacement;

                // Scope breadcrumb info
                let scope_info = if let Some(scope) = &m.structural_context {
                    let kind_str = format!("{:?}", scope.kind).to_lowercase();
                    format!(
                        " [{} {} (lines {}-{})]",
                        kind_str, scope.name, scope.line_range.start, scope.line_range.end
                    )
                } else {
                    String::new()
                };

                out.push_str(&format!(
                    "{}:{}:{}{}\n",
                    path_str, disp.start_line, disp.start_col, scope_info
                ));

                // Print context lines
                for cl in &m.context_lines {
                    let marker = if cl.is_match { ">" } else { " " };
                    let seen_tag = if cl.previously_seen { "  [seen]" } else { "" };
                    out.push_str(&format!(
                        "{} {:4} | {}{}\n",
                        marker, cl.line_number, cl.content, seen_tag
                    ));
                }
                out.push('\n');
            }

            if results.dedup_stats.suppressed_matches_count > 0
                || results.dedup_stats.collapsed_context_lines_count > 0
            {
                out.push_str(&format!(
                    "Deduplication summary: {} novel match(es), {} suppressed match(es), {} collapsed line(s).\n",
                    results.dedup_stats.novel_matches_count,
                    results.dedup_stats.suppressed_matches_count,
                    results.dedup_stats.collapsed_context_lines_count
                ));
            }

            out
        }
    }
}
