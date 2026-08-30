//! Read-only committed checkpoint delta collection.
//!
//! This module deliberately keeps committed history separate from the four
//! worktree inventories.  Git is invoked with individual argv values, NUL
//! delimited output is parsed strictly, and an unavailable baseline produces a
//! current-only fallback instead of an invented comparison range or path set.

use crate::{
    Availability, BaselineDecision, ExactText, FoundationError, FullId, ReleaseBaseline,
    RepoRelativePath,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Stable reason recorded when no selected baseline can define a committed
/// baseline-to-current comparison.
pub const BASELINE_TO_CURRENT_UNAVAILABLE: &str =
    "baseline-to-current comparison unavailable: no selected baseline";

/// Compatibility spelling for callers that name the fallback by its outcome.
pub const NO_BASELINE_CURRENT_FALLBACK: &str = BASELINE_TO_CURRENT_UNAVAILABLE;

const REVISION_FORMAT: &str = "%H%x00%cI%x00%ct%x00%s%x00";

/// The complete current checkout revision used as the inclusive end boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurrentRevision {
    /// The complete object ID emitted by Git's `%H` formatter.
    pub commit: FullId,
    /// The exact committer date emitted by Git's `%cI` formatter, including
    /// its original timezone offset.
    pub committer_date: ExactText,
    /// The exact one-line subject emitted by Git's `%s` formatter.
    pub subject: ExactText,
}

impl CurrentRevision {
    pub fn new(
        commit: FullId,
        committer_date: impl Into<String>,
        subject: impl Into<String>,
    ) -> Self {
        Self {
            commit,
            committer_date: ExactText::new(committer_date),
            subject: ExactText::new(subject),
        }
    }

    /// Compatibility accessor using the shorter date spelling.
    pub fn date(&self) -> &ExactText {
        &self.committer_date
    }

    /// Compatibility accessor for callers that call the object ID an ID.
    pub fn id(&self) -> &FullId {
        &self.commit
    }

    pub fn full_id(&self) -> &FullId {
        &self.commit
    }

    pub fn committer_date(&self) -> &ExactText {
        &self.committer_date
    }
}

/// The exact committed comparison boundaries.  The baseline is excluded and
/// the current revision is included; equal boundaries therefore produce an
/// explicitly empty delta.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComparisonRange {
    pub baseline: FullId,
    pub current: FullId,
}

impl ComparisonRange {
    pub fn new(baseline: FullId, current: FullId) -> Self {
        Self { baseline, current }
    }

    pub const fn baseline_is_excluded(&self) -> bool {
        true
    }

    pub const fn current_is_included(&self) -> bool {
        true
    }
    pub fn is_empty(&self) -> bool {
        self.baseline == self.current
    }
}

/// One post-baseline commit in deterministic chronological order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitRecord {
    pub commit: FullId,
    /// Exact committer date, retaining the source timezone offset.
    pub committer_date: ExactText,
    /// Exact one-line commit subject.
    pub subject: ExactText,
}

impl CommitRecord {
    pub fn new(
        commit: FullId,
        committer_date: impl Into<String>,
        subject: impl Into<String>,
    ) -> Self {
        Self {
            commit,
            committer_date: ExactText::new(committer_date),
            subject: ExactText::new(subject),
        }
    }

    pub fn id(&self) -> &FullId {
        &self.commit
    }

    pub fn date(&self) -> &ExactText {
        &self.committer_date
    }

    pub fn full_id(&self) -> &FullId {
        &self.commit
    }

    pub fn committer_date(&self) -> &ExactText {
        &self.committer_date
    }
}

/// The four committed net path outcomes required by the audit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum ChangedPathStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// One net changed path from the baseline to the current boundary.
///
/// `path` is the primary path (the new path for a rename).  `old_path` and
/// `new_path` make rename pairing explicit and are empty for the side that does
/// not exist for an add/delete.  A rename always has both path fields present.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedPath {
    pub status: ChangedPathStatus,
    pub path: RepoRelativePath,
    pub old_path: Availability<RepoRelativePath>,
    pub new_path: Availability<RepoRelativePath>,
}

impl ChangedPath {
    pub fn added(path: RepoRelativePath) -> Self {
        Self {
            status: ChangedPathStatus::Added,
            path: path.clone(),
            old_path: Availability::Empty,
            new_path: Availability::Present(path),
        }
    }

    pub fn modified(path: RepoRelativePath) -> Self {
        Self {
            status: ChangedPathStatus::Modified,
            path: path.clone(),
            old_path: Availability::Present(path.clone()),
            new_path: Availability::Present(path),
        }
    }

    pub fn deleted(path: RepoRelativePath) -> Self {
        Self {
            status: ChangedPathStatus::Deleted,
            path: path.clone(),
            old_path: Availability::Present(path),
            new_path: Availability::Empty,
        }
    }

    pub fn renamed(old_path: RepoRelativePath, new_path: RepoRelativePath) -> Self {
        Self {
            status: ChangedPathStatus::Renamed,
            path: new_path.clone(),
            old_path: Availability::Present(old_path),
            new_path: Availability::Present(new_path),
        }
    }

    pub fn is_renamed(&self) -> bool {
        self.status == ChangedPathStatus::Renamed
    }

    pub fn primary_path(&self) -> &RepoRelativePath {
        &self.path
    }
}

/// The compared committed delta.  Worktree inventories are intentionally not
/// folded into this value; callers collect them through
/// [`crate::LocalReleaseEvidenceCollector`] and retain their four categories.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeltaComparison {
    pub current: CurrentRevision,
    pub range: ComparisonRange,
    pub commits: Vec<CommitRecord>,
    pub changed_paths: Vec<ChangedPath>,
}

/// Current-only evidence emitted when baseline selection did not produce one
/// usable baseline.  There is deliberately no range, commit list, or path list
/// in this outcome, so a missing baseline cannot manufacture a delta.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurrentFallback {
    pub reason: ExactText,
    pub current: CurrentRevision,
}

impl CurrentFallback {
    pub fn new(current: CurrentRevision) -> Self {
        Self {
            reason: ExactText::new(BASELINE_TO_CURRENT_UNAVAILABLE),
            current,
        }
    }

    pub fn comparison_is_unavailable(&self) -> bool {
        true
    }
}

/// The serializable committed-delta outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeltaReport {
    Compared(DeltaComparison),
    CurrentFallback(CurrentFallback),
}

impl DeltaReport {
    pub fn is_compared(&self) -> bool {
        matches!(self, Self::Compared(_))
    }

    pub fn is_current_fallback(&self) -> bool {
        matches!(self, Self::CurrentFallback(_))
    }

    pub fn current(&self) -> &CurrentRevision {
        match self {
            Self::Compared(value) => &value.current,
            Self::CurrentFallback(value) => &value.current,
        }
    }

    pub fn comparison(&self) -> Option<&DeltaComparison> {
        match self {
            Self::Compared(value) => Some(value),
            Self::CurrentFallback(_) => None,
        }
    }

    pub fn range(&self) -> Option<&ComparisonRange> {
        self.comparison().map(|value| &value.range)
    }

    pub fn commits(&self) -> &[CommitRecord] {
        self.comparison()
            .map(|value| value.commits.as_slice())
            .unwrap_or(&[])
    }

    pub fn changed_paths(&self) -> &[ChangedPath] {
        self.comparison()
            .map(|value| value.changed_paths.as_slice())
            .unwrap_or(&[])
    }
}

/// Input accepted by the aggregate delta collector.  Both the existing
/// [`BaselineDecision`] and a directly selected [`ReleaseBaseline`] are valid;
/// an optional baseline represents the current-only fallback when absent.
pub trait DeltaSelection {
    fn selected_baseline(&self) -> Option<&ReleaseBaseline>;
}

impl DeltaSelection for BaselineDecision {
    fn selected_baseline(&self) -> Option<&ReleaseBaseline> {
        self.baseline()
    }
}

impl DeltaSelection for ReleaseBaseline {
    fn selected_baseline(&self) -> Option<&ReleaseBaseline> {
        Some(self)
    }
}

impl<'a> DeltaSelection for Option<&'a ReleaseBaseline> {
    fn selected_baseline(&self) -> Option<&ReleaseBaseline> {
        *self
    }
}

impl<T> DeltaSelection for &T
where
    T: DeltaSelection + ?Sized,
{
    fn selected_baseline(&self) -> Option<&ReleaseBaseline> {
        (*self).selected_baseline()
    }
}

/// A read-only collector rooted at one canonical repository directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitDeltaCollector {
    root: PathBuf,
}

impl GitDeltaCollector {
    pub fn new(repository_root: impl AsRef<Path>) -> Result<Self, FoundationError> {
        let root = crate::canonical_repository_root(repository_root.as_ref())?;
        Ok(Self { root })
    }

    pub fn repository_root(&self) -> &Path {
        &self.root
    }

    /// Collect a committed delta from a baseline decision.  A selected
    /// baseline uses `baseline..HEAD`; every other decision returns current-only
    /// evidence without trying to compare arbitrary commits.
    pub fn collect<S: DeltaSelection>(&self, selection: S) -> Result<DeltaReport, FoundationError> {
        match selection.selected_baseline() {
            Some(baseline) => self.collect_baseline(baseline),
            None => self.collect_current_fallback(),
        }
    }

    pub fn collect_decision(
        &self,
        decision: &BaselineDecision,
    ) -> Result<DeltaReport, FoundationError> {
        self.collect(decision)
    }

    pub fn collect_baseline(
        &self,
        baseline: &ReleaseBaseline,
    ) -> Result<DeltaReport, FoundationError> {
        let current = collect_current_revision(&self.root)?;
        let range = ComparisonRange::new(baseline.commit.clone(), current.commit.clone());
        let commits = collect_commit_records(&self.root, &range)?;
        let changed_paths = collect_changed_paths(&self.root, &range)?;
        Ok(DeltaReport::Compared(DeltaComparison {
            current,
            range,
            commits,
            changed_paths,
        }))
    }

    pub fn collect_with_baseline(
        &self,
        baseline: Option<&ReleaseBaseline>,
    ) -> Result<DeltaReport, FoundationError> {
        match baseline {
            Some(baseline) => self.collect_baseline(baseline),
            None => self.collect_current_fallback(),
        }
    }

    pub fn collect_current(&self) -> Result<CurrentRevision, FoundationError> {
        collect_current_revision(&self.root)
    }

    pub fn collect_current_revision(&self) -> Result<CurrentRevision, FoundationError> {
        self.collect_current()
    }

    pub fn collect_commits(
        &self,
        range: &ComparisonRange,
    ) -> Result<Vec<CommitRecord>, FoundationError> {
        collect_commit_records(&self.root, range)
    }

    pub fn collect_changed_paths(
        &self,
        range: &ComparisonRange,
    ) -> Result<Vec<ChangedPath>, FoundationError> {
        collect_changed_paths(&self.root, range)
    }

    fn collect_current_fallback(&self) -> Result<DeltaReport, FoundationError> {
        Ok(DeltaReport::CurrentFallback(CurrentFallback::new(
            collect_current_revision(&self.root)?,
        )))
    }
}

/// Compatibility names for callers that call this a release-delta collector.
pub type ReleaseDeltaCollector = GitDeltaCollector;
pub type DeltaCollector = GitDeltaCollector;
pub type ComparedDelta = DeltaComparison;

/// Collect a committed delta from a selected/no-baseline decision.
pub fn collect_git_delta<S: DeltaSelection>(
    repository_root: impl AsRef<Path>,
    selection: S,
) -> Result<DeltaReport, FoundationError> {
    GitDeltaCollector::new(repository_root)?.collect(selection)
}

/// Collect a committed delta from an optional selected baseline.
pub fn collect_delta(
    repository_root: impl AsRef<Path>,
    baseline: Option<&ReleaseBaseline>,
) -> Result<DeltaReport, FoundationError> {
    GitDeltaCollector::new(repository_root)?.collect_with_baseline(baseline)
}

/// Compatibility spelling for release-audit callers.
pub fn collect_release_delta<S: DeltaSelection>(
    repository_root: impl AsRef<Path>,
    selection: S,
) -> Result<DeltaReport, FoundationError> {
    collect_git_delta(repository_root, selection)
}

/// Collect a committed delta directly from one already-selected baseline.
pub fn collect_git_delta_from_baseline(
    repository_root: impl AsRef<Path>,
    baseline: &ReleaseBaseline,
) -> Result<DeltaReport, FoundationError> {
    GitDeltaCollector::new(repository_root)?.collect_baseline(baseline)
}

/// Collect a committed delta from an optional baseline under an explicit name.
pub fn collect_git_delta_with_optional_baseline(
    repository_root: impl AsRef<Path>,
    baseline: Option<&ReleaseBaseline>,
) -> Result<DeltaReport, FoundationError> {
    collect_delta(repository_root, baseline)
}

pub fn collect_current_revision(root: &Path) -> Result<CurrentRevision, FoundationError> {
    let args = vec![
        "show".to_owned(),
        "--no-patch".to_owned(),
        "--no-ext-diff".to_owned(),
        "--no-textconv".to_owned(),
        "--no-color".to_owned(),
        format!("--format={REVISION_FORMAT}"),
        "HEAD".to_owned(),
    ];
    let output = run_git(root, &args)?;
    if !output.status.success() {
        return Err(git_failure(&args, &output));
    }
    let mut records = parse_commit_records_wire(&normalize_nul_output(&output.stdout), &args)?;
    if records.len() != 1 {
        return Err(parse_error(
            &args,
            format!(
                "expected exactly one current revision, got {}",
                records.len()
            ),
        ));
    }
    let record = records.pop().expect("record length checked");
    Ok(CurrentRevision::new(
        record.commit,
        record.date,
        record.subject,
    ))
}

/// Collect every commit in `baseline..current`, ordered by committer timestamp
/// from oldest to newest with the full ID as a deterministic tie-breaker.
pub fn collect_commit_records(
    root: &Path,
    range: &ComparisonRange,
) -> Result<Vec<CommitRecord>, FoundationError> {
    let revision_range = format!("{}..{}", range.baseline, range.current);
    let args = vec![
        "log".to_owned(),
        "--full-history".to_owned(),
        "--no-decorate".to_owned(),
        "--no-color".to_owned(),
        format!("--format={REVISION_FORMAT}"),
        revision_range,
        "--".to_owned(),
    ];
    let output = run_git(root, &args)?;
    if !output.status.success() {
        return Err(git_failure(&args, &output));
    }
    let mut records = parse_commit_records_wire(&normalize_nul_output(&output.stdout), &args)?;
    // `%ct` is used only as an ordering key.  `%cI` remains the exact value
    // retained in the report, including the original offset.  Equal timestamps
    // use the complete object ID as a stable tie-breaker.
    records.sort_by(|left, right| {
        left.timestamp
            .cmp(&right.timestamp)
            .then_with(|| left.commit.cmp(&right.commit))
    });
    Ok(records
        .into_iter()
        .map(|record| CommitRecord::new(record.commit, record.date, record.subject))
        .collect())
}

pub fn collect_changed_paths(
    root: &Path,
    range: &ComparisonRange,
) -> Result<Vec<ChangedPath>, FoundationError> {
    let args = vec![
        "diff".to_owned(),
        "--no-ext-diff".to_owned(),
        "--no-textconv".to_owned(),
        "--no-color".to_owned(),
        "--find-renames".to_owned(),
        "--name-status".to_owned(),
        "-z".to_owned(),
        range.baseline.as_str().to_owned(),
        range.current.as_str().to_owned(),
        "--".to_owned(),
    ];
    let output = run_git(root, &args)?;
    if !output.status.success() {
        return Err(git_failure(&args, &output));
    }
    let mut paths = parse_changed_paths(&output.stdout, &args)?;
    paths.sort_by(|left, right| {
        let left_old = match &left.old_path {
            Availability::Present(path) => path.as_str(),
            Availability::Empty | Availability::Unavailable => "",
        };
        let right_old = match &right.old_path {
            Availability::Present(path) => path.as_str(),
            Availability::Empty | Availability::Unavailable => "",
        };
        left.primary_path()
            .cmp(right.primary_path())
            .then_with(|| left_old.cmp(right_old))
            .then_with(|| left.status.cmp(&right.status))
    });
    Ok(paths)
}

#[derive(Debug)]
struct RawCommit {
    commit: FullId,
    date: String,
    subject: String,
    timestamp: i64,
}

fn parse_commit_records_wire(
    bytes: &[u8],
    args: &[String],
) -> Result<Vec<RawCommit>, FoundationError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    if fields.last().copied() != Some(&[][..]) {
        return Err(parse_error(
            args,
            "Git commit output was not NUL terminated",
        ));
    }
    let fields = &fields[..fields.len() - 1];
    if fields.len() % 4 != 0 {
        return Err(parse_error(
            args,
            "malformed NUL-delimited Git commit record",
        ));
    }
    let mut records = Vec::with_capacity(fields.len() / 4);
    for record in fields.chunks_exact(4) {
        let commit = strict_utf8(record[0], "Git commit ID", args)?;
        let commit = FullId::new(commit).map_err(|error| parse_error(args, error.to_string()))?;
        let date = strict_utf8(record[1], "Git committer date", args)?;
        if date.is_empty() {
            return Err(parse_error(args, "Git committer date was empty"));
        }
        let timestamp = strict_utf8(record[2], "Git committer timestamp", args)?
            .parse::<i64>()
            .map_err(|_| parse_error(args, "Git committer timestamp was not an integer"))?;
        let subject = strict_utf8(record[3], "Git commit subject", args)?;
        records.push(RawCommit {
            commit,
            date,
            subject,
            timestamp,
        });
    }
    Ok(records)
}

fn parse_changed_paths(bytes: &[u8], args: &[String]) -> Result<Vec<ChangedPath>, FoundationError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    if fields.last().copied() != Some(&[][..]) {
        return Err(parse_error(
            args,
            "Git name-status output was not NUL terminated",
        ));
    }
    let fields = &fields[..fields.len() - 1];
    let mut paths = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let status = strict_utf8(fields[index], "Git path status", args)?;
        let code = status
            .as_bytes()
            .first()
            .copied()
            .ok_or_else(|| parse_error(args, "Git path status was empty"))?;
        index += 1;
        match code {
            b'R' => {
                let old = fields.get(index).ok_or_else(|| {
                    parse_error(args, "Git rename record was missing its old path")
                })?;
                let new = fields.get(index + 1).ok_or_else(|| {
                    parse_error(args, "Git rename record was missing its new path")
                })?;
                index += 2;
                let old = path_from_bytes(old, "Git old rename path", args)?;
                let new = path_from_bytes(new, "Git new rename path", args)?;
                paths.push(ChangedPath::renamed(old, new));
            }
            b'A' => {
                let path = fields
                    .get(index)
                    .ok_or_else(|| parse_error(args, "Git add record was missing its path"))?;
                index += 1;
                paths.push(ChangedPath::added(path_from_bytes(
                    path,
                    "Git added path",
                    args,
                )?));
            }
            b'M' | b'T' => {
                let path = fields
                    .get(index)
                    .ok_or_else(|| parse_error(args, "Git modified record was missing its path"))?;
                index += 1;
                paths.push(ChangedPath::modified(path_from_bytes(
                    path,
                    "Git modified path",
                    args,
                )?));
            }
            b'D' => {
                let path = fields
                    .get(index)
                    .ok_or_else(|| parse_error(args, "Git delete record was missing its path"))?;
                index += 1;
                paths.push(ChangedPath::deleted(path_from_bytes(
                    path,
                    "Git deleted path",
                    args,
                )?));
            }
            _ => {
                return Err(parse_error(
                    args,
                    format!("unsupported committed Git path status `{status}`"),
                ));
            }
        }
    }
    Ok(paths)
}

fn path_from_bytes(
    bytes: &[u8],
    label: &str,
    args: &[String],
) -> Result<RepoRelativePath, FoundationError> {
    let path = strict_utf8(bytes, label, args)?;
    RepoRelativePath::new(path).map_err(|error| parse_error(args, error.to_string()))
}

fn strict_utf8(bytes: &[u8], label: &str, args: &[String]) -> Result<String, FoundationError> {
    String::from_utf8(bytes.to_owned())
        .map_err(|_| parse_error(args, format!("{label} was not valid UTF-8")))
}

/// Git pretty formats append a line terminator after a format ending in NUL.
/// Remove only that delimiter-adjacent newline; all source fields remain exact.
fn normalize_nul_output(bytes: &[u8]) -> Vec<u8> {
    let mut normalized = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        normalized.push(byte);
        index += 1;
        if byte == 0 && bytes.get(index) == Some(&b'\n') {
            index += 1;
        }
    }
    normalized
}

fn run_git(root: &Path, args: &[String]) -> Result<Output, FoundationError> {
    // Every value is passed as one argv item.  The pager and external diff
    // paths are disabled so collection cannot execute user-configured helpers.
    Command::new("git")
        .args(args)
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .current_dir(root)
        .output()
        .map_err(|source| FoundationError::Io {
            operation: "run read-only git delta command",
            source,
        })
}

fn git_failure(args: &[String], output: &Output) -> FoundationError {
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    FoundationError::Git {
        args: args.join(" "),
        message: if message.is_empty() {
            format!("command exited with status {}", output.status)
        } else {
            message
        },
    }
}

fn parse_error(args: &[String], message: impl Into<String>) -> FoundationError {
    FoundationError::Git {
        args: args.join(" "),
        message: message.into(),
    }
}
