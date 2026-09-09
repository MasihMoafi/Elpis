use codex_agent_grep::ast::Language;
use codex_agent_grep::dedup::{DedupStrategy, VisitedTracker};
use codex_agent_grep::search::{AgentGrepEngine, AgentGrepQuery};
use pretty_assertions::assert_eq;
use std::path::PathBuf;

#[test]
fn test_query_internal_overlapping_deduplication() {
    let source = r#"pub fn process_items(items: &[String]) -> Result<usize, String> {
    let mut count = 0;
    for item in items {
        if item.is_empty() {
            return Err("empty item found".to_string());
        }
        if item.starts_with("err_") {
            return Err("error prefix found".to_string());
        }
        count += 1;
    }
    Ok(count)
}
"#;

    let mut tracker = VisitedTracker::new();
    let query = AgentGrepQuery {
        pattern: "return Err".to_string(),
        is_regex: false,
        case_sensitive: true,
        path: None,
        includes: vec![],
        excludes: vec![],
        max_results: 10,
        context_lines: 2,
        dedup_strategy: DedupStrategy::Adaptive,
        language: Some(Language::Rust),
    };

    let engine = AgentGrepEngine::new();
    let results = engine.search_content(
        &PathBuf::from("src/processor.rs"),
        source,
        &query,
        &mut tracker,
    );

    // There are 2 matches for "return Err" inside process_items
    assert_eq!(results.matches.len(), 2);
    // Enclosing symbol for both is process_items
    assert_eq!(
        results.matches[0].structural_context.as_ref().unwrap().name,
        "process_items"
    );
    assert_eq!(
        results.matches[1].structural_context.as_ref().unwrap().name,
        "process_items"
    );

    // Visited tracker should now remember that process_items and its lines were visited
    assert!(tracker.is_line_visited(&PathBuf::from("src/processor.rs"), 5));
    assert!(tracker.is_line_visited(&PathBuf::from("src/processor.rs"), 8));
}

#[test]
fn test_cross_turn_session_adaptive_deduplication() {
    let source = r#"pub fn authenticate_user(token: &str) -> bool {
    // Line 2: Security check 1
    if token.is_empty() {
        return false;
    }
    // Line 6: Security check 2
    if token.len() < 8 {
        return false;
    }
    // Line 10: Security check 3
    if !token.starts_with("Bearer ") {
        return false;
    }
    true
}
"#;

    let path = PathBuf::from("src/auth.rs");
    let mut tracker = VisitedTracker::new();

    // Turn 1: Agent searches for "Security check 1"
    let query1 = AgentGrepQuery {
        pattern: "Security check 1".to_string(),
        is_regex: false,
        case_sensitive: true,
        path: None,
        includes: vec![],
        excludes: vec![],
        max_results: 10,
        context_lines: 2,
        dedup_strategy: DedupStrategy::Adaptive,
        language: Some(Language::Rust),
    };

    let engine = AgentGrepEngine::new();
    let results1 = engine.search_content(&path, source, &query1, &mut tracker);
    assert_eq!(results1.matches.len(), 1);
    assert_eq!(results1.matches[0].displacement.start_line, 2);

    // In Turn 1, lines 1..4 were shown to the agent and recorded in tracker
    // Now Turn 2: Agent searches for "Security check 2" (line 6) with context_lines: 3
    let query2 = AgentGrepQuery {
        pattern: "Security check 2".to_string(),
        is_regex: false,
        case_sensitive: true,
        path: None,
        includes: vec![],
        excludes: vec![],
        max_results: 10,
        context_lines: 3,
        dedup_strategy: DedupStrategy::Adaptive,
        language: Some(Language::Rust),
    };

    let results2 = engine.search_content(&path, source, &query2, &mut tracker);
    assert_eq!(results2.matches.len(), 1);
    let m = &results2.matches[0];
    assert_eq!(m.displacement.start_line, 6);

    // Under Adaptive dedup, context lines that were already visited (lines 3..4)
    // are collapsed or marked as previously visited rather than blindly duplicating them.
    let collapsed_lines: Vec<_> = m
        .context_lines
        .iter()
        .filter(|cl| cl.previously_seen)
        .collect();
    assert!(
        !collapsed_lines.is_empty(),
        "Previously seen lines should be tagged/collapsed"
    );
}

#[test]
fn test_suppress_seen_strategy_filters_previously_visited_matches() {
    let source = r#"def calculate_metrics(data):
    total = sum(data)
    mean = total / len(data)
    return total, mean
"#;

    let path = PathBuf::from("metrics.py");
    let mut tracker = VisitedTracker::new();

    let query_adaptive = AgentGrepQuery {
        pattern: "total".to_string(),
        is_regex: false,
        case_sensitive: true,
        path: None,
        includes: vec![],
        excludes: vec![],
        max_results: 10,
        context_lines: 1,
        dedup_strategy: DedupStrategy::Adaptive,
        language: Some(Language::Python),
    };

    let engine = AgentGrepEngine::new();
    let res1 = engine.search_content(&path, source, &query_adaptive, &mut tracker);
    assert_eq!(res1.matches.len(), 3); // lines 2, 3, 4

    // Now query with SuppressSeen strategy for the same pattern or lines
    let query_suppress = AgentGrepQuery {
        pattern: "total".to_string(),
        is_regex: false,
        case_sensitive: true,
        path: None,
        includes: vec![],
        excludes: vec![],
        max_results: 10,
        context_lines: 1,
        dedup_strategy: DedupStrategy::SuppressSeen,
        language: Some(Language::Python),
    };

    let res2 = engine.search_content(&path, source, &query_suppress, &mut tracker);
    // Since all matches in metrics.py were previously seen in this session, SuppressSeen filters them out
    assert_eq!(res2.matches.len(), 0);
    assert_eq!(res2.dedup_stats.suppressed_matches_count, 3);
}

#[test]
fn test_symbol_level_dedup_and_tracking() {
    let mut tracker = VisitedTracker::new();
    let path = PathBuf::from("src/lib.rs");

    assert!(!tracker.is_symbol_visited(&path, "Config::load"));
    tracker.record_symbol(&path, "Config::load");
    assert!(tracker.is_symbol_visited(&path, "Config::load"));
    assert!(!tracker.is_symbol_visited(&path, "Config::save"));
}
