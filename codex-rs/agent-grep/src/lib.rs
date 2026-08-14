pub mod ast;
pub mod cli;
pub mod dedup;
pub mod displacement;
pub mod formatter;
pub mod search;

pub use ast::{AstContextExtractor, Language, ScopeKind, SymbolScope};
pub use cli::Cli;
pub use dedup::{ContextLine, DedupStats, DedupStrategy, VisitedTracker, deduplicate_matches};
pub use displacement::{FileDisplacement, LineIndex};
pub use formatter::{FormatMode, format_search_results};
pub use search::{AgentGrepEngine, AgentGrepMatch, AgentGrepQuery, AgentGrepResults};
