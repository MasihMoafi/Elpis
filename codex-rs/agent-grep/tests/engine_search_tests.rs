use codex_agent_grep::dedup::{DedupStrategy, VisitedTracker};
use codex_agent_grep::formatter::{FormatMode, format_search_results};
use codex_agent_grep::search::{AgentGrepEngine, AgentGrepQuery};
use pretty_assertions::assert_eq;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_engine_directory_search_with_filtering() {
    let dir = tempdir().expect("create temp dir");
    let base_path = dir.path();

    // Create file 1: rust file
    let rs_content = r#"pub fn process_event(event: &str) {
    if event == "INIT_EVENT" {
        println!("Initializing...");
    }
}
"#;
    fs::write(base_path.join("event.rs"), rs_content).expect("write rs");

    // Create file 2: python file
    let py_content = r#"def handle_event(event):
    if event == "INIT_EVENT":
        print("Python initializing...")
"#;
    fs::write(base_path.join("event.py"), py_content).expect("write py");

    // Create file 3: ignored or non-matching file
    fs::write(base_path.join("notes.txt"), "no events here").expect("write txt");

    let engine = AgentGrepEngine::new();
    let mut tracker = VisitedTracker::new();

    let query = AgentGrepQuery {
        pattern: "INIT_EVENT".to_string(),
        is_regex: false,
        case_sensitive: true,
        path: Some(base_path.to_path_buf()),
        includes: vec!["*.rs".to_string(), "*.py".to_string()],
        excludes: vec![],
        max_results: 10,
        context_lines: 1,
        dedup_strategy: DedupStrategy::Adaptive,
        language: None,
    };

    let results = engine.search_dir(base_path, &query, &mut tracker).expect("search dir");
    assert_eq!(results.matches.len(), 2);

    let rs_match = results
        .matches
        .iter()
        .find(|m| m.file_path.ends_with("event.rs"))
        .expect("rs match");
    assert_eq!(rs_match.displacement.start_line, 2);
    assert_eq!(
        rs_match.structural_context.as_ref().unwrap().name,
        "process_event"
    );

    let py_match = results
        .matches
        .iter()
        .find(|m| m.file_path.ends_with("event.py"))
        .expect("py match");
    assert_eq!(py_match.displacement.start_line, 2);
    assert_eq!(
        py_match.structural_context.as_ref().unwrap().name,
        "handle_event"
    );

    // Test text formatter
    let formatted_text = format_search_results(&results, FormatMode::Text);
    assert!(formatted_text.contains("event.rs:2"));
    assert!(formatted_text.contains("process_event"));
    assert!(formatted_text.contains("event.py:2"));
    assert!(formatted_text.contains("handle_event"));

    // Test JSON formatter
    let formatted_json = format_search_results(&results, FormatMode::Json);
    let json_val: serde_json::Value = serde_json::from_str(&formatted_json).expect("valid json");
    assert_eq!(json_val["matches"].as_array().unwrap().len(), 2);
}

#[test]
fn test_engine_regex_search_with_case_insensitivity() {
    let source = r#"function connectDatabase() {
    const DB_PORT = 5432;
    const db_host = "localhost";
    return `${db_host}:${DB_PORT}`;
}
"#;

    let engine = AgentGrepEngine::new();
    let mut tracker = VisitedTracker::new();

    let query = AgentGrepQuery {
        pattern: r"db_\w+".to_string(),
        is_regex: true,
        case_sensitive: false,
        path: None,
        includes: vec![],
        excludes: vec![],
        max_results: 10,
        context_lines: 1,
        dedup_strategy: DedupStrategy::None,
        language: Some(codex_agent_grep::ast::Language::JavaScript),
    };

    let results = engine.search_content(
        &std::path::PathBuf::from("db.js"),
        source,
        &query,
        &mut tracker,
    );

    // Matches DB_PORT (line 2, line 4) and db_host (line 3, line 4)
    assert!(results.matches.len() >= 3);
    for m in &results.matches {
        assert_eq!(
            m.structural_context.as_ref().unwrap().name,
            "connectDatabase"
        );
    }
}
