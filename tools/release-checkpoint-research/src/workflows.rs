//! Read-only GitHub Actions workflow inventory and lossless extraction.
//!
//! This module intentionally uses a small, conservative YAML-shaped reader rather
//! than a YAML dependency.  It understands the common GitHub Actions forms needed
//! by the release audit, preserves the source text and one-based inclusive line
//! spans, and records a named gap instead of guessing when a form is outside that
//! small grammar.  It never invokes a workflow, a shell, Git, or a network service.

use crate::{Availability, ExactText, FoundationError, InclusiveSpan, RepoRelativePath};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const WORKFLOWS_DIRECTORY: &str = ".github/workflows";
pub const WORKFLOW_PARSE_GAP_UNREADABLE: &str = "workflow source unavailable";
pub const WORKFLOW_PARSE_GAP_SYMLINK: &str = "workflow symlink was not followed";
pub const NO_BUILD_COMMAND_REASON: &str = "no qualifying build command or action configured";

/// The parser state is deliberately closed: callers cannot confuse a source
/// gap with a successfully inspected empty workflow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum WorkflowParseStatus {
    Parsed,
    Partial,
    ParseGap,
    NotWorkflow,
    Unavailable,
}

/// Whether a retained file is a GitHub Actions workflow, an ordinary file, or a
/// source that could not be safely parsed/read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum WorkflowRecordKind {
    Workflow,
    NonWorkflow,
    ParseGap,
    Unavailable,
}

/// The only two classifications permitted in the workflow audit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum WorkflowClassification {
    BuildWorkflow,
    NonBuildWorkflow,
}

/// Conservative categories for a workflow without a qualifying build action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum NonBuildCategory {
    Security,
    Audit,
    Diagnostic,
    Other,
}

/// A qualifying operation retained independently from its source spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum BuildOperation {
    Setup,
    Compile,
    Test,
    Package,
    Publish,
    Upload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum BuildSource {
    Run,
    Uses,
}

/// Exact source value plus a normalized value and its source range.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct LocatedText {
    pub raw: ExactText,
    pub value: ExactText,
    pub span: InclusiveSpan,
}

impl LocatedText {
    fn new(raw: impl Into<String>, value: impl Into<String>, span: InclusiveSpan) -> Self {
        Self {
            raw: ExactText::new(raw),
            value: ExactText::new(value),
            span,
        }
    }

    pub fn text(&self) -> &str {
        self.value.as_str()
    }
}

/// One branch/tag/path value attached to an event in the aggregate trigger
/// inventory.  The event name is repeated so consumers need not reconstruct the
/// parent relation after flattening the inventory.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct TriggerValue {
    pub event: ExactText,
    pub raw: ExactText,
    pub value: ExactText,
    pub span: InclusiveSpan,
}

/// Trigger categories for explicit `NoneConfigured` records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum TriggerCategory {
    Events,
    Branches,
    BranchesIgnore,
    Tags,
    TagsIgnore,
    Paths,
    PathsIgnore,
    Schedules,
    ManualInputs,
    WorkflowCallInputs,
    JobConditions,
}

/// A category was inspected and had no configured value.  It is not represented
/// by an omitted field, which keeps an empty source distinct from an unavailable
/// source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoneConfigured {
    pub category: TriggerCategory,
    pub event: Availability<ExactText>,
    pub span: InclusiveSpan,
}

/// A parser or filesystem failure retained with the affected path and range.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct WorkflowParseGap {
    pub path: RepoRelativePath,
    pub reason: ExactText,
    pub span: InclusiveSpan,
}

impl WorkflowParseGap {
    fn new(path: RepoRelativePath, reason: impl Into<String>, span: InclusiveSpan) -> Self {
        Self {
            path,
            reason: ExactText::new(reason),
            span,
        }
    }
}

/// One event schedule declaration.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct WorkflowSchedule {
    pub event: ExactText,
    pub cron: LocatedText,
    pub span: InclusiveSpan,
}

/// A workflow_dispatch or workflow_call input, including values when available.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManualInput {
    pub event: ExactText,
    pub name: LocatedText,
    pub input_type: Availability<LocatedText>,
    pub default: Availability<LocatedText>,
    pub required: Availability<LocatedText>,
    pub description: Availability<LocatedText>,
    pub options: Availability<Vec<LocatedText>>,
    pub span: InclusiveSpan,
}

/// A direct job-level `if:` expression.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct JobCondition {
    pub job: ExactText,
    pub condition: LocatedText,
    pub span: InclusiveSpan,
}

/// Event-local values and absence records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowEvent {
    pub name: ExactText,
    pub raw_name: ExactText,
    pub raw_value: Availability<ExactText>,
    pub span: InclusiveSpan,
    pub branches: Availability<Vec<LocatedText>>,
    pub branches_ignore: Availability<Vec<LocatedText>>,
    pub tags: Availability<Vec<LocatedText>>,
    pub tags_ignore: Availability<Vec<LocatedText>>,
    pub paths: Availability<Vec<LocatedText>>,
    pub paths_ignore: Availability<Vec<LocatedText>>,
    pub schedules: Availability<Vec<WorkflowSchedule>>,
    pub manual_inputs: Availability<Vec<ManualInput>>,
    pub none_configured: Vec<NoneConfigured>,
}

/// All trigger data for a workflow.  The event-local records are authoritative;
/// flattened values are convenience views for CI/report consumers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowTriggerInventory {
    pub events: Availability<Vec<WorkflowEvent>>,
    pub branches: Availability<Vec<TriggerValue>>,
    pub branches_ignore: Availability<Vec<TriggerValue>>,
    pub tags: Availability<Vec<TriggerValue>>,
    pub tags_ignore: Availability<Vec<TriggerValue>>,
    pub paths: Availability<Vec<TriggerValue>>,
    pub paths_ignore: Availability<Vec<TriggerValue>>,
    pub schedules: Availability<Vec<WorkflowSchedule>>,
    pub manual_inputs: Availability<Vec<ManualInput>>,
    pub workflow_call_inputs: Availability<Vec<ManualInput>>,
    pub job_conditions: Availability<Vec<JobCondition>>,
    pub none_configured: Vec<NoneConfigured>,
}

impl WorkflowTriggerInventory {
    fn unavailable() -> Self {
        Self {
            events: Availability::Unavailable,
            branches: Availability::Unavailable,
            branches_ignore: Availability::Unavailable,
            tags: Availability::Unavailable,
            tags_ignore: Availability::Unavailable,
            paths: Availability::Unavailable,
            paths_ignore: Availability::Unavailable,
            schedules: Availability::Unavailable,
            manual_inputs: Availability::Unavailable,
            workflow_call_inputs: Availability::Unavailable,
            job_conditions: Availability::Unavailable,
            none_configured: Vec::new(),
        }
    }

    fn empty(span: InclusiveSpan) -> Self {
        Self {
            events: Availability::Empty,
            branches: Availability::Empty,
            branches_ignore: Availability::Empty,
            tags: Availability::Empty,
            tags_ignore: Availability::Empty,
            paths: Availability::Empty,
            paths_ignore: Availability::Empty,
            schedules: Availability::Empty,
            manual_inputs: Availability::Empty,
            workflow_call_inputs: Availability::Empty,
            job_conditions: Availability::Empty,
            none_configured: all_none_configured(span),
        }
    }

    pub fn event_records(&self) -> Availability<&[WorkflowEvent]> {
        match &self.events {
            Availability::Empty => Availability::Empty,
            Availability::Unavailable => Availability::Unavailable,
            Availability::Present(values) => Availability::Present(values.as_slice()),
        }
    }
}

/// One exact qualifying shell command or action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildCommand {
    pub source: BuildSource,
    pub operation: BuildOperation,
    pub text: ExactText,
    pub raw_text: ExactText,
    pub command: Availability<ExactText>,
    pub action: Availability<ExactText>,
    pub job: ExactText,
    pub step: ExactText,
    pub span: InclusiveSpan,
}

impl BuildCommand {
    fn run(
        operation: BuildOperation,
        raw: impl Into<String>,
        command: impl Into<String>,
        job: impl Into<String>,
        step: impl Into<String>,
        span: InclusiveSpan,
    ) -> Self {
        let raw = raw.into();
        let command = command.into();
        Self {
            source: BuildSource::Run,
            operation,
            text: ExactText::new(command.clone()),
            raw_text: ExactText::new(raw),
            command: Availability::Present(ExactText::new(command)),
            action: Availability::Empty,
            job: ExactText::new(job),
            step: ExactText::new(step),
            span,
        }
    }

    fn action(
        operation: BuildOperation,
        raw: impl Into<String>,
        action: impl Into<String>,
        job: impl Into<String>,
        step: impl Into<String>,
        span: InclusiveSpan,
    ) -> Self {
        let raw = raw.into();
        let action = action.into();
        Self {
            source: BuildSource::Uses,
            operation,
            text: ExactText::new(action.clone()),
            raw_text: ExactText::new(raw),
            command: Availability::Empty,
            action: Availability::Present(ExactText::new(action)),
            job: ExactText::new(job),
            step: ExactText::new(step),
            span,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct NoBuildCommand {
    pub reason: ExactText,
    pub span: InclusiveSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BuildExtraction {
    Commands(Vec<BuildCommand>),
    NoBuildCommand(NoBuildCommand),
    Unavailable(WorkflowParseGap),
}

impl BuildExtraction {
    pub fn commands(&self) -> Availability<&[BuildCommand]> {
        match self {
            Self::Commands(commands) if commands.is_empty() => Availability::Empty,
            Self::Commands(commands) => Availability::Present(commands.as_slice()),
            Self::NoBuildCommand(_) => Availability::Empty,
            Self::Unavailable(_) => Availability::Unavailable,
        }
    }

    pub fn has_qualifying_command(&self) -> bool {
        matches!(self, Self::Commands(commands) if !commands.is_empty())
    }
}

/// One retained path under `.github/workflows`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRecord {
    pub path: RepoRelativePath,
    pub source_span: InclusiveSpan,
    pub raw_source: Availability<ExactText>,
    /// Compatibility spelling for downstream report code.
    pub source_text: Availability<ExactText>,
    pub parse_status: WorkflowParseStatus,
    pub kind: WorkflowRecordKind,
    pub parse_gaps: Vec<WorkflowParseGap>,
    pub triggers: WorkflowTriggerInventory,
    pub job_conditions: Availability<Vec<JobCondition>>,
    pub build: BuildExtraction,
    pub build_commands: Availability<Vec<BuildCommand>>,
    pub classification: WorkflowClassification,
    pub categories: Vec<NonBuildCategory>,
}

impl WorkflowRecord {
    pub fn is_workflow(&self) -> bool {
        matches!(
            self.kind,
            WorkflowRecordKind::Workflow | WorkflowRecordKind::ParseGap
        )
    }

    pub fn is_build_workflow(&self) -> bool {
        self.classification == WorkflowClassification::BuildWorkflow
    }

    pub fn no_build_command(&self) -> Option<&NoBuildCommand> {
        match &self.build {
            BuildExtraction::NoBuildCommand(record) => Some(record),
            _ => None,
        }
    }
}

/// Description of an existing workflow directory.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct WorkflowDirectory {
    pub path: RepoRelativePath,
    pub file_count: usize,
}

/// Complete directory-level result.  Missing, empty, and unavailable are kept
/// distinct through `Availability` at both the directory and file-list level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowInventory {
    pub directory: Availability<WorkflowDirectory>,
    pub workflows: Availability<Vec<WorkflowRecord>>,
    pub gaps: Vec<WorkflowParseGap>,
}

impl WorkflowInventory {
    pub fn records(&self) -> Availability<&[WorkflowRecord]> {
        match &self.workflows {
            Availability::Empty => Availability::Empty,
            Availability::Unavailable => Availability::Unavailable,
            Availability::Present(records) => Availability::Present(records.as_slice()),
        }
    }

    pub fn paths(&self) -> Availability<Vec<RepoRelativePath>> {
        match &self.workflows {
            Availability::Empty => Availability::Empty,
            Availability::Unavailable => Availability::Unavailable,
            Availability::Present(records) => {
                Availability::Present(records.iter().map(|record| record.path.clone()).collect())
            }
        }
    }
}

/// Read-only collector rooted at one canonical absolute repository directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowCollector {
    root: PathBuf,
}

impl WorkflowCollector {
    pub fn new(repository_root: impl AsRef<Path>) -> Result<Self, FoundationError> {
        let root = crate::canonical_repository_root(repository_root.as_ref())?;
        Ok(Self { root })
    }

    pub fn repository_root(&self) -> &Path {
        &self.root
    }

    pub fn collect(&self) -> Result<WorkflowInventory, FoundationError> {
        collect_from_canonical_root(&self.root)
    }
}

/// Collect all entries below an absolute repository root without executing or
/// modifying anything.  The root itself follows the package’s existing safety
/// convention: it must be an absolute, non-symlink directory.
pub fn collect_workflow_inventory(
    repository_root: impl AsRef<Path>,
) -> Result<WorkflowInventory, FoundationError> {
    WorkflowCollector::new(repository_root)?.collect()
}

/// Compatibility spelling used by CI/report callers.
pub fn collect_workflows(
    repository_root: impl AsRef<Path>,
) -> Result<WorkflowInventory, FoundationError> {
    collect_workflow_inventory(repository_root)
}

/// Pure parser entry point.  It accepts a repository-relative path and exact
/// source text and performs no filesystem access.
pub fn parse_workflow<P, S>(path: P, source: S) -> Result<WorkflowRecord, FoundationError>
where
    P: AsRef<str>,
    S: AsRef<str>,
{
    let path = RepoRelativePath::new(path.as_ref().to_owned())?;
    Ok(parse_workflow_text(path, source.as_ref()))
}

/// Pure parser spelling that makes the source-text boundary explicit.
pub fn parse_workflow_source<P, S>(path: P, source: S) -> Result<WorkflowRecord, FoundationError>
where
    P: AsRef<str>,
    S: AsRef<str>,
{
    parse_workflow(path, source)
}

fn parse_workflow_text(path: RepoRelativePath, source: &str) -> WorkflowRecord {
    let line_count = source.split_terminator('\n').count().max(1);
    let full_span = span_for(1, line_count).unwrap_or(InclusiveSpan { start: 1, end: 1 });
    let parser = Parser::new(path.clone(), source);
    let parsed = parser.parse();
    let raw_source = Availability::Present(ExactText::new(source.to_owned()));
    let status = if parsed.gaps.is_empty() {
        parsed.status
    } else if parsed.status == WorkflowParseStatus::NotWorkflow {
        if is_yaml_path(path.as_str()) {
            WorkflowParseStatus::ParseGap
        } else {
            WorkflowParseStatus::NotWorkflow
        }
    } else {
        WorkflowParseStatus::ParseGap
    };
    let kind = match status {
        WorkflowParseStatus::NotWorkflow => WorkflowRecordKind::NonWorkflow,
        WorkflowParseStatus::Unavailable => WorkflowRecordKind::Unavailable,
        WorkflowParseStatus::Parsed | WorkflowParseStatus::Partial => {
            if parsed.workflow_marker {
                WorkflowRecordKind::Workflow
            } else {
                WorkflowRecordKind::NonWorkflow
            }
        }
        WorkflowParseStatus::ParseGap => {
            if parsed.workflow_marker {
                WorkflowRecordKind::ParseGap
            } else if is_yaml_path(path.as_str()) && !parsed.gaps.is_empty() {
                WorkflowRecordKind::ParseGap
            } else {
                WorkflowRecordKind::NonWorkflow
            }
        }
    };
    let mut triggers = parsed.triggers;
    if !parsed.workflow_marker && status == WorkflowParseStatus::NotWorkflow {
        triggers = WorkflowTriggerInventory::empty(full_span);
    }
    let commands = parsed.commands;
    let build = if commands.is_empty() {
        BuildExtraction::NoBuildCommand(NoBuildCommand {
            reason: ExactText::new(NO_BUILD_COMMAND_REASON),
            span: full_span,
        })
    } else {
        BuildExtraction::Commands(commands.clone())
    };
    let classification = if commands.is_empty() {
        WorkflowClassification::NonBuildWorkflow
    } else {
        WorkflowClassification::BuildWorkflow
    };
    let categories = if classification == WorkflowClassification::NonBuildWorkflow {
        classify_non_build_categories(path.as_str(), source)
    } else {
        Vec::new()
    };
    let job_conditions = triggers.job_conditions.clone();
    WorkflowRecord {
        path,
        source_span: full_span,
        raw_source: raw_source.clone(),
        source_text: raw_source,
        parse_status: status,
        kind,
        parse_gaps: parsed.gaps,
        triggers,
        job_conditions,
        build,
        build_commands: if commands.is_empty() {
            Availability::Empty
        } else {
            Availability::Present(commands)
        },
        classification,
        categories,
    }
}

fn unavailable_record(path: RepoRelativePath, reason: impl Into<String>) -> WorkflowRecord {
    let span = InclusiveSpan { start: 1, end: 1 };
    let gap = WorkflowParseGap::new(path.clone(), reason, span);
    WorkflowRecord {
        path,
        source_span: span,
        raw_source: Availability::Unavailable,
        source_text: Availability::Unavailable,
        parse_status: WorkflowParseStatus::Unavailable,
        kind: WorkflowRecordKind::Unavailable,
        parse_gaps: vec![gap.clone()],
        triggers: WorkflowTriggerInventory::unavailable(),
        job_conditions: Availability::Unavailable,
        build: BuildExtraction::Unavailable(gap),
        build_commands: Availability::Unavailable,
        classification: WorkflowClassification::NonBuildWorkflow,
        categories: vec![NonBuildCategory::Other],
    }
}

fn collect_from_canonical_root(root: &Path) -> Result<WorkflowInventory, FoundationError> {
    let github_path = root.join(".github");
    let relative_github = RepoRelativePath::new(".github".to_owned())?;
    let github_metadata = match fs::symlink_metadata(&github_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(WorkflowInventory {
                directory: Availability::Empty,
                workflows: Availability::Empty,
                gaps: Vec::new(),
            })
        }
        Err(error) => {
            let gap = WorkflowParseGap::new(
                relative_github,
                format!("cannot inspect .github: {error}"),
                InclusiveSpan { start: 1, end: 1 },
            );
            return Ok(WorkflowInventory {
                directory: Availability::Unavailable,
                workflows: Availability::Unavailable,
                gaps: vec![gap],
            });
        }
    };
    if github_metadata.file_type().is_symlink() || !github_metadata.is_dir() {
        let gap = WorkflowParseGap::new(
            relative_github,
            ".github is not a non-symlink directory",
            InclusiveSpan { start: 1, end: 1 },
        );
        return Ok(WorkflowInventory {
            directory: Availability::Unavailable,
            workflows: Availability::Unavailable,
            gaps: vec![gap],
        });
    }

    let directory_path = github_path.join("workflows");
    let relative_directory = RepoRelativePath::new(WORKFLOWS_DIRECTORY.to_owned())?;
    let metadata = match fs::symlink_metadata(&directory_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(WorkflowInventory {
                directory: Availability::Empty,
                workflows: Availability::Empty,
                gaps: Vec::new(),
            })
        }
        Err(error) => {
            let gap = WorkflowParseGap::new(
                relative_directory,
                format!("cannot inspect {WORKFLOWS_DIRECTORY}: {error}"),
                InclusiveSpan { start: 1, end: 1 },
            );
            return Ok(WorkflowInventory {
                directory: Availability::Unavailable,
                workflows: Availability::Unavailable,
                gaps: vec![gap],
            });
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        let gap = WorkflowParseGap::new(
            relative_directory,
            "workflow directory is not a non-symlink directory",
            InclusiveSpan { start: 1, end: 1 },
        );
        return Ok(WorkflowInventory {
            directory: Availability::Unavailable,
            workflows: Availability::Unavailable,
            gaps: vec![gap],
        });
    }

    let mut records = Vec::new();
    let mut gaps = Vec::new();
    walk_workflow_directory(
        &directory_path,
        WORKFLOWS_DIRECTORY,
        &mut records,
        &mut gaps,
    );
    records.sort_by(|left, right| left.path.cmp(&right.path));
    let directory = WorkflowDirectory {
        path: RepoRelativePath::new(WORKFLOWS_DIRECTORY.to_owned())?,
        file_count: records.len(),
    };
    let workflows = if records.is_empty() {
        Availability::Empty
    } else {
        Availability::Present(records)
    };
    Ok(WorkflowInventory {
        directory: Availability::Present(directory),
        workflows,
        gaps,
    })
}

fn walk_workflow_directory(
    directory: &Path,
    relative_directory: &str,
    records: &mut Vec<WorkflowRecord>,
    gaps: &mut Vec<WorkflowParseGap>,
) {
    let mut entries = match fs::read_dir(directory) {
        Ok(entries) => {
            let mut collected = Vec::new();
            for result in entries {
                match result {
                    Ok(entry) => collected.push(entry),
                    Err(error) => {
                        if let Ok(path) = RepoRelativePath::new(relative_directory.to_owned()) {
                            gaps.push(WorkflowParseGap::new(
                                path,
                                format!("cannot inspect workflow directory entry: {error}"),
                                InclusiveSpan { start: 1, end: 1 },
                            ));
                        }
                    }
                }
            }
            collected
        }
        Err(error) => {
            if let Ok(path) = RepoRelativePath::new(relative_directory.to_owned()) {
                gaps.push(WorkflowParseGap::new(
                    path,
                    format!("cannot enumerate workflow directory: {error}"),
                    InclusiveSpan { start: 1, end: 1 },
                ));
            }
            return;
        }
    };
    entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    for entry in entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            let fallback = format!("{relative_directory}/{}", name.to_string_lossy());
            if let Ok(path) = RepoRelativePath::new(fallback) {
                let record = unavailable_record(path.clone(), "workflow path is not valid UTF-8");
                gaps.extend(record.parse_gaps.clone());
                records.push(record);
            }
            continue;
        };
        let relative = format!("{relative_directory}/{name}");
        let Ok(repo_path) = RepoRelativePath::new(relative.clone()) else {
            continue;
        };
        let absolute = directory.join(&name);
        let metadata = match fs::symlink_metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(error) => {
                let record = unavailable_record(
                    repo_path,
                    format!("cannot inspect workflow entry: {error}"),
                );
                gaps.extend(record.parse_gaps.clone());
                records.push(record);
                continue;
            }
        };
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            walk_workflow_directory(&absolute, &relative, records, gaps);
            continue;
        }
        if metadata.file_type().is_symlink() {
            let record = unavailable_record(repo_path, WORKFLOW_PARSE_GAP_SYMLINK);
            gaps.extend(record.parse_gaps.clone());
            records.push(record);
            continue;
        }
        if !metadata.is_file() {
            let record = unavailable_record(
                repo_path,
                "workflow entry is non-regular and was not opened",
            );
            gaps.extend(record.parse_gaps.clone());
            records.push(record);
            continue;
        }
        match fs::read(&absolute) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(source) => match parse_workflow(&relative, source) {
                    Ok(record) => {
                        gaps.extend(record.parse_gaps.clone());
                        records.push(record);
                    }
                    Err(error) => {
                        let record = unavailable_record(
                            repo_path,
                            format!("cannot parse workflow path: {error}"),
                        );
                        gaps.extend(record.parse_gaps.clone());
                        records.push(record);
                    }
                },
                Err(_) => {
                    let record =
                        unavailable_record(repo_path, "workflow source is not valid UTF-8");
                    gaps.extend(record.parse_gaps.clone());
                    records.push(record);
                }
            },
            Err(error) => {
                let record =
                    unavailable_record(repo_path, format!("cannot read workflow source: {error}"));
                gaps.extend(record.parse_gaps.clone());
                records.push(record);
            }
        }
    }
}

fn all_none_configured(span: InclusiveSpan) -> Vec<NoneConfigured> {
    [
        TriggerCategory::Events,
        TriggerCategory::Branches,
        TriggerCategory::BranchesIgnore,
        TriggerCategory::Tags,
        TriggerCategory::TagsIgnore,
        TriggerCategory::Paths,
        TriggerCategory::PathsIgnore,
        TriggerCategory::Schedules,
        TriggerCategory::ManualInputs,
        TriggerCategory::WorkflowCallInputs,
        TriggerCategory::JobConditions,
    ]
    .into_iter()
    .map(|category| NoneConfigured {
        category,
        event: Availability::Empty,
        span,
    })
    .collect()
}

fn classify_non_build_categories(path: &str, source: &str) -> Vec<NonBuildCategory> {
    let lower = format!("{path}\n{source}").to_ascii_lowercase();
    let mut categories = Vec::new();
    if [
        "security",
        "codeql",
        "trivy",
        "sast",
        "secret",
        "dependency-review",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        categories.push(NonBuildCategory::Security);
    }
    if [
        "audit",
        "compliance",
        "license",
        "dependency-audit",
        "review",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        categories.push(NonBuildCategory::Audit);
    }
    if [
        "diagnostic",
        "debug",
        "trace",
        "lint",
        "format",
        "health",
        "diagnose",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        categories.push(NonBuildCategory::Diagnostic);
    }
    if categories.is_empty() {
        categories.push(NonBuildCategory::Other);
    }
    categories
}

fn is_yaml_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".yml") || lower.ends_with(".yaml")
}

struct ParsedSource {
    status: WorkflowParseStatus,
    workflow_marker: bool,
    triggers: WorkflowTriggerInventory,
    commands: Vec<BuildCommand>,
    gaps: Vec<WorkflowParseGap>,
}

struct Parser<'a> {
    path: RepoRelativePath,
    lines: Vec<SourceLine<'a>>,
    gaps: Vec<WorkflowParseGap>,
}

#[derive(Clone, Copy)]
struct SourceLine<'a> {
    number: usize,
    raw: &'a str,
    text: &'a str,
    indent: usize,
    content: &'a str,
}

impl<'a> Parser<'a> {
    fn new(path: RepoRelativePath, source: &'a str) -> Self {
        let raw_lines = if source.is_empty() {
            vec![""]
        } else {
            source.split_terminator('\n').collect::<Vec<_>>()
        };
        let lines = raw_lines
            .into_iter()
            .enumerate()
            .map(|(index, raw)| {
                let text = raw.strip_suffix('\r').unwrap_or(raw);
                let indent = text.bytes().take_while(|byte| *byte == b' ').count();
                let content = &text[indent..];
                SourceLine {
                    number: index + 1,
                    raw,
                    text,
                    indent,
                    content,
                }
            })
            .collect();
        Self {
            path,
            lines,
            gaps: Vec::new(),
        }
    }

    fn parse(mut self) -> ParsedSource {
        self.inspect_syntax();
        let top_keys = self.top_level_keys();
        let has_on = top_keys.iter().any(|(key, _)| key == "on");
        let has_jobs = top_keys.iter().any(|(key, _)| key == "jobs");
        let workflow_marker = has_on || has_jobs;
        if !workflow_marker {
            return ParsedSource {
                status: WorkflowParseStatus::NotWorkflow,
                workflow_marker: false,
                triggers: WorkflowTriggerInventory::empty(self.full_span()),
                commands: Vec::new(),
                gaps: self.gaps,
            };
        }
        let events = if let Some((_, index)) = top_keys.iter().find(|(key, _)| key == "on") {
            self.parse_events(*index)
        } else {
            Vec::new()
        };
        let job_conditions =
            if let Some((_, index)) = top_keys.iter().find(|(key, _)| key == "jobs") {
                self.parse_job_conditions(*index)
            } else {
                Availability::Empty
            };
        let commands = self.parse_build_commands(&top_keys);
        let triggers = self.build_triggers(events, job_conditions);
        ParsedSource {
            status: if self.gaps.is_empty() {
                WorkflowParseStatus::Parsed
            } else {
                WorkflowParseStatus::ParseGap
            },
            workflow_marker: true,
            triggers,
            commands,
            gaps: self.gaps,
        }
    }

    fn full_span(&self) -> InclusiveSpan {
        span_for(1, self.lines.len()).unwrap_or(InclusiveSpan { start: 1, end: 1 })
    }

    fn inspect_syntax(&mut self) {
        let mut quote: Option<u8> = None;
        for index in 0..self.lines.len() {
            let line = self.lines[index];
            let trimmed = line.content.trim();
            if trimmed.is_empty()
                || trimmed.starts_with('#')
                || trimmed == "---"
                || trimmed == "..."
            {
                continue;
            }
            if line.raw.starts_with('\t') || (line.content.contains('\t') && line.indent == 0) {
                self.add_gap(line.number, "tabs are not supported for YAML indentation");
            }
            if !balanced_value(trimmed) {
                self.add_gap(
                    line.number,
                    "unbalanced YAML quotes or collection delimiters",
                );
            }
            for byte in trimmed.bytes() {
                match (quote, byte) {
                    (None, b'\'' | b'\"') => quote = Some(byte),
                    (Some(current), byte) if byte == current => quote = None,
                    _ => {}
                }
            }
            if line.indent == 0
                && !trimmed.starts_with('-')
                && parse_mapping(trimmed).is_none()
                && !trimmed.starts_with('#')
            {
                self.add_gap(line.number, "top-level YAML entry is not a mapping");
            }
        }
        if quote.is_some() {
            let line = self.lines.last().map(|line| line.number).unwrap_or(1);
            self.add_gap(line, "unterminated YAML quote");
        }
    }

    fn top_level_keys(&mut self) -> Vec<(String, usize)> {
        let mut keys = Vec::new();
        let mut seen = BTreeSet::new();
        for index in 0..self.lines.len() {
            let line = self.lines[index];
            let trimmed = line.content.trim();
            if line.indent != 0 || trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some((raw_key, _)) = parse_mapping(trimmed) {
                let key = normalize_scalar(raw_key);
                if !seen.insert(key.clone()) {
                    self.add_gap(line.number, format!("duplicate top-level key `{key}`"));
                }
                keys.push((key, line.number - 1));
            }
        }
        keys
    }

    fn parse_events(&mut self, index: usize) -> Vec<WorkflowEvent> {
        let line = self.lines[index];
        let Some((_, raw_value)) = parse_mapping(line.content.trim()) else {
            self.add_gap(line.number, "the `on` entry is not a mapping");
            return Vec::new();
        };
        let raw_value = raw_value.trim();
        if !raw_value.is_empty() && !is_null(raw_value) {
            if inline_list(raw_value).is_some() {
                return inline_list(raw_value)
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|raw| {
                        self.event_from_inline(
                            raw,
                            line.number,
                            Availability::Present(ExactText::new(raw_value.to_owned())),
                        )
                    })
                    .collect();
            }
            if inline_map(raw_value).is_some() {
                return self.parse_inline_event_map(raw_value, line.number);
            }
            if is_event_name(raw_value) {
                return vec![self.event_from_name(
                    raw_value,
                    line.number,
                    Availability::Present(ExactText::new(raw_value.to_owned())),
                )];
            }
            self.add_gap(line.number, "unsupported scalar form for `on`");
            return Vec::new();
        }
        let end = self.top_level_end(index);
        let first = self.next_nonblank(index + 1, end);
        let Some(first) = first else {
            return Vec::new();
        };
        if self.lines[first].content.trim_start().starts_with('-') {
            self.parse_event_list(index, end, first)
        } else {
            self.parse_event_map(index, end, first)
        }
    }

    fn parse_event_list(
        &mut self,
        on_index: usize,
        end: usize,
        first: usize,
    ) -> Vec<WorkflowEvent> {
        let list_indent = self.lines[first].indent;
        let mut events = Vec::new();
        let mut i = first;
        while i < end {
            let line = self.lines[i];
            let trimmed = line.content.trim_start();
            if line.content.trim().is_empty() || trimmed.starts_with('#') {
                i += 1;
                continue;
            }
            if line.indent < list_indent {
                break;
            }
            if line.indent == list_indent && trimmed.starts_with('-') {
                let item = trimmed[1..].trim();
                if item.is_empty() {
                    self.add_gap(line.number, "empty event list item");
                    i += 1;
                    continue;
                }
                if let Some((raw_name, raw_config)) = parse_mapping(item) {
                    let name = normalize_scalar(raw_name);
                    let event_end = self.next_list_item_or_end(i + 1, end, list_indent);
                    let event = self.parse_event_block(
                        name,
                        raw_name.trim().to_owned(),
                        line.number,
                        i,
                        event_end,
                        raw_config.trim().to_owned(),
                        line.indent,
                    );
                    events.push(event);
                    i = event_end;
                } else {
                    let event = self.event_from_name(
                        item,
                        line.number,
                        Availability::Present(ExactText::new(item.to_owned())),
                    );
                    events.push(event);
                    i += 1;
                }
            } else {
                i += 1;
            }
        }
        if events.is_empty() {
            self.add_gap(
                self.lines[on_index].number,
                "event list under `on` contained no events",
            );
        }
        events
    }

    fn parse_event_map(&mut self, on_index: usize, end: usize, first: usize) -> Vec<WorkflowEvent> {
        let event_indent = self.lines[first].indent;
        let mut starts = Vec::new();
        let mut i = first;
        while i < end {
            let line = self.lines[i];
            let trimmed = line.content.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('#') && line.indent == event_indent {
                if let Some((raw_name, raw_value)) = parse_mapping(trimmed) {
                    starts.push((i, raw_name.trim().to_owned(), raw_value.trim().to_owned()));
                } else {
                    self.add_gap(line.number, "event map entry is not a mapping");
                }
            }
            i += 1;
        }
        if starts.is_empty() {
            self.add_gap(
                self.lines[on_index].number,
                "event map under `on` contained no events",
            );
            return Vec::new();
        }
        let mut events = Vec::new();
        for (position, (start, raw_name, raw_value)) in starts.iter().enumerate() {
            let next = starts
                .get(position + 1)
                .map(|(index, _, _)| *index)
                .unwrap_or(end);
            let name = normalize_scalar(raw_name);
            events.push(self.parse_event_block(
                name,
                raw_name.clone(),
                self.lines[*start].number,
                *start,
                next,
                raw_value.clone(),
                event_indent,
            ));
        }
        events
    }

    fn parse_inline_event_map(
        &mut self,
        raw_value: &str,
        line_number: usize,
    ) -> Vec<WorkflowEvent> {
        let items = inline_map(raw_value).unwrap_or_default();
        let mut events = Vec::new();
        for (raw_name, raw_config) in items {
            let name = normalize_scalar(&raw_name);
            events.push(self.parse_event_block(
                name,
                raw_name,
                line_number,
                line_number - 1,
                line_number,
                raw_config,
                0,
            ));
        }
        events
    }

    fn event_from_inline(
        &mut self,
        raw_name: String,
        line_number: usize,
        raw_value: Availability<ExactText>,
    ) -> Option<WorkflowEvent> {
        let name = normalize_scalar(&raw_name);
        if !is_event_name(&name) {
            self.add_gap(line_number, format!("unsupported event name `{name}`"));
            return None;
        }
        Some(self.event_from_name_with_raw(&name, raw_name, line_number, raw_value))
    }

    fn event_from_name(
        &mut self,
        raw_name: &str,
        line_number: usize,
        raw_value: Availability<ExactText>,
    ) -> WorkflowEvent {
        let name = normalize_scalar(raw_name);
        self.event_from_name_with_raw(&name, raw_name.trim().to_owned(), line_number, raw_value)
    }

    fn event_from_name_with_raw(
        &mut self,
        name: &str,
        raw_name: String,
        line_number: usize,
        raw_value: Availability<ExactText>,
    ) -> WorkflowEvent {
        let span = span_for(line_number, line_number).unwrap_or(InclusiveSpan { start: 1, end: 1 });
        let mut event = WorkflowEvent {
            name: ExactText::new(name.to_owned()),
            raw_name: ExactText::new(raw_name),
            raw_value,
            span,
            branches: Availability::Empty,
            branches_ignore: Availability::Empty,
            tags: Availability::Empty,
            tags_ignore: Availability::Empty,
            paths: Availability::Empty,
            paths_ignore: Availability::Empty,
            schedules: Availability::Empty,
            manual_inputs: Availability::Empty,
            none_configured: Vec::new(),
        };
        event.none_configured = event_none_configured(&event, span);
        event
    }

    fn parse_event_block(
        &mut self,
        name: String,
        raw_name: String,
        line_number: usize,
        start: usize,
        end: usize,
        inline_config: String,
        event_indent: usize,
    ) -> WorkflowEvent {
        let mut event = self.event_from_name_with_raw(
            &name,
            raw_name,
            line_number,
            if inline_config.is_empty() || is_null(&inline_config) {
                Availability::Empty
            } else {
                Availability::Present(ExactText::new(inline_config.clone()))
            },
        );
        if !inline_config.is_empty() && !is_null(&inline_config) {
            if inline_config.starts_with('{') {
                self.parse_inline_event_config(&mut event, &inline_config, line_number);
            } else if !inline_config.starts_with('#') {
                self.add_gap(
                    line_number,
                    format!("unsupported inline configuration for event `{name}`"),
                );
            }
        }
        let child = self.next_nonblank(start + 1, end);
        if let Some(child) = child {
            if name == "schedule" && self.lines[child].content.trim_start().starts_with('-') {
                event.schedules = self.parse_schedules(start, end, "", event_indent, &name);
            }
            if self.lines[child].indent <= event_indent {
                event.span = span_for(line_number, self.lines[child].number.saturating_sub(1))
                    .unwrap_or(event.span);
            } else {
                let child_indent = self.lines[child].indent;
                let mut i = child;
                while i < end {
                    let line = self.lines[i];
                    let trimmed = line.content.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        i += 1;
                        continue;
                    }
                    if line.indent == child_indent {
                        if let Some((raw_key, raw_value)) = parse_mapping(trimmed) {
                            let key = normalize_scalar(raw_key);
                            match key.as_str() {
                                "branches" => {
                                    event.branches = self.parse_values(
                                        i,
                                        end,
                                        raw_value.trim(),
                                        child_indent,
                                        "branches",
                                    )
                                }
                                "branches-ignore" => {
                                    event.branches_ignore = self.parse_values(
                                        i,
                                        end,
                                        raw_value.trim(),
                                        child_indent,
                                        "branches-ignore",
                                    )
                                }
                                "tags" => {
                                    event.tags = self.parse_values(
                                        i,
                                        end,
                                        raw_value.trim(),
                                        child_indent,
                                        "tags",
                                    )
                                }
                                "tags-ignore" => {
                                    event.tags_ignore = self.parse_values(
                                        i,
                                        end,
                                        raw_value.trim(),
                                        child_indent,
                                        "tags-ignore",
                                    )
                                }
                                "paths" => {
                                    event.paths = self.parse_values(
                                        i,
                                        end,
                                        raw_value.trim(),
                                        child_indent,
                                        "paths",
                                    )
                                }
                                "paths-ignore" => {
                                    event.paths_ignore = self.parse_values(
                                        i,
                                        end,
                                        raw_value.trim(),
                                        child_indent,
                                        "paths-ignore",
                                    )
                                }
                                "schedule" => {
                                    event.schedules = self.parse_schedules(
                                        i,
                                        end,
                                        raw_value.trim(),
                                        child_indent,
                                        &name,
                                    )
                                }
                                "inputs" => {
                                    event.manual_inputs = self.parse_inputs(
                                        i,
                                        end,
                                        raw_value.trim(),
                                        child_indent,
                                        &name,
                                    )
                                }
                                _ => {}
                            }
                        } else {
                            self.add_gap(
                                line.number,
                                format!("event `{name}` contains an unsupported mapping entry"),
                            );
                        }
                    }
                    i += 1;
                }
            }
        }
        event.span = span_for(
            line_number,
            end_line_number(&self.lines, start, end, line_number),
        )
        .unwrap_or(event.span);
        event.none_configured = event_none_configured(&event, event.span);
        event
    }

    fn parse_inline_event_config(&mut self, event: &mut WorkflowEvent, raw: &str, line: usize) {
        if event.name.as_str() == "schedule" {
            if let Some((raw_cron, value)) = extract_inline_cron(raw) {
                let span = span_for(line, line).unwrap_or(InclusiveSpan { start: 1, end: 1 });
                event.schedules = Availability::Present(vec![WorkflowSchedule {
                    event: event.name.clone(),
                    cron: LocatedText::new(raw_cron, normalize_scalar(&value), span),
                    span,
                }]);
                return;
            }
        }
        for (key, value) in inline_map(raw).unwrap_or_default() {
            let key = normalize_scalar(&key);
            let value = value.trim().to_owned();
            match key.as_str() {
                "branches" => event.branches = self.inline_values(&value, line),
                "branches-ignore" => event.branches_ignore = self.inline_values(&value, line),
                "tags" => event.tags = self.inline_values(&value, line),
                "tags-ignore" => event.tags_ignore = self.inline_values(&value, line),
                "paths" => event.paths = self.inline_values(&value, line),
                "paths-ignore" => event.paths_ignore = self.inline_values(&value, line),
                "inputs" => {
                    let event_name = event.name.as_str().to_owned();
                    event.manual_inputs = self.parse_inline_inputs(&value, line, &event_name);
                }
                _ => self.add_gap(line, format!("unsupported inline event filter `{key}`")),
            }
        }
    }

    fn parse_inline_inputs(
        &mut self,
        raw: &str,
        line: usize,
        event: &str,
    ) -> Availability<Vec<ManualInput>> {
        let Some(entries) = inline_map(raw) else {
            self.add_gap(line, "inline workflow inputs are not a map");
            return Availability::Unavailable;
        };
        if entries.is_empty() {
            return Availability::Empty;
        }
        let span = span_for(line, line).unwrap_or(InclusiveSpan { start: 1, end: 1 });
        let mut inputs = Vec::new();
        for (raw_name, raw_config) in entries {
            let name = LocatedText::new(raw_name.clone(), normalize_scalar(&raw_name), span);
            let mut input = ManualInput {
                event: ExactText::new(event),
                name,
                input_type: Availability::Empty,
                default: Availability::Empty,
                required: Availability::Empty,
                description: Availability::Empty,
                options: Availability::Empty,
                span,
            };
            if !raw_config.trim().is_empty() && !is_null(&raw_config) {
                let Some(properties) = inline_map(&raw_config) else {
                    self.add_gap(line, "inline manual input configuration is not a map");
                    continue;
                };
                for (raw_key, raw_value) in properties {
                    let property_span = span;
                    let located = LocatedText::new(
                        raw_value.trim().to_owned(),
                        normalize_scalar(&raw_value),
                        property_span,
                    );
                    match normalize_scalar(&raw_key).as_str() {
                        "type" => input.input_type = Availability::Present(located),
                        "default" => input.default = Availability::Present(located),
                        "required" => input.required = Availability::Present(located),
                        "description" => input.description = Availability::Present(located),
                        "options" => {
                            input.options = self.inline_values(&raw_value, line);
                        }
                        _ => {}
                    }
                }
            }
            inputs.push(input);
        }
        if inputs.is_empty() {
            Availability::Empty
        } else {
            Availability::Present(inputs)
        }
    }

    fn inline_values(&self, value: &str, line: usize) -> Availability<Vec<LocatedText>> {
        if is_null(value) {
            return Availability::Empty;
        }
        if let Some(items) = inline_list(value) {
            if items.is_empty() {
                return Availability::Empty;
            }
            return Availability::Present(
                items
                    .into_iter()
                    .map(|raw| {
                        LocatedText::new(
                            raw.clone(),
                            normalize_scalar(&raw),
                            span_for(line, line).unwrap_or(InclusiveSpan { start: 1, end: 1 }),
                        )
                    })
                    .collect(),
            );
        }
        Availability::Present(vec![LocatedText::new(
            value.to_owned(),
            normalize_scalar(value),
            span_for(line, line).unwrap_or(InclusiveSpan { start: 1, end: 1 }),
        )])
    }
    fn parse_values(
        &mut self,
        index: usize,
        end: usize,
        raw_value: &str,
        key_indent: usize,
        key: &str,
    ) -> Availability<Vec<LocatedText>> {
        if !raw_value.is_empty() && is_null(raw_value) {
            return Availability::Empty;
        }
        if let Some(items) = inline_list(raw_value) {
            if items.is_empty() {
                return Availability::Empty;
            }
            let span = span_for(self.lines[index].number, self.lines[index].number)
                .unwrap_or(InclusiveSpan { start: 1, end: 1 });
            return Availability::Present(
                items
                    .into_iter()
                    .map(|raw| LocatedText::new(raw.clone(), normalize_scalar(&raw), span))
                    .collect(),
            );
        }
        if !raw_value.is_empty() {
            if raw_value.starts_with('{') {
                self.add_gap(
                    self.lines[index].number,
                    format!("filter `{key}` uses unsupported map syntax"),
                );
                return Availability::Unavailable;
            }
            let span = span_for(self.lines[index].number, self.lines[index].number)
                .unwrap_or(InclusiveSpan { start: 1, end: 1 });
            return Availability::Present(vec![LocatedText::new(
                raw_value.to_owned(),
                normalize_scalar(raw_value),
                span,
            )]);
        }
        let mut values = Vec::new();
        let first = self.next_nonblank(index + 1, end);
        let Some(first) = first else {
            return Availability::Empty;
        };
        if self.lines[first].indent <= key_indent {
            return Availability::Empty;
        }
        let list_indent = self.lines[first].indent;
        let mut i = first;
        while i < end {
            let line = self.lines[i];
            let trimmed = line.content.trim_start();
            if line.content.trim().is_empty() || trimmed.starts_with('#') {
                i += 1;
                continue;
            }
            if line.indent <= key_indent {
                break;
            }
            if line.indent == list_indent && trimmed.starts_with('-') {
                let raw = trimmed[1..].trim();
                if raw.is_empty() {
                    self.add_gap(
                        line.number,
                        format!("filter `{key}` has an empty list item"),
                    );
                } else if parse_mapping(raw).is_some() {
                    self.add_gap(
                        line.number,
                        format!("filter `{key}` list item is not scalar"),
                    );
                } else {
                    let span = span_for(line.number, line.number)
                        .unwrap_or(InclusiveSpan { start: 1, end: 1 });
                    values.push(LocatedText::new(
                        raw.to_owned(),
                        normalize_scalar(raw),
                        span,
                    ));
                }
            }
            i += 1;
        }
        if values.is_empty() {
            Availability::Empty
        } else {
            Availability::Present(values)
        }
    }

    fn parse_schedules(
        &mut self,
        index: usize,
        end: usize,
        raw_value: &str,
        key_indent: usize,
        event: &str,
    ) -> Availability<Vec<WorkflowSchedule>> {
        if !raw_value.is_empty() && !is_null(raw_value) {
            if raw_value.contains("cron") {
                if let Some((raw_cron, value)) = extract_inline_cron(raw_value) {
                    let span = span_for(self.lines[index].number, self.lines[index].number)
                        .unwrap_or(InclusiveSpan { start: 1, end: 1 });
                    return Availability::Present(vec![WorkflowSchedule {
                        event: ExactText::new(event),
                        cron: LocatedText::new(raw_cron, normalize_scalar(&value), span),
                        span,
                    }]);
                }
            }
            self.add_gap(self.lines[index].number, "unsupported inline schedule form");
            return Availability::Unavailable;
        }
        let first = self.next_nonblank(index + 1, end);
        let Some(first) = first else {
            return Availability::Empty;
        };
        if self.lines[first].indent <= key_indent {
            return Availability::Empty;
        }
        let list_indent = self.lines[first].indent;
        let mut schedules = Vec::new();
        let mut i = first;
        while i < end {
            let line = self.lines[i];
            let trimmed = line.content.trim_start();
            if line.content.trim().is_empty() || trimmed.starts_with('#') {
                i += 1;
                continue;
            }
            if line.indent <= key_indent {
                break;
            }
            if line.indent == list_indent && trimmed.starts_with('-') {
                let item = trimmed[1..].trim();
                if let Some((raw_key, raw_cron)) = parse_mapping(item) {
                    if normalize_scalar(raw_key) == "cron" && !raw_cron.trim().is_empty() {
                        let span = span_for(line.number, line.number)
                            .unwrap_or(InclusiveSpan { start: 1, end: 1 });
                        schedules.push(WorkflowSchedule {
                            event: ExactText::new(event),
                            cron: LocatedText::new(
                                raw_cron.trim().to_owned(),
                                normalize_scalar(raw_cron),
                                span,
                            ),
                            span,
                        });
                    } else {
                        self.add_gap(line.number, "schedule item has no scalar cron value");
                    }
                } else {
                    let nested_end = self.next_list_item_or_end(i + 1, end, list_indent);
                    let mut found = false;
                    for nested in i + 1..nested_end {
                        let nested_line = self.lines[nested];
                        if nested_line.indent > list_indent {
                            if let Some((raw_key, raw_cron)) =
                                parse_mapping(nested_line.content.trim())
                            {
                                if normalize_scalar(raw_key) == "cron" {
                                    let span = span_for(nested_line.number, nested_line.number)
                                        .unwrap_or(InclusiveSpan { start: 1, end: 1 });
                                    schedules.push(WorkflowSchedule {
                                        event: ExactText::new(event),
                                        cron: LocatedText::new(
                                            raw_cron.trim().to_owned(),
                                            normalize_scalar(raw_cron),
                                            span,
                                        ),
                                        span,
                                    });
                                    found = true;
                                }
                            }
                        }
                    }
                    if !found {
                        self.add_gap(line.number, "schedule item has no cron field");
                    }
                    i = nested_end;
                    continue;
                }
            }
            i += 1;
        }
        if schedules.is_empty() {
            Availability::Empty
        } else {
            Availability::Present(schedules)
        }
    }

    fn parse_inputs(
        &mut self,
        index: usize,
        end: usize,
        raw_value: &str,
        key_indent: usize,
        event: &str,
    ) -> Availability<Vec<ManualInput>> {
        if !raw_value.is_empty() && !is_null(raw_value) {
            self.add_gap(
                self.lines[index].number,
                "inline workflow inputs are not fully supported",
            );
            return Availability::Unavailable;
        }
        let first = self.next_nonblank(index + 1, end);
        let Some(first) = first else {
            return Availability::Empty;
        };
        if self.lines[first].indent <= key_indent {
            return Availability::Empty;
        }
        let input_indent = self.lines[first].indent;
        let mut starts = Vec::new();
        let mut i = first;
        while i < end {
            let line = self.lines[i];
            let trimmed = line.content.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                i += 1;
                continue;
            }
            if line.indent <= key_indent {
                break;
            }
            if line.indent == input_indent {
                if let Some((raw_name, raw_value)) = parse_mapping(trimmed) {
                    starts.push((i, raw_name.trim().to_owned(), raw_value.trim().to_owned()));
                } else {
                    self.add_gap(line.number, "manual input entry is not a mapping");
                }
            }
            i += 1;
        }
        if starts.is_empty() {
            return Availability::Empty;
        }
        let mut inputs = Vec::new();
        for (position, (start, raw_name, inline)) in starts.iter().enumerate() {
            let next = starts
                .get(position + 1)
                .map(|(next, _, _)| *next)
                .unwrap_or(end);
            let name_span = span_for(self.lines[*start].number, self.lines[*start].number)
                .unwrap_or(InclusiveSpan { start: 1, end: 1 });
            let mut input = ManualInput {
                event: ExactText::new(event),
                name: LocatedText::new(raw_name.clone(), normalize_scalar(raw_name), name_span),
                input_type: Availability::Empty,
                default: Availability::Empty,
                required: Availability::Empty,
                description: Availability::Empty,
                options: Availability::Empty,
                span: name_span,
            };
            if !inline.is_empty() && !is_null(inline) {
                self.add_gap(
                    self.lines[*start].number,
                    "inline manual input configuration is not fully supported",
                );
                input.span = name_span;
            }
            let property_start = self.next_nonblank(*start + 1, next);
            if let Some(property_start) = property_start {
                if self.lines[property_start].indent > input_indent {
                    let property_indent = self.lines[property_start].indent;
                    let mut property_end = self.lines[*start].number;
                    for property in property_start..next {
                        let property_line = self.lines[property];
                        let trimmed = property_line.content.trim();
                        if trimmed.is_empty() || trimmed.starts_with('#') {
                            continue;
                        }
                        if property_line.indent <= input_indent {
                            break;
                        }
                        property_end = property_line.number;
                        if property_line.indent == property_indent {
                            if let Some((raw_key, raw_value)) = parse_mapping(trimmed) {
                                let key = normalize_scalar(raw_key);
                                let located = LocatedText::new(
                                    raw_value.trim().to_owned(),
                                    normalize_scalar(raw_value),
                                    span_for(property_line.number, property_line.number)
                                        .unwrap_or(InclusiveSpan { start: 1, end: 1 }),
                                );
                                match key.as_str() {
                                    "type" => {
                                        input.input_type = if raw_value.trim().is_empty() {
                                            Availability::Empty
                                        } else {
                                            Availability::Present(located)
                                        }
                                    }
                                    "default" => {
                                        input.default = if raw_value.trim().is_empty() {
                                            Availability::Empty
                                        } else {
                                            Availability::Present(located)
                                        }
                                    }
                                    "required" => {
                                        input.required = if raw_value.trim().is_empty() {
                                            Availability::Empty
                                        } else {
                                            Availability::Present(located)
                                        }
                                    }
                                    "description" => {
                                        input.description = if raw_value.trim().is_empty() {
                                            Availability::Empty
                                        } else {
                                            Availability::Present(located)
                                        }
                                    }
                                    "options" => {
                                        input.options = self.parse_values(
                                            property,
                                            next,
                                            raw_value.trim(),
                                            property_indent,
                                            "input options",
                                        )
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    input.span =
                        span_for(self.lines[*start].number, property_end).unwrap_or(name_span);
                }
            }
            inputs.push(input);
        }
        Availability::Present(inputs)
    }

    fn parse_job_conditions(&mut self, jobs_index: usize) -> Availability<Vec<JobCondition>> {
        let end = self.top_level_end(jobs_index);
        let first = self.next_nonblank(jobs_index + 1, end);
        let Some(first) = first else {
            return Availability::Empty;
        };
        let job_indent = self.lines[first].indent;
        let mut starts = Vec::new();
        for index in first..end {
            let line = self.lines[index];
            let trimmed = line.content.trim();
            if line.indent == job_indent && !trimmed.is_empty() && !trimmed.starts_with('#') {
                if let Some((raw_job, _)) = parse_mapping(trimmed) {
                    starts.push((index, normalize_scalar(raw_job)));
                }
            }
        }
        let mut conditions = Vec::new();
        for (position, (start, job)) in starts.iter().enumerate() {
            let next = starts
                .get(position + 1)
                .map(|(index, _)| *index)
                .unwrap_or(end);
            let child = self.next_nonblank(*start + 1, next);
            let Some(child) = child else { continue };
            let child_indent = self.lines[child].indent;
            for index in child..next {
                let line = self.lines[index];
                if line.indent != child_indent {
                    continue;
                }
                let trimmed = line.content.trim();
                let Some((raw_key, raw_value)) = parse_mapping(trimmed) else {
                    continue;
                };
                if normalize_scalar(raw_key) != "if" {
                    continue;
                }
                let value = raw_value.trim();
                if value.is_empty() || value == "|" || value == ">" {
                    let block_end = self.block_value_end(index + 1, next, child_indent);
                    let text = self.block_value_text(index + 1, block_end, line.indent);
                    if text.is_empty() {
                        self.add_gap(line.number, "job condition has no value");
                        continue;
                    }
                    let span = span_for(
                        line.number,
                        block_end_line(&self.lines, block_end, line.number),
                    )
                    .unwrap_or(InclusiveSpan { start: 1, end: 1 });
                    conditions.push(JobCondition {
                        job: ExactText::new(job.clone()),
                        condition: LocatedText::new(text.clone(), text, span),
                        span,
                    });
                } else {
                    let span = span_for(line.number, line.number)
                        .unwrap_or(InclusiveSpan { start: 1, end: 1 });
                    conditions.push(JobCondition {
                        job: ExactText::new(job.clone()),
                        condition: LocatedText::new(
                            value.to_owned(),
                            normalize_scalar(value),
                            span,
                        ),
                        span,
                    });
                }
            }
        }
        if conditions.is_empty() {
            Availability::Empty
        } else {
            conditions.sort_by(|left, right| {
                left.span
                    .cmp(&right.span)
                    .then_with(|| left.job.cmp(&right.job))
            });
            Availability::Present(conditions)
        }
    }

    fn parse_build_commands(&mut self, top_keys: &[(String, usize)]) -> Vec<BuildCommand> {
        let Some((_, jobs_index)) = top_keys.iter().find(|(key, _)| key == "jobs") else {
            return Vec::new();
        };
        let end = self.top_level_end(*jobs_index);
        let first = self.next_nonblank(*jobs_index + 1, end);
        let Some(first) = first else {
            return Vec::new();
        };
        let job_indent = self.lines[first].indent;
        let mut jobs = Vec::new();
        for index in first..end {
            let line = self.lines[index];
            if line.indent != job_indent
                || line.content.trim().is_empty()
                || line.content.trim().starts_with('#')
            {
                continue;
            }
            if let Some((raw_job, _)) = parse_mapping(line.content.trim()) {
                let next = (index + 1..end)
                    .find(|candidate| {
                        self.lines[*candidate].indent == job_indent
                            && !self.lines[*candidate].content.trim().is_empty()
                            && !self.lines[*candidate].content.trim().starts_with('#')
                    })
                    .unwrap_or(end);
                jobs.push((index, next, normalize_scalar(raw_job)));
            }
        }
        let mut commands = Vec::new();
        for (job_start, job_end, job) in jobs {
            let mut index = job_start + 1;
            while index < job_end {
                let line = self.lines[index];
                let trimmed = line.content.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    index += 1;
                    continue;
                }
                let Some((raw_key, raw_value)) = parse_mapping(trimmed).or_else(|| {
                    trimmed
                        .strip_prefix('-')
                        .and_then(|item| parse_mapping(item.trim()))
                }) else {
                    index += 1;
                    continue;
                };
                let key = normalize_scalar(raw_key.trim_start_matches('-').trim());
                if key != "run" && key != "uses" {
                    index += 1;
                    continue;
                }
                let value = raw_value.trim();
                let step = self.step_name(index, job_start + 1, job_end);
                let span_line = line.number;
                if key == "uses" {
                    if let Some(operation) = operation_for_action(value) {
                        let span = span_for(span_line, span_line)
                            .unwrap_or(InclusiveSpan { start: 1, end: 1 });
                        commands.push(BuildCommand::action(
                            operation,
                            value.to_owned(),
                            normalize_scalar(value),
                            job.clone(),
                            step,
                            span,
                        ));
                    }
                    index += 1;
                    continue;
                }
                if value == "|"
                    || value == ">"
                    || value.starts_with("| ")
                    || value.starts_with("> ")
                {
                    let block_end = self.block_value_end(index + 1, job_end, line.indent);
                    let block_indent = self
                        .block_indent(index + 1, block_end)
                        .unwrap_or(line.indent + 2);
                    for block_index in index + 1..block_end {
                        let block_line = self.lines[block_index];
                        if block_line.text.trim().is_empty() || block_line.indent < block_indent {
                            continue;
                        }
                        let command = block_line
                            .text
                            .get(block_indent..)
                            .unwrap_or(block_line.text)
                            .trim_end();
                        if let Some(operation) = operation_for_shell(command) {
                            let span = span_for(block_line.number, block_line.number)
                                .unwrap_or(InclusiveSpan { start: 1, end: 1 });
                            commands.push(BuildCommand::run(
                                operation,
                                command.to_owned(),
                                command.to_owned(),
                                job.clone(),
                                step.clone(),
                                span,
                            ));
                        }
                    }
                    index = block_end;
                    continue;
                }
                if let Some(operation) = operation_for_shell(value) {
                    let span = span_for(span_line, span_line)
                        .unwrap_or(InclusiveSpan { start: 1, end: 1 });
                    commands.push(BuildCommand::run(
                        operation,
                        value.to_owned(),
                        normalize_scalar(value),
                        job.clone(),
                        step,
                        span,
                    ));
                }
                index += 1;
            }
        }
        commands.sort_by(|left, right| {
            left.span
                .cmp(&right.span)
                .then_with(|| left.job.cmp(&right.job))
                .then_with(|| left.step.cmp(&right.step))
                .then_with(|| left.text.cmp(&right.text))
        });
        commands
    }

    fn step_name(&self, index: usize, job_start: usize, job_end: usize) -> String {
        let current = self.lines[index];
        let mut list_index = None;
        for candidate in (job_start..=index).rev() {
            let line = self.lines[candidate];
            if line.content.trim_start().starts_with('-') && line.indent < current.indent {
                list_index = Some(candidate);
                break;
            }
            if candidate < index
                && line.indent <= current.indent
                && parse_mapping(line.content.trim()).is_some()
                && normalize_key_from_line(line.content.trim()) == Some("steps")
            {
                break;
            }
        }
        let Some(list_index) = list_index else {
            return "unnamed".to_owned();
        };
        let list_line = self.lines[list_index];
        let list_indent = list_line.indent;
        let list_content = list_line.content.trim_start()[1..].trim();
        if let Some((key, value)) = parse_mapping(list_content) {
            if normalize_scalar(key) == "name" && !value.trim().is_empty() {
                return normalize_scalar(value);
            }
        }
        for candidate in list_index + 1..=index.min(job_end.saturating_sub(1)) {
            let line = self.lines[candidate];
            if line.indent <= list_indent && candidate != index {
                break;
            }
            if let Some((key, value)) = parse_mapping(line.content.trim()) {
                if normalize_scalar(key) == "name" && !value.trim().is_empty() {
                    return normalize_scalar(value);
                }
            }
        }
        "unnamed".to_owned()
    }

    fn build_triggers(
        &self,
        events: Vec<WorkflowEvent>,
        job_conditions: Availability<Vec<JobCondition>>,
    ) -> WorkflowTriggerInventory {
        if events.is_empty() {
            let mut triggers = WorkflowTriggerInventory::empty(self.full_span());
            triggers.job_conditions = job_conditions;
            if !matches!(triggers.job_conditions, Availability::Present(_)) {
                if matches!(triggers.job_conditions, Availability::Unavailable) {
                    triggers
                        .none_configured
                        .retain(|record| record.category != TriggerCategory::JobConditions);
                }
            }
            return triggers;
        }
        let mut branches = Vec::new();
        let mut branches_ignore = Vec::new();
        let mut tags = Vec::new();
        let mut tags_ignore = Vec::new();
        let mut paths = Vec::new();
        let mut paths_ignore = Vec::new();
        let mut schedules = Vec::new();
        let mut manual_inputs = Vec::new();
        let mut workflow_call_inputs = Vec::new();
        for event in &events {
            collect_trigger_values(&mut branches, &event.name, &event.branches);
            collect_trigger_values(&mut branches_ignore, &event.name, &event.branches_ignore);
            collect_trigger_values(&mut tags, &event.name, &event.tags);
            collect_trigger_values(&mut tags_ignore, &event.name, &event.tags_ignore);
            collect_trigger_values(&mut paths, &event.name, &event.paths);
            collect_trigger_values(&mut paths_ignore, &event.name, &event.paths_ignore);
            collect_present(&mut schedules, &event.schedules);
            if event.name.as_str() == "workflow_call" {
                collect_present(&mut workflow_call_inputs, &event.manual_inputs);
            } else if event.name.as_str() == "workflow_dispatch" {
                collect_present(&mut manual_inputs, &event.manual_inputs);
            } else {
                collect_present(&mut manual_inputs, &event.manual_inputs);
            }
        }
        let mut none_configured = Vec::new();
        add_none_if_empty(
            &mut none_configured,
            TriggerCategory::Branches,
            &branches,
            self.full_span(),
        );
        add_none_if_empty(
            &mut none_configured,
            TriggerCategory::BranchesIgnore,
            &branches_ignore,
            self.full_span(),
        );
        add_none_if_empty(
            &mut none_configured,
            TriggerCategory::Tags,
            &tags,
            self.full_span(),
        );
        add_none_if_empty(
            &mut none_configured,
            TriggerCategory::TagsIgnore,
            &tags_ignore,
            self.full_span(),
        );
        add_none_if_empty(
            &mut none_configured,
            TriggerCategory::Paths,
            &paths,
            self.full_span(),
        );
        add_none_if_empty(
            &mut none_configured,
            TriggerCategory::PathsIgnore,
            &paths_ignore,
            self.full_span(),
        );
        add_none_if_empty(
            &mut none_configured,
            TriggerCategory::Schedules,
            &schedules,
            self.full_span(),
        );
        add_none_if_empty(
            &mut none_configured,
            TriggerCategory::ManualInputs,
            &manual_inputs,
            self.full_span(),
        );
        add_none_if_empty(
            &mut none_configured,
            TriggerCategory::WorkflowCallInputs,
            &workflow_call_inputs,
            self.full_span(),
        );
        if !matches!(job_conditions, Availability::Present(_)) {
            none_configured.push(NoneConfigured {
                category: TriggerCategory::JobConditions,
                event: Availability::Empty,
                span: self.full_span(),
            });
        }
        WorkflowTriggerInventory {
            events: Availability::Present(events),
            branches: vec_availability(branches),
            branches_ignore: vec_availability(branches_ignore),
            tags: vec_availability(tags),
            tags_ignore: vec_availability(tags_ignore),
            paths: vec_availability(paths),
            paths_ignore: vec_availability(paths_ignore),
            schedules: vec_availability(schedules),
            manual_inputs: vec_availability(manual_inputs),
            workflow_call_inputs: vec_availability(workflow_call_inputs),
            job_conditions,
            none_configured,
        }
    }

    fn top_level_end(&self, index: usize) -> usize {
        for candidate in index + 1..self.lines.len() {
            let line = self.lines[candidate];
            if line.indent == 0
                && !line.content.trim().is_empty()
                && !line.content.trim().starts_with('#')
            {
                if parse_mapping(line.content.trim()).is_some() {
                    return candidate;
                }
            }
        }
        self.lines.len()
    }

    fn next_nonblank(&self, start: usize, end: usize) -> Option<usize> {
        (start..end).find(|index| {
            let trimmed = self.lines[*index].content.trim();
            !trimmed.is_empty() && !trimmed.starts_with('#')
        })
    }

    fn next_list_item_or_end(&self, start: usize, end: usize, indent: usize) -> usize {
        (start..end)
            .find(|index| {
                let line = self.lines[*index];
                line.indent == indent && line.content.trim_start().starts_with('-')
            })
            .unwrap_or(end)
    }

    fn block_value_end(&self, start: usize, end: usize, value_indent: usize) -> usize {
        for index in start..end {
            let line = self.lines[index];
            let trimmed = line.content.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('#') && line.indent <= value_indent {
                return index;
            }
        }
        end
    }

    fn block_indent(&self, start: usize, end: usize) -> Option<usize> {
        (start..end)
            .filter_map(|index| {
                let line = self.lines[index];
                if line.content.trim().is_empty() {
                    None
                } else {
                    Some(line.indent)
                }
            })
            .min()
    }

    fn block_value_text(&self, start: usize, end: usize, parent_indent: usize) -> String {
        let min_indent = self.block_indent(start, end).unwrap_or(parent_indent + 2);
        (start..end)
            .map(|index| {
                let line = self.lines[index];
                line.text
                    .get(min_indent.min(line.text.len())..)
                    .unwrap_or("")
                    .trim_end()
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_owned()
    }

    fn add_gap(&mut self, line: usize, reason: impl Into<String>) {
        let span = span_for(line, line).unwrap_or(InclusiveSpan { start: 1, end: 1 });
        let gap = WorkflowParseGap::new(self.path.clone(), reason, span);
        if !self.gaps.contains(&gap) {
            self.gaps.push(gap);
        }
    }
}

fn event_none_configured(event: &WorkflowEvent, span: InclusiveSpan) -> Vec<NoneConfigured> {
    let mut records = Vec::new();
    for (category, available) in [
        (TriggerCategory::Branches, &event.branches),
        (TriggerCategory::BranchesIgnore, &event.branches_ignore),
        (TriggerCategory::Tags, &event.tags),
        (TriggerCategory::TagsIgnore, &event.tags_ignore),
        (TriggerCategory::Paths, &event.paths),
        (TriggerCategory::PathsIgnore, &event.paths_ignore),
    ] {
        if matches!(available, Availability::Empty) {
            records.push(NoneConfigured {
                category,
                event: Availability::Present(event.name.clone()),
                span,
            });
        }
    }
    if matches!(event.schedules, Availability::Empty) {
        records.push(NoneConfigured {
            category: TriggerCategory::Schedules,
            event: Availability::Present(event.name.clone()),
            span,
        });
    }
    if matches!(event.manual_inputs, Availability::Empty) {
        records.push(NoneConfigured {
            category: TriggerCategory::ManualInputs,
            event: Availability::Present(event.name.clone()),
            span,
        });
    }
    records
}

fn collect_trigger_values(
    target: &mut Vec<TriggerValue>,
    event: &ExactText,
    values: &Availability<Vec<LocatedText>>,
) {
    if let Availability::Present(values) = values {
        target.extend(values.iter().map(|value| TriggerValue {
            event: event.clone(),
            raw: value.raw.clone(),
            value: value.value.clone(),
            span: value.span,
        }));
    }
}

fn collect_present<T: Clone>(target: &mut Vec<T>, values: &Availability<Vec<T>>) {
    if let Availability::Present(values) = values {
        target.extend(values.iter().cloned());
    }
}

fn add_none_if_empty<T>(
    target: &mut Vec<NoneConfigured>,
    category: TriggerCategory,
    values: &[T],
    span: InclusiveSpan,
) {
    if values.is_empty() {
        target.push(NoneConfigured {
            category,
            event: Availability::Empty,
            span,
        });
    }
}

fn vec_availability<T>(values: Vec<T>) -> Availability<Vec<T>> {
    if values.is_empty() {
        Availability::Empty
    } else {
        Availability::Present(values)
    }
}

fn span_for(start: usize, end: usize) -> Option<InclusiveSpan> {
    let start = u32::try_from(start).ok()?;
    let end = u32::try_from(end.max(start as usize)).ok()?;
    InclusiveSpan::new(start, end).ok()
}

fn end_line_number(lines: &[SourceLine<'_>], start: usize, end: usize, fallback: usize) -> usize {
    if end > start {
        lines[end - 1].number
    } else {
        fallback
    }
}

fn block_end_line(lines: &[SourceLine<'_>], end: usize, fallback: usize) -> usize {
    if end == 0 {
        fallback
    } else {
        lines[end.saturating_sub(1)].number
    }
}

fn parse_mapping(content: &str) -> Option<(&str, &str)> {
    let colon = find_unquoted_colon(content)?;
    let (key, value) = content.split_at(colon);
    if key.trim().is_empty() {
        return None;
    }
    Some((key.trim(), value[1..].trim()))
}

fn normalize_key_from_line(content: &str) -> Option<&str> {
    parse_mapping(content).map(|(key, _)| key.trim_matches(['\'', '\"']))
}

fn find_unquoted_colon(value: &str) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    for (index, byte) in value.bytes().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' && quote == Some(b'\"') {
            escaped = true;
            continue;
        }
        match quote {
            Some(current) if byte == current => quote = None,
            None if byte == b'\'' || byte == b'\"' => quote = Some(byte),
            None if byte == b':' => return Some(index),
            _ => {}
        }
    }
    None
}

fn normalize_scalar(value: &str) -> String {
    let value = strip_inline_comment(value).trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
            || (bytes[0] == b'\"' && bytes[value.len() - 1] == b'\"')
        {
            return value[1..value.len() - 1].to_owned();
        }
    }
    value.to_owned()
}

fn strip_inline_comment(value: &str) -> &str {
    let mut quote = None;
    for (index, byte) in value.bytes().enumerate() {
        match quote {
            Some(current) if byte == current => quote = None,
            None if byte == b'\'' || byte == b'\"' => quote = Some(byte),
            None if byte == b'#'
                && (index == 0 || value.as_bytes()[index - 1].is_ascii_whitespace()) =>
            {
                return &value[..index]
            }
            _ => {}
        }
    }
    value
}

fn is_null(value: &str) -> bool {
    let normalized = normalize_scalar(value);
    normalized.is_empty() || normalized == "null" || normalized == "~"
}

fn balanced_value(value: &str) -> bool {
    let mut quote = None;
    let mut stack = Vec::new();
    let mut escaped = false;
    for byte in value.bytes() {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' && quote == Some(b'\"') {
            escaped = true;
            continue;
        }
        if let Some(current) = quote {
            if byte == current {
                quote = None;
            }
            continue;
        }
        match byte {
            b'\'' | b'\"' => quote = Some(byte),
            b'[' | b'{' => stack.push(byte),
            b']' => {
                if stack.pop() != Some(b'[') {
                    return false;
                }
            }
            b'}' => {
                if stack.pop() != Some(b'{') {
                    return false;
                }
            }
            _ => {}
        }
    }
    quote.is_none() && stack.is_empty()
}

fn inline_list(value: &str) -> Option<Vec<String>> {
    let value = strip_inline_comment(value).trim();
    if !(value.starts_with('[') && value.ends_with(']')) {
        return None;
    }
    Some(split_top_level(&value[1..value.len() - 1], ','))
}

fn inline_map(value: &str) -> Option<Vec<(String, String)>> {
    let value = strip_inline_comment(value).trim();
    if !(value.starts_with('{') && value.ends_with('}')) {
        return None;
    }
    let mut entries = Vec::new();
    for item in split_top_level(&value[1..value.len() - 1], ',') {
        if item.trim().is_empty() {
            continue;
        }
        if let Some((key, val)) = parse_mapping(&item) {
            entries.push((key.trim().to_owned(), val.trim().to_owned()));
        }
    }
    Some(entries)
}

fn split_top_level(value: &str, separator: char) -> Vec<String> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let mut depth = 0_i32;
    for (index, byte) in value.bytes().enumerate() {
        match quote {
            Some(current) if byte == current => quote = None,
            None if byte == b'\'' || byte == b'\"' => quote = Some(byte),
            None => match byte {
                b'[' | b'{' => depth += 1,
                b']' | b'}' => depth -= 1,
                byte if byte == separator as u8 && depth == 0 => {
                    result.push(value[start..index].trim().to_owned());
                    start = index + 1;
                }
                _ => {}
            },
            _ => {}
        }
    }
    result.push(value[start..].trim().to_owned());
    result
}

fn extract_inline_cron(value: &str) -> Option<(String, String)> {
    if let Some((_, raw)) = inline_map(value).and_then(|entries| {
        entries
            .into_iter()
            .find(|(key, _)| normalize_scalar(key) == "cron")
    }) {
        let raw = raw.trim().to_owned();
        return Some((raw.clone(), raw));
    }
    let lower = value.to_ascii_lowercase();
    let start = lower.find("cron")?;
    let after = &value[start..];
    let (_, raw) = parse_mapping(after)?;
    let raw = raw.trim().trim_end_matches('}').trim().to_owned();
    Some((raw.clone(), raw))
}

fn is_event_name(value: &str) -> bool {
    let value = normalize_scalar(value);
    !value.is_empty() && value != "true" && value != "false" && value != "null" && value != "~"
}

fn operation_for_action(value: &str) -> Option<BuildOperation> {
    let action = normalize_scalar(value).to_ascii_lowercase();
    let action = action.split('@').next().unwrap_or(&action);
    if action.contains("upload-artifact") || action.contains("upload-pages-artifact") {
        return Some(BuildOperation::Upload);
    }
    if action.contains("build-push") || action.contains("release") || action.contains("publish") {
        return if action.contains("upload") {
            Some(BuildOperation::Upload)
        } else {
            Some(BuildOperation::Publish)
        };
    }
    if action.starts_with("actions/setup-") || action.contains("/setup-") {
        return Some(BuildOperation::Setup);
    }
    let last = action.rsplit('/').next().unwrap_or(&action);
    if last.contains("test") {
        return Some(BuildOperation::Test);
    }
    if last.contains("package") || last.contains("pack") {
        return Some(BuildOperation::Package);
    }
    if last.contains("build") {
        return Some(BuildOperation::Compile);
    }
    None
}

fn operation_for_shell(value: &str) -> Option<BuildOperation> {
    for segment in value
        .split([';', '\n'])
        .flat_map(|part| part.split("&&"))
        .flat_map(|part| part.split("||"))
    {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        let mut tokens = segment.split_whitespace().peekable();
        while let Some(token) = tokens.next() {
            let token = token.trim_matches(|character: char| "(){}<>".contains(character));
            if token.is_empty() {
                continue;
            }
            if token == "sudo" || token == "command" || token == "env" || token == "xargs" {
                continue;
            }
            if token.starts_with("#")
                || token == "echo"
                || token == "printf"
                || token == "true"
                || token == "false"
            {
                break;
            }
            let executable = token.rsplit('/').next().unwrap_or(token);
            let executable = executable.strip_suffix(".exe").unwrap_or(executable);
            let next = tokens
                .clone()
                .next()
                .map(|next| next.trim_matches(|character: char| "(){}<>".contains(character)));
            let operation = match executable {
                "cargo" => match next {
                    Some("build") | Some("check") | Some("clippy") => Some(BuildOperation::Compile),
                    Some("test") | Some("bench") => Some(BuildOperation::Test),
                    Some("package") => Some(BuildOperation::Package),
                    Some("publish") => Some(BuildOperation::Publish),
                    _ => None,
                },
                "npm" | "yarn" | "pnpm" => match next {
                    Some("build") => Some(BuildOperation::Compile),
                    Some("test") => Some(BuildOperation::Test),
                    Some("pack") => Some(BuildOperation::Package),
                    Some("publish") => Some(BuildOperation::Publish),
                    Some("run") => {
                        let _ = tokens.next();
                        match tokens.next().map(|part| {
                            part.trim_matches(|character: char| "(){}<>".contains(character))
                        }) {
                            Some("build") => Some(BuildOperation::Compile),
                            Some("test") => Some(BuildOperation::Test),
                            Some("package") | Some("pack") => Some(BuildOperation::Package),
                            _ => None,
                        }
                    }
                    _ => None,
                },
                "make" => match next {
                    Some("clean") | Some("help") => None,
                    _ => Some(BuildOperation::Compile),
                },
                "cmake" => Some(BuildOperation::Compile),
                "gradle" | "gradlew" | "mvn" | "mvnw" => match next {
                    Some("test") | Some("check") => Some(BuildOperation::Test),
                    Some("package") | Some("assemble") => Some(BuildOperation::Package),
                    Some("build") | Some("compile") => Some(BuildOperation::Compile),
                    Some("publish") | Some("deploy") => Some(BuildOperation::Publish),
                    _ => None,
                },
                "dotnet" => match next {
                    Some("build") => Some(BuildOperation::Compile),
                    Some("test") => Some(BuildOperation::Test),
                    Some("pack") => Some(BuildOperation::Package),
                    Some("publish") => Some(BuildOperation::Publish),
                    _ => None,
                },
                "go" => match next {
                    Some("build") => Some(BuildOperation::Compile),
                    Some("test") => Some(BuildOperation::Test),
                    _ => None,
                },
                "pytest" | "jest" | "vitest" => Some(BuildOperation::Test),
                "twine" => match next {
                    Some("upload") => Some(BuildOperation::Upload),
                    _ => None,
                },
                "docker" => match next {
                    Some("build") | Some("buildx") => Some(BuildOperation::Compile),
                    Some("push") => Some(BuildOperation::Publish),
                    _ => None,
                },
                "gh" => match next {
                    Some("release") => Some(BuildOperation::Publish),
                    _ => None,
                },
                _ => None,
            };
            if operation.is_some() {
                return operation;
            }
            if executable.ends_with("build") && executable.len() > "build".len() {
                return Some(BuildOperation::Compile);
            }
            if executable.ends_with("test") && executable.len() > "test".len() {
                return Some(BuildOperation::Test);
            }
        }
    }
    None
}
