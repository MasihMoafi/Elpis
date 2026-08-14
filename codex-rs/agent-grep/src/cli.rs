use crate::dedup::DedupStrategy;
use clap::Parser;
use std::path::PathBuf;

/// AST/structure-aware grep with adaptive deduplication for coding agents.
#[derive(Parser, Debug, Clone)]
#[command(name = "codex-agent-grep", version, about)]
pub struct Cli {
    /// Search pattern or regular expression.
    pub pattern: String,

    /// Target directory or file to search (defaults to current directory).
    #[clap(default_value = ".")]
    pub path: PathBuf,

    /// Treat search pattern as regular expression.
    #[clap(short = 'r', long, default_value = "false")]
    pub regex: bool,

    /// Perform case-insensitive search.
    #[clap(short = 'i', long, default_value = "false")]
    pub ignore_case: bool,

    /// Number of context lines around matches within enclosing AST boundaries.
    #[clap(short = 'C', long, default_value = "2")]
    pub context: usize,

    /// Maximum number of search results to return.
    #[clap(short = 'l', long, default_value = "50")]
    pub limit: usize,

    /// Deduplication strategy: adaptive, suppress_seen, block_level, none.
    #[clap(long, default_value = "adaptive")]
    pub strategy: String,

    /// File glob includes (e.g. `*.rs`).
    #[clap(short = 'g', long)]
    pub include: Vec<String>,

    /// File glob excludes.
    #[clap(short = 'e', long)]
    pub exclude: Vec<String>,

    /// Output results in JSON format for automated agent ingestion.
    #[clap(long, default_value = "false")]
    pub json: bool,
}

impl Cli {
    pub fn parse_dedup_strategy(&self) -> DedupStrategy {
        match self.strategy.to_lowercase().as_str() {
            "none" => DedupStrategy::None,
            "suppress_seen" | "suppress-seen" | "suppress" => DedupStrategy::SuppressSeen,
            "block_level" | "block-level" | "block" => DedupStrategy::BlockLevel,
            _ => DedupStrategy::Adaptive,
        }
    }
}
