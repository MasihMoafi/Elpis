use clap::Parser;
use codex_agent_grep::cli::Cli;
use codex_agent_grep::dedup::VisitedTracker;
use codex_agent_grep::formatter::{FormatMode, format_search_results};
use codex_agent_grep::search::{AgentGrepEngine, AgentGrepQuery};
use std::fs;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let query = AgentGrepQuery {
        pattern: cli.pattern.clone(),
        is_regex: cli.regex,
        case_sensitive: !cli.ignore_case,
        path: Some(cli.path.clone()),
        includes: cli.include.clone(),
        excludes: cli.exclude.clone(),
        max_results: cli.limit,
        context_lines: cli.context,
        dedup_strategy: cli.parse_dedup_strategy(),
        language: None,
    };

    let mut tracker = VisitedTracker::new();
    let engine = AgentGrepEngine::new();

    let results = if cli.path.is_file() {
        let content = fs::read_to_string(&cli.path)?;
        engine.search_content(&cli.path, &content, &query, &mut tracker)
    } else {
        engine.search_dir(&cli.path, &query, &mut tracker)?
    };

    let mode = if cli.json {
        FormatMode::Json
    } else {
        FormatMode::Text
    };

    let formatted = format_search_results(&results, mode);
    println!("{formatted}");

    Ok(())
}
