// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use std::borrow::Cow;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::MAX_SEARCH_RESULTS;
use crate::backend::MemoriesBackendError;
use crate::backend::MemorySearchMatch;
use crate::backend::SearchMatchMode;
use crate::backend::SearchMemoriesRequest;
use crate::backend::SearchMemoriesResponse;

use super::LocalMemoriesBackend;
use super::path::display_relative_path;
use super::path::is_hidden_path;
use super::path::read_sorted_dir_paths;
use super::path::reject_symlink;

pub(super) async fn search(
    backend: &LocalMemoriesBackend,
    request: SearchMemoriesRequest,
) -> Result<SearchMemoriesResponse, MemoriesBackendError> {
    let queries = request
        .queries
        .iter()
        .map(|query| query.trim().to_string())
        .collect::<Vec<_>>();
    if queries.is_empty() || queries.iter().any(std::string::String::is_empty) {
        return Err(MemoriesBackendError::EmptyQuery);
    }
    if matches!(
        request.match_mode,
        SearchMatchMode::AllWithinLines { line_count: 0 }
    ) {
        return Err(MemoriesBackendError::InvalidMatchWindow);
    }

    let max_results = request.max_results.min(MAX_SEARCH_RESULTS);
    let start = backend.resolve_scoped_path(request.path.as_deref()).await?;
    let start_index = match request.cursor.as_deref() {
        Some(cursor) => cursor.parse::<usize>().map_err(|_| {
            MemoriesBackendError::invalid_cursor(cursor, "must be a non-negative integer")
        })?,
        None => 0,
    };
    let Some(metadata) = LocalMemoriesBackend::metadata_or_none(&start).await? else {
        return Err(MemoriesBackendError::NotFound {
            path: request.path.unwrap_or_default(),
        });
    };
    reject_symlink(&display_relative_path(&backend.root, &start), &metadata)?;

    let matcher = SearchMatcher::new(
        queries.clone(),
        request.match_mode.clone(),
        request.case_sensitive,
        request.normalized,
    )?;
    let mut matches = Vec::new();
    search_entries(
        &backend.root,
        &start,
        &metadata,
        &matcher,
        request.context_lines,
        &mut matches,
    )
    .await?;
    if start_index > matches.len() {
        return Err(MemoriesBackendError::invalid_cursor(
            start_index.to_string(),
            "exceeds result count",
        ));
    }
    let end_index = start_index.saturating_add(max_results).min(matches.len());
    rank_matches(&mut matches, today_days(), matcher.queries.len(), end_index);
    let next_cursor = (end_index < matches.len()).then(|| end_index.to_string());
    let truncated = next_cursor.is_some();
    Ok(SearchMemoriesResponse {
        queries,
        match_mode: request.match_mode,
        path: request.path,
        matches: matches
            .drain(start_index..end_index)
            .map(|candidate| candidate.value)
            .collect(),
        next_cursor,
        truncated,
    })
}

async fn search_entries(
    root: &Path,
    current: &Path,
    current_metadata: &std::fs::Metadata,
    matcher: &SearchMatcher,
    context_lines: usize,
    matches: &mut Vec<SearchCandidate>,
) -> Result<(), MemoriesBackendError> {
    if current_metadata.is_file() {
        search_file(root, current, matcher, context_lines, matches).await?;
        return Ok(());
    }
    if !current_metadata.is_dir() {
        return Ok(());
    }

    let mut pending = vec![current.to_path_buf()];
    while let Some(dir_path) = pending.pop() {
        for path in read_sorted_dir_paths(&dir_path).await? {
            if is_hidden_path(&path) {
                continue;
            }
            let Some(metadata) = LocalMemoriesBackend::metadata_or_none(&path).await? else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                search_file(root, &path, matcher, context_lines, matches).await?;
            }
        }
    }

    Ok(())
}

async fn search_file(
    root: &Path,
    path: &Path,
    matcher: &SearchMatcher,
    context_lines: usize,
    matches: &mut Vec<SearchCandidate>,
) -> Result<(), MemoriesBackendError> {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::InvalidData => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    let lines = content.lines().collect::<Vec<_>>();
    let line_matches = lines
        .iter()
        .map(|line| matcher.matched_query_flags(line))
        .collect::<Vec<_>>();
    match &matcher.match_mode {
        SearchMatchMode::Any => {
            for (idx, matched_query_flags) in line_matches.iter().enumerate() {
                if matched_query_flags.iter().any(|matched| *matched) {
                    matches.push(build_search_match(
                        root,
                        path,
                        &lines,
                        idx,
                        idx,
                        context_lines,
                        matcher.matched_queries(matched_query_flags),
                        dated_memory_date(path, &lines, idx),
                    ));
                }
            }
        }
        SearchMatchMode::AllOnSameLine => {
            for (idx, matched_query_flags) in line_matches.iter().enumerate() {
                if matched_query_flags.iter().all(|matched| *matched) {
                    matches.push(build_search_match(
                        root,
                        path,
                        &lines,
                        idx,
                        idx,
                        context_lines,
                        matcher.matched_queries(matched_query_flags),
                        dated_memory_date(path, &lines, idx),
                    ));
                }
            }
        }
        SearchMatchMode::AllWithinLines { line_count } => {
            let mut windows = Vec::new();
            for start_index in 0..lines.len() {
                if !line_matches[start_index].iter().any(|matched| *matched) {
                    continue;
                }
                let last_allowed_index = start_index
                    .saturating_add(line_count.saturating_sub(1))
                    .min(lines.len().saturating_sub(1));
                let mut matched_query_flags = vec![false; matcher.queries.len()];
                for (end_index, line_match_flags) in line_matches
                    .iter()
                    .enumerate()
                    .take(last_allowed_index + 1)
                    .skip(start_index)
                {
                    for (idx, matched) in line_match_flags.iter().enumerate() {
                        matched_query_flags[idx] |= matched;
                    }
                    if matched_query_flags.iter().all(|matched| *matched) {
                        windows.push((start_index, end_index, matched_query_flags));
                        break;
                    }
                }
            }
            for (idx, (start_index, end_index, matched_query_flags)) in windows.iter().enumerate() {
                let strictly_contains_another_window = windows.iter().enumerate().any(
                    |(other_idx, (other_start_index, other_end_index, _))| {
                        idx != other_idx
                            && start_index <= other_start_index
                            && end_index >= other_end_index
                            && (start_index != other_start_index || end_index != other_end_index)
                    },
                );
                if strictly_contains_another_window {
                    continue;
                }
                matches.push(build_search_match(
                    root,
                    path,
                    &lines,
                    *start_index,
                    *end_index,
                    context_lines,
                    matcher.matched_queries(matched_query_flags),
                    dated_memory_date(path, &lines, *start_index),
                ));
            }
        }
    }
    Ok(())
}

fn build_search_match(
    root: &Path,
    path: &Path,
    lines: &[&str],
    match_start_index: usize,
    match_end_index: usize,
    context_lines: usize,
    matched_queries: Vec<String>,
    date: Option<i64>,
) -> SearchCandidate {
    let content_start_index = match_start_index.saturating_sub(context_lines);
    let content_end_index = match_end_index
        .saturating_add(context_lines)
        .saturating_add(1)
        .min(lines.len());
    let value = MemorySearchMatch {
        path: display_relative_path(root, path),
        match_line_number: match_start_index + 1,
        content_start_line_number: content_start_index + 1,
        content: lines[content_start_index..content_end_index].join("\n"),
        matched_queries,
    };
    SearchCandidate {
        tokens: token_set(&value.content),
        coverage: value.matched_queries.len(),
        date,
        value,
    }
}

#[derive(Clone)]
struct SearchCandidate {
    value: MemorySearchMatch,
    tokens: std::collections::BTreeSet<String>,
    coverage: usize,
    date: Option<i64>,
}

fn rank_matches(
    matches: &mut [SearchCandidate],
    today: i64,
    query_count: usize,
    ranked_prefix_len: usize,
) {
    let ranked_prefix_len = ranked_prefix_len.min(matches.len());
    if ranked_prefix_len == 0 {
        return;
    }
    let original = matches.to_vec();
    let mut relevance = Vec::with_capacity(original.len());
    for candidate in &original {
        let decay = candidate
            .date
            .map(|date| decay_for_age_days(today.saturating_sub(date)))
            .unwrap_or(1.0);
        relevance.push(candidate.coverage as f64 / query_count.max(1) as f64 * decay);
    }
    let mut remaining = (0..original.len()).collect::<Vec<_>>();
    let mut selected = Vec::with_capacity(ranked_prefix_len);
    while selected.len() < ranked_prefix_len {
        let selected_index = remaining
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| {
                mmr_score(**left, &original, &relevance, &selected)
                    .total_cmp(&mmr_score(**right, &original, &relevance, &selected))
                    .then_with(|| tie_key(&original[**right]).cmp(&tie_key(&original[**left])))
            })
            .map(|(index, _)| index)
            .unwrap();
        selected.push(remaining.remove(selected_index));
    }
    for (candidate, selected_index) in matches.iter_mut().zip(selected) {
        *candidate = original[selected_index].clone();
    }
}

fn mmr_score(
    index: usize,
    candidates: &[SearchCandidate],
    relevance: &[f64],
    selected: &[usize],
) -> f64 {
    let similarity = selected
        .iter()
        .map(|other| token_similarity(&candidates[index].tokens, &candidates[*other].tokens))
        .fold(0.0, f64::max);
    0.7 * relevance[index] - 0.3 * similarity
}

fn tie_key(candidate: &SearchCandidate) -> (&str, usize) {
    (&candidate.value.path, candidate.value.match_line_number)
}

fn token_set(value: &str) -> std::collections::BTreeSet<String> {
    value
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_lowercase())
        .collect()
}

fn token_similarity(
    left: &std::collections::BTreeSet<String>,
    right: &std::collections::BTreeSet<String>,
) -> f64 {
    let union = left.union(right).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        left.intersection(right).count() as f64 / union
    }
}

fn decay_for_age_days(age_days: i64) -> f64 {
    0.5_f64.powf(age_days.max(0) as f64 / 14.0)
}

fn today_days() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| (duration.as_secs() / 86_400) as i64)
        .unwrap_or(0)
}

fn dated_memory_date(path: &Path, lines: &[&str], match_index: usize) -> Option<i64> {
    let path_date = path
        .to_string_lossy()
        .split(|ch: char| !ch.is_ascii_digit() && ch != '-')
        .find_map(parse_date);
    path_date.or_else(|| {
        let preceding_lines = &lines[..match_index.min(lines.len())];
        let section_start = preceding_lines
            .iter()
            .rposition(|line| {
                let line = line.trim_start();
                if path.file_name().and_then(|name| name.to_str()) == Some("raw_memories.md") {
                    line.starts_with("## Thread")
                } else {
                    line.starts_with('#')
                }
            })
            .map_or(0, |index| index + 1);
        lines[section_start..match_index.min(lines.len())]
            .iter()
            .rev()
            .find_map(|line| parse_metadata_date(line))
    })
}

fn parse_metadata_date(line: &str) -> Option<i64> {
    let (key, value) = line.split_once(':')?;
    let key = key.trim().to_ascii_lowercase();
    matches!(
        key.as_str(),
        "date" | "created" | "created_at" | "updated" | "updated_at"
    )
    .then(|| value.trim())
    .and_then(parse_date)
}

fn parse_date(value: &str) -> Option<i64> {
    let date = value.get(..10)?;
    if date.as_bytes().get(4) != Some(&b'-') || date.as_bytes().get(7) != Some(&b'-') {
        return None;
    }
    let year = date.get(..4)?.parse::<i32>().ok()?;
    let month = date.get(5..7)?.parse::<u32>().ok()?;
    let day = date.get(8..10)?.parse::<u32>().ok()?;
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year - (month <= 2) as i32;
    let era = (year as i64).div_euclid(400);
    let year_of_era = year as i64 - era * 400;
    let month = month as i64;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}

struct SearchMatcher {
    queries: Vec<String>,
    prepared_queries: Vec<String>,
    comparison: SearchComparison,
    match_mode: SearchMatchMode,
}

impl SearchMatcher {
    fn new(
        queries: Vec<String>,
        match_mode: SearchMatchMode,
        case_sensitive: bool,
        normalized: bool,
    ) -> Result<Self, MemoriesBackendError> {
        let comparison = SearchComparison::new(case_sensitive, normalized);
        let prepared_queries = queries
            .iter()
            .map(|query| comparison.prepare(query))
            .map(Cow::into_owned)
            .collect::<Vec<_>>();
        if prepared_queries.iter().any(std::string::String::is_empty) {
            return Err(MemoriesBackendError::EmptyQuery);
        }
        Ok(Self {
            queries,
            prepared_queries,
            comparison,
            match_mode,
        })
    }

    fn matched_query_flags(&self, line: &str) -> Vec<bool> {
        let line = self.comparison.prepare(line);
        self.prepared_queries
            .iter()
            .map(|query| line.as_ref().contains(query))
            .collect()
    }

    fn matched_queries(&self, matched_query_flags: &[bool]) -> Vec<String> {
        self.queries
            .iter()
            .zip(matched_query_flags)
            .filter_map(|(query, matched)| matched.then_some(query.clone()))
            .collect()
    }
}

#[derive(Clone, Copy)]
struct SearchComparison {
    case_sensitive: bool,
    normalized: bool,
}

impl SearchComparison {
    fn new(case_sensitive: bool, normalized: bool) -> Self {
        Self {
            case_sensitive,
            normalized,
        }
    }

    fn prepare<'a>(self, value: &'a str) -> Cow<'a, str> {
        if self.case_sensitive && !self.normalized {
            return Cow::Borrowed(value);
        }

        let value = if self.case_sensitive {
            Cow::Borrowed(value)
        } else {
            Cow::Owned(value.to_lowercase())
        };
        if !self.normalized {
            return value;
        }

        Cow::Owned(
            value
                .chars()
                .filter(|ch| ch.is_alphanumeric())
                .collect::<String>(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(
        path: &str,
        line: usize,
        content: &str,
        coverage: usize,
        date: Option<i64>,
    ) -> SearchCandidate {
        SearchCandidate {
            value: MemorySearchMatch {
                path: path.to_string(),
                match_line_number: line,
                content_start_line_number: line,
                content: content.to_string(),
                matched_queries: Vec::new(),
            },
            tokens: token_set(content),
            coverage,
            date,
        }
    }

    #[test]
    fn relevance_prefers_query_coverage() {
        let mut matches = vec![
            candidate("b.md", 1, "alpha", 1, None),
            candidate("a.md", 1, "alpha beta", 2, None),
        ];
        let len = matches.len();
        rank_matches(&mut matches, 10, 2, len);
        assert_eq!(matches[0].value.path, "a.md");
    }

    #[test]
    fn decay_has_a_fourteen_day_half_life() {
        assert!((decay_for_age_days(0) - 1.0).abs() < f64::EPSILON);
        assert!((decay_for_age_days(14) - 0.5).abs() < f64::EPSILON);
        assert_eq!(
            dated_memory_date(Path::new("2026-07-02-note.md"), &[], 0),
            Some(days_from_civil(2026, 7, 2))
        );
        assert_eq!(
            dated_memory_date(Path::new("MEMORY.md"), &["date: 2026-07-02"], 1),
            Some(days_from_civil(2026, 7, 2))
        );
        assert_eq!(
            dated_memory_date(Path::new("MEMORY.md"), &["alpha"], 1),
            None
        );
    }

    #[test]
    fn section_metadata_does_not_leak_to_later_matches() {
        let lines = ["# First", "date: 2026-07-02", "alpha", "# Second", "needle"];
        assert_eq!(
            dated_memory_date(Path::new("MEMORY.md"), &lines, 2),
            Some(days_from_civil(2026, 7, 2))
        );
        assert_eq!(dated_memory_date(Path::new("MEMORY.md"), &lines, 4), None);

        let raw_lines = [
            "## Thread `one`",
            "updated_at: 2026-07-02T00:00:00Z",
            "# Nested summary heading",
            "needle",
            "## Thread `two`",
            "other",
        ];
        assert_eq!(
            dated_memory_date(Path::new("raw_memories.md"), &raw_lines, 3),
            Some(days_from_civil(2026, 7, 2))
        );
        assert_eq!(
            dated_memory_date(Path::new("raw_memories.md"), &raw_lines, 5),
            None
        );
    }

    #[test]
    fn diversity_penalizes_redundant_token_sets() {
        let mut matches = vec![
            candidate("a.md", 1, "alpha shared", 1, None),
            candidate("b.md", 1, "alpha shared", 1, None),
            candidate("c.md", 1, "beta distinct", 1, None),
        ];
        let len = matches.len();
        rank_matches(&mut matches, 10, 1, len);
        assert_eq!(matches[0].value.path, "a.md");
        assert_eq!(matches[1].value.path, "c.md");
    }

    #[test]
    fn equal_scores_break_ties_by_path_then_line() {
        let mut matches = vec![
            candidate("b.md", 2, "same", 1, None),
            candidate("a.md", 3, "same", 1, None),
            candidate("a.md", 1, "other", 1, None),
        ];
        let len = matches.len();
        rank_matches(&mut matches, 10, 1, len);
        assert_eq!(
            (
                matches[0].value.path.as_str(),
                matches[0].value.match_line_number
            ),
            ("a.md", 1)
        );
        assert_eq!(
            (
                matches[1].value.path.as_str(),
                matches[1].value.match_line_number
            ),
            ("a.md", 3)
        );
    }
}
