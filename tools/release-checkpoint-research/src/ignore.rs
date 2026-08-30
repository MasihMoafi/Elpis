//! Read-only .gitignore provenance, conservative matching, and follow-up records.
//!
//! This module never edits `.gitignore`, stages paths, removes files, or contacts
//! a remote.  It only turns an explicitly available ignore source and a
//! start-time path set into deterministic, evidence-bearing records.

use crate::artifacts::{ArtifactCandidate, ArtifactCategory, ArtifactStatus};
use crate::{
    Availability, EvidenceReference, EvidenceReferenceLocator, EvidenceSourceIdentity,
    EvidenceSourceKind, ExactText, FoundationError, InclusiveSpan, RepoRelativePath,
};
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use std::borrow::Borrow;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

/// Whether a pattern was observed in the existing ignore file or is only a
/// proposed new entry.  These values must never be collapsed in a report.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum IgnorePatternOrigin {
    ExistingIgnoreFileEntry,
    ProposedNewEntry,
}

/// Required exceptions are explicit. An empty set is represented by the named
/// `NoRequiredExceptionIdentified` variant rather than an omitted field.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum RequiredExceptionResult {
    Paths(BTreeSet<RepoRelativePath>),
    NoRequiredExceptionIdentified,
}

impl RequiredExceptionResult {
    pub fn paths<I>(paths: I) -> Result<Self, FoundationError>
    where
        I: IntoIterator<Item = RepoRelativePath>,
    {
        let paths = paths.into_iter().collect::<BTreeSet<_>>();
        if paths.is_empty() {
            return Err(FoundationError::invalid(
                "required_exceptions",
                "a path result must contain at least one exception",
            ));
        }
        Ok(Self::Paths(paths))
    }

    pub const fn none() -> Self {
        Self::NoRequiredExceptionIdentified
    }

    pub fn is_none(&self) -> bool {
        matches!(self, Self::NoRequiredExceptionIdentified)
    }

    pub fn as_paths(&self) -> Option<&BTreeSet<RepoRelativePath>> {
        match self {
            Self::Paths(paths) => Some(paths),
            Self::NoRequiredExceptionIdentified => None,
        }
    }
}

impl<'de> Deserialize<'de> for RequiredExceptionResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        enum Wire {
            Paths(BTreeSet<RepoRelativePath>),
            NoRequiredExceptionIdentified,
        }
        match Wire::deserialize(deserializer)? {
            Wire::Paths(paths) => Self::paths(paths).map_err(de::Error::custom),
            Wire::NoRequiredExceptionIdentified => Ok(Self::none()),
        }
    }
}

/// One exact active `.gitignore` line and its source citation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IgnoreFileEntry {
    pub pattern: ExactText,
    pub line: u32,
    pub evidence: EvidenceReference,
}

impl IgnoreFileEntry {
    pub fn new(
        pattern: impl Into<String>,
        line: u32,
        evidence: EvidenceReference,
    ) -> Result<Self, FoundationError> {
        let pattern = pattern.into();
        validate_pattern_text(&pattern)?;
        if line == 0 {
            return Err(FoundationError::invalid(
                "ignore_file_line",
                "ignore file lines are one-based",
            ));
        }
        Ok(Self {
            pattern: ExactText::new(pattern),
            line,
            evidence,
        })
    }
}

impl<'de> Deserialize<'de> for IgnoreFileEntry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            pattern: ExactText,
            line: u32,
            evidence: EvidenceReference,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.pattern.into_inner(), wire.line, wire.evidence).map_err(de::Error::custom)
    }
}

/// The independently available `.gitignore` source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IgnoreFileSnapshot {
    pub patterns: Availability<Vec<IgnoreFileEntry>>,
}

impl IgnoreFileSnapshot {
    pub fn available(entries: Vec<IgnoreFileEntry>) -> Result<Self, FoundationError> {
        let mut entries = entries;
        entries.sort_by(|left, right| {
            left.line
                .cmp(&right.line)
                .then_with(|| left.pattern.cmp(&right.pattern))
        });
        entries.dedup_by(|left, right| left.line == right.line && left.pattern == right.pattern);
        Ok(Self {
            patterns: if entries.is_empty() {
                Availability::Empty
            } else {
                Availability::Present(entries)
            },
        })
    }

    pub const fn empty() -> Self {
        Self {
            patterns: Availability::Empty,
        }
    }

    pub const fn unavailable() -> Self {
        Self {
            patterns: Availability::Unavailable,
        }
    }

    pub fn from_patterns<I>(patterns: I) -> Result<Self, FoundationError>
    where
        I: IntoIterator<Item = String>,
    {
        let mut entries = Vec::new();
        for (index, pattern) in patterns.into_iter().enumerate() {
            let line = u32::try_from(index + 1).map_err(|_| {
                FoundationError::invalid("ignore_file_line", "ignore file has too many lines")
            })?;
            entries.push(IgnoreFileEntry::new(
                pattern,
                line,
                ignore_file_evidence(line)?,
            )?);
        }
        Self::available(entries)
    }

    pub fn is_unavailable(&self) -> bool {
        self.patterns.is_unavailable()
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    pub fn entries(&self) -> Availability<&[IgnoreFileEntry]> {
        match &self.patterns {
            Availability::Empty => Availability::Empty,
            Availability::Unavailable => Availability::Unavailable,
            Availability::Present(entries) => Availability::Present(entries.as_slice()),
        }
    }
}

impl<'de> Deserialize<'de> for IgnoreFileSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            patterns: Availability<Vec<IgnoreFileEntry>>,
        }
        let wire = Wire::deserialize(deserializer)?;
        match wire.patterns {
            Availability::Empty => Ok(Self::empty()),
            Availability::Unavailable => Ok(Self::unavailable()),
            Availability::Present(entries) => Self::available(entries).map_err(de::Error::custom),
        }
    }
}

/// A categorized request used to build a fully evidenced pattern record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IgnorePatternRequest {
    pub pattern: ExactText,
    pub origin: IgnorePatternOrigin,
    pub category: ArtifactCategory,
    pub required_exceptions: RequiredExceptionResult,
    pub evidence: Vec<EvidenceReference>,
}

impl IgnorePatternRequest {
    pub fn new(
        pattern: impl Into<String>,
        origin: IgnorePatternOrigin,
        category: ArtifactCategory,
        required_exceptions: RequiredExceptionResult,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        let pattern = pattern.into();
        validate_pattern_text(&pattern)?;
        let evidence = normalize_evidence(evidence);
        if evidence.is_empty() {
            return Err(FoundationError::invalid(
                "ignore_pattern_evidence",
                "an ignore pattern needs evidence",
            ));
        }
        Ok(Self {
            pattern: ExactText::new(pattern),
            origin,
            category,
            required_exceptions,
            evidence,
        })
    }

    pub fn existing(
        pattern: impl Into<String>,
        category: ArtifactCategory,
        required_exceptions: RequiredExceptionResult,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        Self::new(
            pattern,
            IgnorePatternOrigin::ExistingIgnoreFileEntry,
            category,
            required_exceptions,
            evidence,
        )
    }

    pub fn proposed(
        pattern: impl Into<String>,
        category: ArtifactCategory,
        required_exceptions: RequiredExceptionResult,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        Self::new(
            pattern,
            IgnorePatternOrigin::ProposedNewEntry,
            category,
            required_exceptions,
            evidence,
        )
    }

    pub fn validate(&self) -> Result<(), FoundationError> {
        validate_pattern_text(self.pattern.as_str())?;
        if self.evidence.is_empty() {
            return Err(FoundationError::invalid(
                "ignore_pattern_evidence",
                "an ignore pattern needs evidence",
            ));
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for IgnorePatternRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            pattern: ExactText,
            origin: IgnorePatternOrigin,
            category: ArtifactCategory,
            required_exceptions: RequiredExceptionResult,
            evidence: Vec<EvidenceReference>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(
            wire.pattern.into_inner(),
            wire.origin,
            wire.category,
            wire.required_exceptions,
            wire.evidence,
        )
        .map_err(de::Error::custom)
    }
}

/// An exact pattern record. `match_count` and `examples` are produced from the
/// current path set, never guessed from an extension or from the pattern text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IgnorePatternProposal {
    pub pattern: ExactText,
    pub origin: IgnorePatternOrigin,
    pub category: ArtifactCategory,
    pub match_count: usize,
    pub examples: Vec<RepoRelativePath>,
    pub required_exceptions: RequiredExceptionResult,
    pub evidence: Vec<EvidenceReference>,
}

impl IgnorePatternProposal {
    pub fn new(
        pattern: impl Into<String>,
        origin: IgnorePatternOrigin,
        category: ArtifactCategory,
        match_count: usize,
        examples: Vec<RepoRelativePath>,
        required_exceptions: RequiredExceptionResult,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        let pattern = pattern.into();
        validate_pattern_text(&pattern)?;
        let mut examples = examples;
        examples.sort();
        examples.dedup();
        if match_count == 0 {
            if !examples.is_empty() {
                return Err(FoundationError::invalid(
                    "ignore_examples",
                    "zero matches require zero examples",
                ));
            }
        } else if examples.is_empty() || examples.len() > 5 {
            return Err(FoundationError::invalid(
                "ignore_examples",
                "a non-empty match set requires between one and five examples",
            ));
        }
        let evidence = normalize_evidence(evidence);
        if evidence.is_empty() {
            return Err(FoundationError::invalid(
                "ignore_pattern_evidence",
                "an ignore pattern needs evidence",
            ));
        }
        Ok(Self {
            pattern: ExactText::new(pattern),
            origin,
            category,
            match_count,
            examples,
            required_exceptions,
            evidence,
        })
    }

    pub fn is_existing(&self) -> bool {
        self.origin == IgnorePatternOrigin::ExistingIgnoreFileEntry
    }

    pub fn is_proposed(&self) -> bool {
        self.origin == IgnorePatternOrigin::ProposedNewEntry
    }
}

impl<'de> Deserialize<'de> for IgnorePatternProposal {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            pattern: ExactText,
            origin: IgnorePatternOrigin,
            category: ArtifactCategory,
            match_count: usize,
            examples: Vec<RepoRelativePath>,
            required_exceptions: RequiredExceptionResult,
            evidence: Vec<EvidenceReference>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(
            wire.pattern.into_inner(),
            wire.origin,
            wire.category,
            wire.match_count,
            wire.examples,
            wire.required_exceptions,
            wire.evidence,
        )
        .map_err(de::Error::custom)
    }
}

/// Read `.gitignore` without following a symlink or changing the repository.
/// Missing/empty input is `Empty`; read, type, or UTF-8 failures are explicitly
/// `Unavailable` so no dependent proposal is fabricated.
pub fn read_ignore_file(
    repository_root: impl AsRef<Path>,
) -> Result<IgnoreFileSnapshot, FoundationError> {
    let root = repository_root.as_ref();
    if !root.is_absolute() {
        return Err(FoundationError::boundary(
            "the ignore-file repository root must be absolute",
        ));
    }
    let root_metadata = fs::symlink_metadata(root).map_err(|source| FoundationError::Io {
        operation: "inspect ignore-file repository root",
        source,
    })?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(FoundationError::boundary(
            "the ignore-file repository root must be a non-symlink directory",
        ));
    }
    let path = root.join(".gitignore");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(IgnoreFileSnapshot::empty())
        }
        Err(_) => return Ok(IgnoreFileSnapshot::unavailable()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(IgnoreFileSnapshot::unavailable());
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(IgnoreFileSnapshot::unavailable()),
    };
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => return Ok(IgnoreFileSnapshot::unavailable()),
    };
    let mut entries = Vec::new();
    for (index, raw_line) in text.split('\n').enumerate() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let line_number = u32::try_from(index + 1).map_err(|_| {
            FoundationError::invalid("ignore_file_line", "ignore file has too many lines")
        })?;
        let evidence = ignore_file_evidence(line_number)?;
        let entry = match IgnoreFileEntry::new(line.to_owned(), line_number, evidence) {
            Ok(entry) => entry,
            Err(_) => return Ok(IgnoreFileSnapshot::unavailable()),
        };
        entries.push(entry);
    }
    IgnoreFileSnapshot::available(entries)
}

/// Compatibility names for the read-only collector.
pub fn collect_ignore_file_snapshot(
    repository_root: impl AsRef<Path>,
) -> Result<IgnoreFileSnapshot, FoundationError> {
    read_ignore_file(repository_root)
}

fn ignore_pattern_syntax_supported(pattern: &str) -> bool {
    if pattern.is_empty()
        || pattern.starts_with('#')
        || pattern.starts_with('!')
        || pattern.contains(['[', ']', '\\'])
        || pattern.starts_with('\\')
        || pattern.ends_with(' ')
    {
        return false;
    }
    let pattern = pattern.strip_suffix('/').unwrap_or(pattern);
    let pattern = pattern.strip_prefix('/').unwrap_or(pattern);
    if pattern.is_empty() || pattern.split('/').any(|part| part.is_empty()) {
        return false;
    }
    !pattern
        .split('/')
        .any(|part| part.contains("**") && part != "**")
}

pub fn read_gitignore(
    repository_root: impl AsRef<Path>,
) -> Result<IgnoreFileSnapshot, FoundationError> {
    read_ignore_file(repository_root)
}

/// Conservative matching for common root `.gitignore` patterns. `None` means
/// the pattern uses syntax this small matcher intentionally does not claim to
/// understand. Callers should preserve that uncertainty rather than turn it
/// into a match.
pub fn conservative_gitignore_match(pattern: &str, path: &RepoRelativePath) -> Option<bool> {
    if !ignore_pattern_syntax_supported(pattern) {
        return None;
    }
    let mut pattern = pattern;
    let directory = pattern.ends_with('/');
    if directory {
        pattern = &pattern[..pattern.len() - 1];
    }
    let anchored = pattern.starts_with('/');
    if anchored {
        pattern = &pattern[1..];
    }
    let path_parts = path.as_str().split('/').collect::<Vec<_>>();
    let pattern_parts = pattern.split('/').collect::<Vec<_>>();
    if pattern_parts.len() == 1 && !anchored {
        let matches = path_parts
            .iter()
            .any(|part| segment_matches(pattern_parts[0], part));
        return Some(matches);
    }
    if directory {
        if pattern_parts.len() > path_parts.len() {
            return Some(false);
        }
        return Some(glob_path_matches(
            &pattern_parts,
            &path_parts[..pattern_parts.len()],
        ));
    }
    Some(glob_path_matches(&pattern_parts, &path_parts))
}

/// Boolean convenience that treats unsupported syntax as a non-claim.
pub fn gitignore_pattern_matches(pattern: &str, path: &RepoRelativePath) -> bool {
    conservative_gitignore_match(pattern, path) == Some(true)
}

pub fn matches_gitignore_pattern(pattern: &str, path: &RepoRelativePath) -> bool {
    gitignore_pattern_matches(pattern, path)
}

/// Build one proposal while retaining unavailable filesystem input.
pub fn build_ignore_pattern_proposal<R>(
    request: R,
    current_paths: &Availability<BTreeSet<RepoRelativePath>>,
) -> Result<Availability<IgnorePatternProposal>, FoundationError>
where
    R: Borrow<IgnorePatternRequest>,
{
    let request = request.borrow();
    request.validate()?;
    if !ignore_pattern_syntax_supported(request.pattern.as_str()) {
        return Ok(Availability::Unavailable);
    }
    match current_paths {
        Availability::Unavailable => Ok(Availability::Unavailable),
        Availability::Empty => Ok(Availability::Present(IgnorePatternProposal::new(
            request.pattern.as_str(),
            request.origin,
            request.category.clone(),
            0,
            Vec::new(),
            request.required_exceptions.clone(),
            request.evidence.clone(),
        )?)),
        Availability::Present(paths) => {
            let Some((match_count, examples)) = matching_paths(request.pattern.as_str(), paths)
            else {
                return Ok(Availability::Unavailable);
            };
            Ok(Availability::Present(IgnorePatternProposal::new(
                request.pattern.as_str(),
                request.origin,
                request.category.clone(),
                match_count,
                examples,
                request.required_exceptions.clone(),
                request.evidence.clone(),
            )?))
        }
    }
}

/// Build a deterministic vector of proposals. The entire result is unavailable
/// when the current path source is unavailable; no partial counts are emitted.
pub fn build_ignore_proposals<I, R>(
    requests: I,
    current_paths: &Availability<BTreeSet<RepoRelativePath>>,
) -> Result<Availability<Vec<IgnorePatternProposal>>, FoundationError>
where
    I: IntoIterator<Item = R>,
    R: Borrow<IgnorePatternRequest>,
{
    let requests = requests.into_iter().collect::<Vec<_>>();
    for request in &requests {
        request.borrow().validate()?;
        if !ignore_pattern_syntax_supported(request.borrow().pattern.as_str()) {
            return Ok(Availability::Unavailable);
        }
    }
    match current_paths {
        Availability::Unavailable => Ok(Availability::Unavailable),
        Availability::Empty => {
            let mut proposals = Vec::new();
            for request in requests {
                let request = request.borrow();
                proposals.push(IgnorePatternProposal::new(
                    request.pattern.as_str(),
                    request.origin,
                    request.category.clone(),
                    0,
                    Vec::new(),
                    request.required_exceptions.clone(),
                    request.evidence.clone(),
                )?);
            }
            proposals.sort_by(|left, right| {
                left.pattern
                    .cmp(&right.pattern)
                    .then_with(|| left.origin.cmp(&right.origin))
                    .then_with(|| left.category.cmp(&right.category))
            });
            Ok(Availability::Present(proposals))
        }
        Availability::Present(_) => {
            let mut proposals = Vec::new();
            for request in requests {
                match build_ignore_pattern_proposal(request, current_paths)? {
                    Availability::Present(proposal) => proposals.push(proposal),
                    Availability::Empty => {}
                    Availability::Unavailable => return Ok(Availability::Unavailable),
                }
            }
            proposals.sort_by(|left, right| {
                left.pattern
                    .cmp(&right.pattern)
                    .then_with(|| left.origin.cmp(&right.origin))
                    .then_with(|| left.category.cmp(&right.category))
            });
            Ok(Availability::Present(proposals))
        }
    }
}

/// Turn every existing entry into a record with one caller-supplied category.
/// Callers that need per-pattern categories should use the map variant below;
/// neither helper invents a category from an extension.
pub fn build_existing_ignore_proposals(
    snapshot: &IgnoreFileSnapshot,
    category: ArtifactCategory,
    current_paths: &Availability<BTreeSet<RepoRelativePath>>,
) -> Result<Availability<Vec<IgnorePatternProposal>>, FoundationError> {
    if current_paths.is_unavailable() {
        return Ok(Availability::Unavailable);
    }
    let entries = match &snapshot.patterns {
        Availability::Empty => return Ok(Availability::Present(Vec::new())),
        Availability::Unavailable => return Ok(Availability::Unavailable),
        Availability::Present(entries) => entries,
    };
    let mut requests = Vec::new();
    for entry in entries {
        requests.push(IgnorePatternRequest::existing(
            entry.pattern.as_str(),
            category.clone(),
            RequiredExceptionResult::none(),
            vec![entry.evidence.clone()],
        )?);
    }
    build_ignore_proposals(requests, current_paths)
}

pub fn build_existing_ignore_proposals_with_categories(
    snapshot: &IgnoreFileSnapshot,
    categories: &BTreeMap<ExactText, ArtifactCategory>,
    current_paths: &Availability<BTreeSet<RepoRelativePath>>,
) -> Result<Availability<Vec<IgnorePatternProposal>>, FoundationError> {
    if current_paths.is_unavailable() {
        return Ok(Availability::Unavailable);
    }
    let entries = match &snapshot.patterns {
        Availability::Empty => return Ok(Availability::Present(Vec::new())),
        Availability::Unavailable => return Ok(Availability::Unavailable),
        Availability::Present(entries) => entries,
    };
    let mut requests = Vec::new();
    for entry in entries {
        let category = categories.get(&entry.pattern).ok_or_else(|| {
            FoundationError::invalid(
                "ignore_pattern_category",
                format!(
                    "no category supplied for existing pattern `{}`",
                    entry.pattern
                ),
            )
        })?;
        requests.push(IgnorePatternRequest::existing(
            entry.pattern.as_str(),
            category.clone(),
            RequiredExceptionResult::none(),
            vec![entry.evidence.clone()],
        )?);
    }
    build_ignore_proposals(requests, current_paths)
}

pub fn build_proposed_ignore_proposals<I, R>(
    requests: I,
    current_paths: &Availability<BTreeSet<RepoRelativePath>>,
) -> Result<Availability<Vec<IgnorePatternProposal>>, FoundationError>
where
    I: IntoIterator<Item = R>,
    R: Borrow<IgnorePatternRequest>,
{
    build_ignore_proposals(requests, current_paths)
}

/// A separate follow-up recommendation for a tracked path that is already
/// matched by an existing ignore entry. It never changes the retention fields.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum UntrackingRecommendation {
    UntrackFromRepository,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UntrackingFollowUp {
    pub path: RepoRelativePath,
    pub pattern: ExactText,
    pub recommendation: UntrackingRecommendation,
    pub evidence: Vec<EvidenceReference>,
}

impl UntrackingFollowUp {
    pub fn new(
        path: RepoRelativePath,
        pattern: impl Into<String>,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        let pattern = pattern.into();
        validate_pattern_text(&pattern)?;
        let evidence = normalize_evidence(evidence);
        if evidence.is_empty() {
            return Err(FoundationError::invalid(
                "untracking_evidence",
                "an untracking follow-up needs evidence",
            ));
        }
        Ok(Self {
            path,
            pattern: ExactText::new(pattern),
            recommendation: UntrackingRecommendation::UntrackFromRepository,
            evidence,
        })
    }
}

impl<'de> Deserialize<'de> for UntrackingFollowUp {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            path: RepoRelativePath,
            pattern: ExactText,
            recommendation: UntrackingRecommendation,
            evidence: Vec<EvidenceReference>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.recommendation != UntrackingRecommendation::UntrackFromRepository {
            return Err(de::Error::custom("unknown untracking recommendation"));
        }
        Self::new(wire.path, wire.pattern.into_inner(), wire.evidence).map_err(de::Error::custom)
    }
}

/// Build only the distinct existing-ignore untracking follow-ups. An
/// unavailable ignore file or filesystem withholds all dependent records.
pub fn build_untracking_follow_ups(
    candidates: &BTreeMap<RepoRelativePath, ArtifactCandidate>,
    snapshot: &IgnoreFileSnapshot,
    filesystem_paths: &Availability<BTreeSet<RepoRelativePath>>,
) -> Availability<BTreeMap<RepoRelativePath, UntrackingFollowUp>> {
    if filesystem_paths.is_unavailable() {
        return Availability::Unavailable;
    }
    let entries = match &snapshot.patterns {
        Availability::Empty => return Availability::Present(BTreeMap::new()),
        Availability::Unavailable => return Availability::Unavailable,
        Availability::Present(entries) => entries,
    };
    let paths = match filesystem_paths {
        Availability::Empty => return Availability::Present(BTreeMap::new()),
        Availability::Unavailable => return Availability::Unavailable,
        Availability::Present(paths) => paths,
    };
    let mut follow_ups = BTreeMap::new();
    for (path, candidate) in candidates {
        if candidate.tracked != ArtifactStatus::Yes
            || candidate.filesystem != ArtifactStatus::Yes
            || !paths.contains(path)
        {
            continue;
        }
        let Some(entry) = entries
            .iter()
            .find(|entry| conservative_gitignore_match(entry.pattern.as_str(), path) == Some(true))
        else {
            continue;
        };
        let mut evidence = vec![
            entry.evidence.clone(),
            candidate.classification_evidence.clone(),
        ];
        evidence.extend(candidate.purpose.evidence.iter().cloned());
        if let Ok(follow_up) =
            UntrackingFollowUp::new(path.clone(), entry.pattern.as_str(), evidence)
        {
            follow_ups.insert(path.clone(), follow_up);
        }
    }
    Availability::Present(follow_ups)
}

/// Inventory convenience that derives the filesystem availability from the
/// candidate statuses without guessing an unavailable source.
pub fn build_untracking_follow_ups_from_inventory(
    inventory: &crate::artifacts::ArtifactInventory,
    snapshot: &IgnoreFileSnapshot,
) -> Availability<BTreeMap<RepoRelativePath, UntrackingFollowUp>> {
    let mut paths = BTreeSet::new();
    for candidate in inventory.candidates.values() {
        if candidate.filesystem == ArtifactStatus::Unverified {
            return Availability::Unavailable;
        }
        if candidate.filesystem == ArtifactStatus::Yes {
            paths.insert(candidate.path.clone());
        }
    }
    let filesystem = if inventory.candidates.is_empty() {
        Availability::Empty
    } else if paths.is_empty() {
        Availability::Present(BTreeSet::new())
    } else {
        Availability::Present(paths)
    };
    build_untracking_follow_ups(&inventory.candidates, snapshot, &filesystem)
}

/// Apply the same follow-up rule to already-built proposal records, retaining
/// only ExistingIgnoreFileEntry provenance.
pub fn build_untracking_follow_ups_from_proposals(
    candidates: &BTreeMap<RepoRelativePath, ArtifactCandidate>,
    proposals: &Availability<Vec<IgnorePatternProposal>>,
    filesystem_paths: &Availability<BTreeSet<RepoRelativePath>>,
) -> Availability<BTreeMap<RepoRelativePath, UntrackingFollowUp>> {
    if filesystem_paths.is_unavailable() {
        return Availability::Unavailable;
    }
    let proposals = match proposals {
        Availability::Empty => return Availability::Present(BTreeMap::new()),
        Availability::Unavailable => return Availability::Unavailable,
        Availability::Present(proposals) => proposals,
    };
    let paths = match filesystem_paths {
        Availability::Empty => return Availability::Present(BTreeMap::new()),
        Availability::Unavailable => return Availability::Unavailable,
        Availability::Present(paths) => paths,
    };
    let mut follow_ups = BTreeMap::new();
    for (path, candidate) in candidates {
        if candidate.tracked != ArtifactStatus::Yes
            || candidate.filesystem != ArtifactStatus::Yes
            || !paths.contains(path)
        {
            continue;
        }
        let Some(proposal) = proposals.iter().find(|proposal| {
            proposal.is_existing()
                && conservative_gitignore_match(proposal.pattern.as_str(), path) == Some(true)
        }) else {
            continue;
        };
        let mut evidence = proposal.evidence.clone();
        evidence.push(candidate.classification_evidence.clone());
        if let Ok(follow_up) =
            UntrackingFollowUp::new(path.clone(), proposal.pattern.as_str(), evidence)
        {
            follow_ups.insert(path.clone(), follow_up);
        }
    }
    Availability::Present(follow_ups)
}

fn validate_pattern_text(pattern: &str) -> Result<(), FoundationError> {
    let length = pattern.chars().count();
    if length == 0 || length > 500 {
        return Err(FoundationError::invalid(
            "ignore_pattern",
            "pattern text must contain between one and 500 characters",
        ));
    }
    if pattern.contains('\0') {
        return Err(FoundationError::invalid(
            "ignore_pattern",
            "NUL is not allowed",
        ));
    }
    Ok(())
}

fn normalize_evidence(mut evidence: Vec<EvidenceReference>) -> Vec<EvidenceReference> {
    evidence.sort();
    evidence.dedup();
    evidence
}

fn ignore_file_evidence(line: u32) -> Result<EvidenceReference, FoundationError> {
    let path = RepoRelativePath::new(".gitignore")?;
    let span = InclusiveSpan::new(line, line)?;
    let source = EvidenceSourceIdentity::new(EvidenceSourceKind::Worktree, ".gitignore")?;
    Ok(EvidenceReference::new(
        source,
        EvidenceReferenceLocator::file(path, span),
    ))
}

fn matching_paths(
    pattern: &str,
    paths: &BTreeSet<RepoRelativePath>,
) -> Option<(usize, Vec<RepoRelativePath>)> {
    let mut matches = Vec::new();
    for path in paths {
        match conservative_gitignore_match(pattern, path) {
            Some(true) => matches.push(path.clone()),
            Some(false) => {}
            None => return None,
        }
    }
    let count = matches.len();
    Some((count, matches.into_iter().take(5).collect()))
}

fn segment_matches(pattern: &str, value: &str) -> bool {
    fn inner(pattern: &[char], value: &[char]) -> bool {
        if pattern.is_empty() {
            return value.is_empty();
        }
        if pattern[0] == '*' {
            return inner(&pattern[1..], value)
                || (!value.is_empty() && inner(pattern, &value[1..]));
        }
        !value.is_empty()
            && (pattern[0] == '?' || pattern[0] == value[0])
            && inner(&pattern[1..], &value[1..])
    }
    inner(
        &pattern.chars().collect::<Vec<_>>(),
        &value.chars().collect::<Vec<_>>(),
    )
}

fn glob_path_matches(pattern: &[&str], path: &[&str]) -> bool {
    fn inner(pattern: &[&str], path: &[&str]) -> bool {
        if pattern.is_empty() {
            return path.is_empty();
        }
        if pattern[0] == "**" {
            return inner(&pattern[1..], path) || (!path.is_empty() && inner(pattern, &path[1..]));
        }
        !path.is_empty() && segment_matches(pattern[0], path[0]) && inner(&pattern[1..], &path[1..])
    }
    inner(pattern, path)
}
