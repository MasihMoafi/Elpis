//! Typed release-evidence observations and injected remote evidence.
//!
//! This module contains only data contracts and the in-memory remote injection
//! seam.  It deliberately does not perform network access.  Local collection is
//! implemented by [`crate::git::LocalReleaseEvidenceCollector`].

use crate::{
    Availability, EvidenceLocator, ExactText, FoundationError, FullId, InclusiveSpan,
    RepoRelativePath,
};
use serde::{Deserialize, Serialize};

/// The kind of source from which an observation was obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum EvidenceSourceKind {
    LocalGit,
    Worktree,
    ReleaseDocument,
    PackageManifest,
    RemoteSnapshot,
    RemoteReference,
}

/// Compatibility name for callers that refer to source kinds as sources.
pub type EvidenceSource = EvidenceSourceKind;

/// A stable identity for one evidence source.
///
/// `name` is deliberately retained separately from the source kind.  For
/// example, two release documents have the same kind but distinct path names,
/// and two injected remote snapshots may be supplied by different systems.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct EvidenceSourceIdentity {
    pub kind: EvidenceSourceKind,
    pub name: ExactText,
}

impl EvidenceSourceIdentity {
    pub fn new(kind: EvidenceSourceKind, name: impl Into<String>) -> Result<Self, FoundationError> {
        let name = name.into();
        if name.is_empty() || name.contains('\0') {
            return Err(FoundationError::invalid(
                "evidence_source",
                "source names must be non-empty and may not contain NUL",
            ));
        }
        Ok(Self {
            kind,
            name: ExactText::new(name),
        })
    }

    pub fn local_git(name: impl Into<String>) -> Result<Self, FoundationError> {
        Self::new(EvidenceSourceKind::LocalGit, name)
    }

    pub fn worktree(name: impl Into<String>) -> Result<Self, FoundationError> {
        Self::new(EvidenceSourceKind::Worktree, name)
    }

    pub fn release_document(name: impl Into<String>) -> Result<Self, FoundationError> {
        Self::new(EvidenceSourceKind::ReleaseDocument, name)
    }

    pub fn package_manifest(name: impl Into<String>) -> Result<Self, FoundationError> {
        Self::new(EvidenceSourceKind::PackageManifest, name)
    }

    pub fn remote_snapshot(name: impl Into<String>) -> Result<Self, FoundationError> {
        Self::new(EvidenceSourceKind::RemoteSnapshot, name)
    }

    pub fn remote_reference(name: impl Into<String>) -> Result<Self, FoundationError> {
        Self::new(EvidenceSourceKind::RemoteReference, name)
    }
}

/// Compatibility name for the source identity contract.
pub type SourceIdentity = EvidenceSourceIdentity;

/// A locator that can identify both filesystem text and non-file observations.
///
/// File observations use the foundation [`EvidenceLocator`] so their path and
/// one-based inclusive line span remain the same contract used by existing
/// report citations.  Git, worktree, and injected remote observations use
/// typed keys instead of pretending that a generated path is a source file.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum EvidenceReferenceLocator {
    File(EvidenceLocator),
    GitRef(ExactText),
    WorktreePath(RepoRelativePath),
    RemoteSnapshot(ExactText),
    RemoteReference(ExactText),
}

impl EvidenceReferenceLocator {
    pub fn file(path: RepoRelativePath, span: InclusiveSpan) -> Self {
        Self::File(EvidenceLocator::new(path, span))
    }

    pub fn git_ref(reference: impl Into<String>) -> Self {
        Self::GitRef(ExactText::new(reference))
    }

    pub fn worktree_path(path: RepoRelativePath) -> Self {
        Self::WorktreePath(path)
    }

    pub fn remote_snapshot(snapshot: impl Into<String>) -> Self {
        Self::RemoteSnapshot(ExactText::new(snapshot))
    }

    pub fn remote_reference(reference: impl Into<String>) -> Self {
        Self::RemoteReference(ExactText::new(reference))
    }
}

impl From<EvidenceLocator> for EvidenceReferenceLocator {
    fn from(locator: EvidenceLocator) -> Self {
        Self::File(locator)
    }
}

/// A typed, serializable pointer to the exact source of one observation.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EvidenceReference {
    pub source: EvidenceSourceIdentity,
    pub locator: EvidenceReferenceLocator,
}

impl EvidenceReference {
    pub fn new<L>(source: EvidenceSourceIdentity, locator: L) -> Self
    where
        L: Into<EvidenceReferenceLocator>,
    {
        Self {
            source,
            locator: locator.into(),
        }
    }

    pub fn file(
        source: EvidenceSourceIdentity,
        path: RepoRelativePath,
        span: InclusiveSpan,
    ) -> Self {
        Self::new(source, EvidenceReferenceLocator::file(path, span))
    }
}

/// A named source failure.  A gap is evidence that a source was unavailable or
/// malformed; it is never silently converted into an empty observation list.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct UnavailableSourceGap {
    pub source: EvidenceSourceIdentity,
    pub reason: ExactText,
}

impl UnavailableSourceGap {
    pub fn new(source: EvidenceSourceIdentity, reason: impl Into<String>) -> Self {
        Self {
            source,
            reason: ExactText::new(reason),
        }
    }

    pub fn source_name(&self) -> &ExactText {
        &self.source.name
    }
}

/// Compatibility names for callers that use a shorter gap term.
pub type SourceGap = UnavailableSourceGap;
pub type EvidenceGap = UnavailableSourceGap;

/// One local ref/tag observation.  The ref name is retained even if resolving
/// its commit or metadata failed, while the failed value is explicitly marked
/// unavailable and accompanied by a named gap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalRefObservation {
    pub reference: EvidenceReference,
    pub full_ref: ExactText,
    pub resolved_commit: Availability<FullId>,
    pub date: Availability<ExactText>,
    pub subject: Availability<ExactText>,
}

impl LocalRefObservation {
    pub fn try_new(
        full_ref: impl Into<String>,
        resolved_commit: Availability<FullId>,
        date: Availability<ExactText>,
        subject: Availability<ExactText>,
    ) -> Result<Self, FoundationError> {
        let full_ref = full_ref.into();
        if full_ref.is_empty() || full_ref.contains('\0') {
            return Err(FoundationError::invalid(
                "local_ref",
                "full ref names must be non-empty and may not contain NUL",
            ));
        }
        let source = EvidenceSourceIdentity::local_git("local-refs")?;
        let reference =
            EvidenceReference::new(source, EvidenceReferenceLocator::git_ref(full_ref.clone()));
        Ok(Self {
            reference,
            full_ref: ExactText::new(full_ref),
            resolved_commit,
            date,
            subject,
        })
    }
}

/// Compatibility names for ref observations.
pub type LocalRef = LocalRefObservation;
pub type GitRefObservation = LocalRefObservation;

/// The four independent worktree inventories requested by the release audit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum WorktreeInventoryKind {
    Staged,
    Unstaged,
    Untracked,
    Ignored,
}

impl WorktreeInventoryKind {
    pub const ALL: [Self; 4] = [Self::Staged, Self::Unstaged, Self::Untracked, Self::Ignored];

    pub const fn name(self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::Unstaged => "unstaged",
            Self::Untracked => "untracked",
            Self::Ignored => "ignored",
        }
    }
}

/// One path in one independent worktree inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreePathObservation {
    pub reference: EvidenceReference,
    pub path: RepoRelativePath,
    /// Git's exact short status token when the inventory came from a diff;
    /// untracked and ignored paths carry their category token.
    pub status: ExactText,
}

impl WorktreePathObservation {
    pub fn new(
        kind: WorktreeInventoryKind,
        path: RepoRelativePath,
        status: impl Into<String>,
    ) -> Self {
        let name = kind.name().to_owned();
        let reference = EvidenceReference::new(
            EvidenceSourceIdentity {
                kind: EvidenceSourceKind::Worktree,
                name: ExactText::new(name),
            },
            EvidenceReferenceLocator::worktree_path(path.clone()),
        );
        Self {
            reference,
            path,
            status: ExactText::new(status),
        }
    }
}

/// Independent availability for staged, unstaged, untracked, and ignored paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeInventories {
    pub staged: Availability<Vec<WorktreePathObservation>>,
    pub unstaged: Availability<Vec<WorktreePathObservation>>,
    pub untracked: Availability<Vec<WorktreePathObservation>>,
    pub ignored: Availability<Vec<WorktreePathObservation>>,
}

impl WorktreeInventories {
    pub fn empty() -> Self {
        Self {
            staged: Availability::Empty,
            unstaged: Availability::Empty,
            untracked: Availability::Empty,
            ignored: Availability::Empty,
        }
    }

    /// Derive the clean FACT only from inspected staged, unstaged, and
    /// untracked inventories. Ignored paths are intentionally excluded: an
    /// ignored-only file does not make a worktree dirty.
    pub fn clean_fact(&self) -> Availability<bool> {
        let relevant = [&self.staged, &self.unstaged, &self.untracked];
        if relevant
            .iter()
            .any(|inventory| matches!(inventory, Availability::Unavailable))
        {
            return Availability::Unavailable;
        }
        let clean = relevant.iter().all(|inventory| match inventory {
            Availability::Empty => true,
            Availability::Present(entries) => entries.is_empty(),
            Availability::Unavailable => false,
        });
        Availability::Present(clean)
    }

    /// Boolean convenience for callers that only need the positive clean FACT.
    /// An unavailable inventory is not treated as clean.
    pub fn is_clean(&self) -> bool {
        matches!(self.clean_fact(), Availability::Present(true))
    }

    /// Compatibility spelling for the explicit tri-state clean fact.
    pub fn clean(&self) -> Availability<bool> {
        self.clean_fact()
    }
}

/// One exact declaration line in a release document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseDocumentDeclaration {
    pub reference: EvidenceReference,
    pub path: RepoRelativePath,
    pub span: InclusiveSpan,
    pub version: ExactText,
    pub text: ExactText,
}

impl ReleaseDocumentDeclaration {
    pub fn try_new(
        path: RepoRelativePath,
        span: InclusiveSpan,
        version: impl Into<String>,
        text: impl Into<String>,
    ) -> Result<Self, FoundationError> {
        let source = EvidenceSourceIdentity::release_document(path.as_str())?;
        let reference = EvidenceReference::file(source, path.clone(), span);
        Ok(Self {
            reference,
            path,
            span,
            version: ExactText::new(version),
            text: ExactText::new(text),
        })
    }
}

/// One exact declaration line in a package manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageManifestVersionDeclaration {
    pub reference: EvidenceReference,
    pub path: RepoRelativePath,
    pub span: InclusiveSpan,
    pub version: ExactText,
    pub text: ExactText,
}

impl PackageManifestVersionDeclaration {
    pub fn try_new(
        path: RepoRelativePath,
        span: InclusiveSpan,
        version: impl Into<String>,
        text: impl Into<String>,
    ) -> Result<Self, FoundationError> {
        let source = EvidenceSourceIdentity::package_manifest(path.as_str())?;
        let reference = EvidenceReference::file(source, path.clone(), span);
        Ok(Self {
            reference,
            path,
            span,
            version: ExactText::new(version),
            text: ExactText::new(text),
        })
    }
}

/// Compatibility names for manifest version declarations.
pub type ManifestVersionDeclaration = PackageManifestVersionDeclaration;
pub type PackageVersionDeclaration = PackageManifestVersionDeclaration;

/// One explicitly injected remote ref observation.  This type does not imply
/// that the ref was fetched or checked; it only preserves what a caller gave us.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteReferenceObservation {
    pub reference: EvidenceReference,
    pub full_ref: ExactText,
    pub resolved_commit: Availability<FullId>,
    pub date: Availability<ExactText>,
    pub subject: Availability<ExactText>,
}

impl RemoteReferenceObservation {
    pub fn try_new(
        full_ref: impl Into<String>,
        resolved_commit: Availability<FullId>,
        date: Availability<ExactText>,
        subject: Availability<ExactText>,
    ) -> Result<Self, FoundationError> {
        let full_ref = full_ref.into();
        if full_ref.is_empty() || full_ref.contains('\0') {
            return Err(FoundationError::invalid(
                "remote_ref",
                "full ref names must be non-empty and may not contain NUL",
            ));
        }
        let source = EvidenceSourceIdentity::remote_reference(full_ref.clone())?;
        let reference = EvidenceReference::new(
            source,
            EvidenceReferenceLocator::remote_reference(full_ref.clone()),
        );
        Ok(Self {
            reference,
            full_ref: ExactText::new(full_ref),
            resolved_commit,
            date,
            subject,
        })
    }
}

/// An injected remote snapshot and its explicitly supplied references.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteSnapshot {
    pub source: EvidenceSourceIdentity,
    pub snapshot: ExactText,
    pub snapshot_reference: EvidenceReference,
    pub references: Availability<Vec<RemoteReferenceObservation>>,
    pub gaps: Vec<UnavailableSourceGap>,
}

impl RemoteSnapshot {
    pub fn new(snapshot: impl Into<String>, references: Vec<RemoteReferenceObservation>) -> Self {
        let snapshot = snapshot.into();
        let source = EvidenceSourceIdentity {
            kind: EvidenceSourceKind::RemoteSnapshot,
            name: ExactText::new("injected"),
        };
        let snapshot_reference = EvidenceReference::new(
            source.clone(),
            EvidenceReferenceLocator::remote_snapshot("injected"),
        );
        let references = if references.is_empty() {
            Availability::Empty
        } else {
            let mut references = references;
            references.sort_by(|left, right| left.full_ref.cmp(&right.full_ref));
            Availability::Present(references)
        };
        Self {
            source,
            snapshot: ExactText::new(snapshot),
            snapshot_reference,
            references,
            gaps: Vec::new(),
        }
    }

    pub fn unavailable(snapshot: impl Into<String>, reason: impl Into<String>) -> Self {
        let mut value = Self::new(snapshot, Vec::new());
        value.references = Availability::Unavailable;
        value
            .gaps
            .push(UnavailableSourceGap::new(value.source.clone(), reason));
        value
    }
}

/// A read-only remote collector whose input is supplied by the caller.  It
/// never contacts a network, executes Git, or mutates a repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteSnapshotCollector {
    snapshot: RemoteSnapshot,
}

impl RemoteSnapshotCollector {
    pub fn new(snapshot: impl Into<String>, references: Vec<RemoteReferenceObservation>) -> Self {
        Self {
            snapshot: RemoteSnapshot::new(snapshot, references),
        }
    }

    pub fn from_snapshot(snapshot: RemoteSnapshot) -> Self {
        Self { snapshot }
    }

    pub fn collect(&self) -> RemoteSnapshot {
        self.snapshot.clone()
    }

    pub fn snapshot(&self) -> &RemoteSnapshot {
        &self.snapshot
    }
}

/// The injection seam used by the local collector.  Implementations are
/// expected to return already-observed data, not perform network access here.
pub trait RemoteEvidenceCollector {
    fn collect_remote(&self) -> RemoteSnapshot;
}

impl RemoteEvidenceCollector for RemoteSnapshotCollector {
    fn collect_remote(&self) -> RemoteSnapshot {
        self.collect()
    }
}

/// Compatibility names for the explicit injection collector.
pub type InjectedRemoteCollector = RemoteSnapshotCollector;
pub type InjectedRemoteEvidenceCollector = RemoteSnapshotCollector;
pub type RemoteReferenceCollector = RemoteSnapshotCollector;

/// All local release evidence, with an optional explicitly injected remote
/// snapshot.  Every source is independently tri-state and gaps are named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalReleaseEvidence {
    pub refs: Availability<Vec<LocalRefObservation>>,
    pub worktree: WorktreeInventories,
    pub release_documents: Availability<Vec<ReleaseDocumentDeclaration>>,
    pub package_manifests: Availability<Vec<PackageManifestVersionDeclaration>>,
    pub remote: Availability<RemoteSnapshot>,
    pub gaps: Vec<UnavailableSourceGap>,
}

impl LocalReleaseEvidence {
    pub fn without_remote(
        refs: Availability<Vec<LocalRefObservation>>,
        worktree: WorktreeInventories,
        release_documents: Availability<Vec<ReleaseDocumentDeclaration>>,
        package_manifests: Availability<Vec<PackageManifestVersionDeclaration>>,
        mut gaps: Vec<UnavailableSourceGap>,
    ) -> Self {
        gaps.sort();
        Self {
            refs,
            worktree,
            release_documents,
            package_manifests,
            remote: Availability::Empty,
            gaps,
        }
    }

    pub fn attach_remote<C: RemoteEvidenceCollector>(mut self, collector: &C) -> Self {
        let remote = collector.collect_remote();
        self.gaps.extend(remote.gaps.iter().cloned());
        self.gaps.sort();
        self.remote = Availability::Present(remote);
        self
    }

    pub fn has_gaps(&self) -> bool {
        !self.gaps.is_empty()
    }

    pub fn clean_fact(&self) -> Availability<bool> {
        self.worktree.clean_fact()
    }

    pub fn is_clean(&self) -> bool {
        self.worktree.is_clean()
    }
}

/// Compatibility names for the aggregate collector result.
pub type ReleaseEvidence = LocalReleaseEvidence;
pub type CollectedReleaseEvidence = LocalReleaseEvidence;
