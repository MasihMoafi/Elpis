//! Release-candidate normalization and fail-closed baseline selection.
//!
//! This module deliberately treats every release observation as evidence rather
//! than as an implicit answer.  Tags and explicitly injected remote release/tag
//! refs are the only observations allowed to carry reference/commit evidence;
//! document and manifest declarations remain unresolved candidates unless a
//! future collector supplies an explicit linkage.

use crate::evidence::{
    EvidenceReference, EvidenceSourceIdentity, EvidenceSourceKind, LocalRefObservation,
    LocalReleaseEvidence, PackageManifestVersionDeclaration, ReleaseDocumentDeclaration,
    RemoteReferenceObservation, RemoteSnapshot, UnavailableSourceGap,
};
use crate::{Availability, ExactText, FoundationError, FullId};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeMap;

/// The exact report gap emitted when selection cannot establish one baseline.
pub const NO_UNAMBIGUOUS_RELEASE_BASELINE: &str = "no unambiguous release baseline";

/// The exact report gap emitted when a candidate has no usable release date.
pub const RELEASE_DATE_EVIDENCE_UNAVAILABLE: &str = "release-date evidence unavailable";

/// A complete reference spelling used by a release candidate.
///
/// The collector preserves Git's complete ref name as text.  This alias keeps
/// the public release contract readable without introducing another wrapper for
/// the existing exact-text primitive.
pub type FullGitReference = ExactText;

/// Stable candidate identifiers are deterministic text derived from source and
/// locator identity, never from version ordering.
pub type StableId = ExactText;

/// One validated, exact release-date observation and its source pointer.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ReleaseDateObservation {
    /// The source's exact date spelling.  It is never normalized before being
    /// retained or serialized.
    pub date: ExactText,
    pub evidence: EvidenceReference,
}

impl ReleaseDateObservation {
    /// Construct a date observation after validating an ISO/RFC3339-like shape.
    pub fn new(
        date: impl Into<String>,
        evidence: EvidenceReference,
    ) -> Result<Self, FoundationError> {
        Self::try_new(date, evidence)
    }

    /// Fallible constructor named consistently with the other evidence types.
    pub fn try_new(
        date: impl Into<String>,
        evidence: EvidenceReference,
    ) -> Result<Self, FoundationError> {
        let date = date.into();
        validate_date_shape(&date)?;
        Ok(Self {
            date: ExactText::new(date),
            evidence,
        })
    }

    pub fn as_str(&self) -> &str {
        self.date.as_str()
    }
}

/// One normalized local, remote, document, or manifest release observation.
///
/// `Availability::Empty` means the source was inspected and did not provide a
/// value. `Availability::Unavailable` means it could not provide one.  A
/// document or manifest candidate therefore remains visible with unresolved
/// reference and commit fields instead of being silently discarded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseCandidate {
    pub candidate_id: StableId,
    pub version: Availability<ExactText>,
    pub exact_declaration: Availability<ExactText>,
    pub reference: Availability<FullGitReference>,
    pub resolved_commit: Availability<FullId>,
    pub release_dates: Vec<ReleaseDateObservation>,
    pub source_evidence: Vec<EvidenceReference>,
    pub blockers: Vec<ExactText>,
    /// Exact date values that were present but failed shape validation.  They
    /// are kept separately so invalid evidence cannot be mistaken for an
    /// unavailable/no-date candidate.
    pub invalid_release_dates: Vec<ExactText>,
}

impl ReleaseCandidate {
    /// Build a candidate from already typed values.  The selector normalizes
    /// ordering and adds source-specific blockers before comparing it.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        candidate_id: impl Into<String>,
        version: Availability<ExactText>,
        exact_declaration: Availability<ExactText>,
        reference: Availability<FullGitReference>,
        resolved_commit: Availability<FullId>,
        release_dates: Vec<ReleaseDateObservation>,
        source_evidence: Vec<EvidenceReference>,
    ) -> Self {
        Self {
            candidate_id: ExactText::new(candidate_id),
            version,
            exact_declaration,
            reference,
            resolved_commit,
            release_dates,
            source_evidence,
            blockers: Vec::new(),
            invalid_release_dates: Vec::new(),
        }
    }

    pub fn is_fully_linked(&self) -> bool {
        self.reference.is_present()
            && self.resolved_commit.is_present()
            && self.version.is_present()
    }

    pub fn released_version(&self) -> &Availability<ExactText> {
        &self.version
    }

    pub fn exact_reference(&self) -> &Availability<FullGitReference> {
        &self.reference
    }

    pub fn has_valid_release_date(&self) -> bool {
        !self.release_dates.is_empty()
    }

    pub fn has_invalid_release_date(&self) -> bool {
        !self.invalid_release_dates.is_empty()
    }
}

/// One deterministic comparison row for exactly one [`ReleaseCandidate`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CandidateComparison {
    pub candidate_id: StableId,
    pub candidate: ReleaseCandidate,
    pub reference: Availability<FullGitReference>,
    pub resolved_commit: Availability<FullId>,
    pub version: Availability<ExactText>,
    pub release_dates: Vec<ReleaseDateObservation>,
    pub selectable: bool,
    pub selected: bool,
    pub blockers: Vec<ExactText>,
    pub rationale: ExactText,
    pub evidence: Vec<EvidenceReference>,
}

impl CandidateComparison {
    pub fn is_fully_linked(&self) -> bool {
        self.selectable
    }

    pub fn latest_date(&self) -> Option<&ReleaseDateObservation> {
        self.release_dates.iter().max_by(|left, right| {
            compare_release_date_observations(left, right)
                .then_with(|| left.evidence.cmp(&right.evidence))
        })
    }
}

/// The selected, fully evidenced release baseline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseBaseline {
    pub reference: FullGitReference,
    pub commit: FullId,
    /// Compatibility spelling for consumers that call the baseline value a
    /// resolved commit.  It always equals `commit`.
    pub resolved_commit: FullId,
    pub version: ExactText,
    pub release_date_observations: Availability<Vec<ReleaseDateObservation>>,
    pub candidate_comparisons: Vec<CandidateComparison>,
    pub rationale: ExactText,
    pub evidence: Vec<EvidenceReference>,
    pub gaps: Vec<UnavailableSourceGap>,
}

impl ReleaseBaseline {
    pub fn release_date_evidence_available(&self) -> bool {
        self.release_date_observations.is_present()
    }

    pub fn comparisons(&self) -> &[CandidateComparison] {
        &self.candidate_comparisons
    }
}

/// The fail-closed result of release-baseline selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BaselineDecision {
    Selected(ReleaseBaseline),
    NoUnambiguous {
        reason: ExactText,
        candidate_comparisons: Vec<CandidateComparison>,
        blockers: Vec<ExactText>,
        gaps: Vec<UnavailableSourceGap>,
    },
}

impl BaselineDecision {
    pub fn is_selected(&self) -> bool {
        matches!(self, Self::Selected(_))
    }

    pub fn is_no_unambiguous(&self) -> bool {
        matches!(self, Self::NoUnambiguous { .. })
    }

    pub fn baseline(&self) -> Option<&ReleaseBaseline> {
        match self {
            Self::Selected(baseline) => Some(baseline),
            Self::NoUnambiguous { .. } => None,
        }
    }

    pub fn comparisons(&self) -> &[CandidateComparison] {
        match self {
            Self::Selected(baseline) => &baseline.candidate_comparisons,
            Self::NoUnambiguous {
                candidate_comparisons,
                ..
            } => candidate_comparisons,
        }
    }

    pub fn gaps(&self) -> &[UnavailableSourceGap] {
        match self {
            Self::Selected(baseline) => &baseline.gaps,
            Self::NoUnambiguous { gaps, .. } => gaps,
        }
    }

    pub fn blockers(&self) -> Vec<ExactText> {
        match self {
            Self::Selected(baseline) => baseline
                .candidate_comparisons
                .iter()
                .flat_map(|row| row.blockers.iter().cloned())
                .collect(),
            Self::NoUnambiguous { blockers, .. } => blockers.clone(),
        }
    }

    pub fn rationale(&self) -> &str {
        match self {
            Self::Selected(baseline) => baseline.rationale.as_str(),
            Self::NoUnambiguous { reason, .. } => reason.as_str(),
        }
    }
}

/// A report-friendly aggregate retaining candidates, rows, decision, and all
/// source/date gaps in one serializable value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseSelectionReport {
    pub candidates: Vec<ReleaseCandidate>,
    pub candidate_comparisons: Vec<CandidateComparison>,
    pub decision: BaselineDecision,
    pub gaps: Vec<UnavailableSourceGap>,
}

/// Compatibility aliases for callers that use “comparison report” wording.
pub type ReleaseComparison = ReleaseSelectionReport;
pub type ReleaseBaselineReport = ReleaseSelectionReport;

/// Normalize every release observation into one deterministic candidate row.
pub fn normalize_release_candidates(evidence: &LocalReleaseEvidence) -> Vec<ReleaseCandidate> {
    let mut candidates = Vec::new();

    if let Availability::Present(refs) = &evidence.refs {
        for observation in refs {
            if is_local_tag_ref(observation.full_ref.as_str()) {
                candidates.push(candidate_from_local_ref(observation));
            }
        }
    }

    if let Availability::Present(remote) = &evidence.remote {
        normalize_remote_candidates(remote, &mut candidates);
    }

    if let Availability::Present(declarations) = &evidence.release_documents {
        candidates.extend(declarations.iter().map(candidate_from_document));
    }

    if let Availability::Present(declarations) = &evidence.package_manifests {
        candidates.extend(declarations.iter().map(candidate_from_manifest));
    }

    for candidate in &mut candidates {
        normalize_candidate(candidate);
    }
    let mut candidates = coalesce_corresponding_reference_candidates(candidates);
    candidates.sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
    candidates
}

/// Compatibility name for the normalization entry point.
pub fn collect_release_candidates(evidence: &LocalReleaseEvidence) -> Vec<ReleaseCandidate> {
    normalize_release_candidates(evidence)
}

/// Build deterministic comparison rows without making a baseline decision.
pub fn compare_release_candidates(evidence: &LocalReleaseEvidence) -> Vec<CandidateComparison> {
    normalize_release_candidates(evidence)
        .into_iter()
        .map(comparison_for_candidate)
        .collect()
}

/// Select a baseline from collected evidence, or return every row and named
/// blockers in [`BaselineDecision::NoUnambiguous`].
pub fn select_release_baseline(evidence: &LocalReleaseEvidence) -> BaselineDecision {
    let candidates = normalize_release_candidates(evidence);
    select_from_candidates(evidence, candidates)
}

/// Compatibility name for callers using the shorter selector spelling.
pub fn select_baseline(evidence: &LocalReleaseEvidence) -> BaselineDecision {
    select_release_baseline(evidence)
}

/// Return all normalized candidates, rows, gaps, and the fail-closed decision.
pub fn release_selection_report(evidence: &LocalReleaseEvidence) -> ReleaseSelectionReport {
    let candidates = normalize_release_candidates(evidence);
    let decision = select_from_candidates(evidence, candidates.clone());
    let candidate_comparisons = decision.comparisons().to_vec();
    let gaps = decision.gaps().to_vec();
    ReleaseSelectionReport {
        candidates,
        candidate_comparisons,
        decision,
        gaps,
    }
}

/// Stateless selector façade for callers that prefer an object API.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReleaseSelector;

impl ReleaseSelector {
    pub fn normalize(evidence: &LocalReleaseEvidence) -> Vec<ReleaseCandidate> {
        normalize_release_candidates(evidence)
    }

    pub fn compare(evidence: &LocalReleaseEvidence) -> Vec<CandidateComparison> {
        compare_release_candidates(evidence)
    }

    pub fn select(evidence: &LocalReleaseEvidence) -> BaselineDecision {
        select_release_baseline(evidence)
    }

    pub fn report(evidence: &LocalReleaseEvidence) -> ReleaseSelectionReport {
        release_selection_report(evidence)
    }
}

fn select_from_candidates(
    evidence: &LocalReleaseEvidence,
    candidates: Vec<ReleaseCandidate>,
) -> BaselineDecision {
    let mut rows: Vec<CandidateComparison> = candidates
        .into_iter()
        .map(comparison_for_candidate)
        .collect();
    let mut gaps = source_gaps(evidence, &rows);
    let mut blockers = Vec::new();

    let linked_indices: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| row.selectable.then_some(index))
        .collect();

    if linked_indices.is_empty() {
        blockers.push(ExactText::new(
            "no candidate has an exact reference, full resolved commit, and released version",
        ));
        for row in &mut rows {
            push_unique(&mut row.blockers, "no fully linked candidate");
            row.rationale = ExactText::new(format!(
                "candidate {} cannot establish a release baseline: {}",
                row.candidate_id,
                join_texts(&row.blockers)
            ));
        }
        return no_unambiguous(rows, blockers, gaps);
    }

    let conflicting_references = conflicting_reference_blockers(&rows, &linked_indices);
    if !conflicting_references.is_empty() {
        let message = "conflicting or duplicate exact reference observations";
        blockers.push(ExactText::new(message));
        gaps.push(selector_gap(message));
        for (index, conflicts) in conflicting_references {
            push_unique(&mut rows[index].blockers, message);
            for conflict in conflicts {
                push_unique(&mut rows[index].blockers, conflict.as_str());
            }
        }
        return no_unambiguous(rows, blockers, gaps);
    }

    let dated_indices: Vec<usize> = linked_indices
        .iter()
        .copied()
        .filter(|index| !rows[*index].release_dates.is_empty())
        .collect();
    let undated_indices: Vec<usize> = linked_indices
        .iter()
        .copied()
        .filter(|index| rows[*index].release_dates.is_empty())
        .collect();

    if !dated_indices.is_empty() && !undated_indices.is_empty() {
        let message =
            "release-date evidence unavailable prevents a recency comparison with fully linked candidates";
        blockers.push(ExactText::new(message));
        gaps.push(selector_gap(RELEASE_DATE_EVIDENCE_UNAVAILABLE));
        for index in undated_indices {
            push_unique(&mut rows[index].blockers, message);
        }
        for index in dated_indices {
            push_unique(&mut rows[index].blockers, message);
        }
        return no_unambiguous(rows, blockers, gaps);
    }

    let selected_index = if dated_indices.is_empty() {
        if linked_indices.len() == 1
            && rows[linked_indices[0]]
                .candidate
                .invalid_release_dates
                .is_empty()
        {
            Some(linked_indices[0])
        } else {
            blockers.push(ExactText::new(
                "multiple undated or invalid-date fully linked candidates",
            ));
            gaps.push(selector_gap(RELEASE_DATE_EVIDENCE_UNAVAILABLE));
            for index in linked_indices {
                push_unique(
                    &mut rows[index].blockers,
                    "multiple undated or invalid-date fully linked candidates",
                );
            }
            None
        }
    } else {
        let latest = latest_date_value(&rows, &dated_indices).expect("non-empty dated set");
        let newest: Vec<usize> = dated_indices
            .iter()
            .copied()
            .filter(|index| latest_date_value_for_row(&rows[*index]) == Some(latest.clone()))
            .collect();
        if newest.len() == 1 {
            Some(newest[0])
        } else {
            let latest_dates = newest_date_texts(&rows, &newest, &latest);
            let message = format!(
                "tied newest validated release date (by actual instant) `{}` across {} candidates",
                latest_dates.join(", "),
                newest.len()
            );
            blockers.push(ExactText::new(message.clone()));
            gaps.push(selector_gap("tied or conflicting release-date evidence"));
            for index in newest {
                push_unique(&mut rows[index].blockers, message.as_str());
            }
            None
        }
    };

    let Some(selected_index) = selected_index else {
        return no_unambiguous(rows, blockers, gaps);
    };

    for (index, row) in rows.iter_mut().enumerate() {
        row.selected = index == selected_index;
        row.rationale = comparison_rationale(row, row.selected, None);
    }

    let selected = &rows[selected_index];
    let candidate = &selected.candidate;
    let reference = match &candidate.reference {
        Availability::Present(reference) => reference.clone(),
        Availability::Empty | Availability::Unavailable => {
            unreachable!("selected candidate must have an exact reference")
        }
    };
    let commit = match &candidate.resolved_commit {
        Availability::Present(commit) => commit.clone(),
        Availability::Empty | Availability::Unavailable => {
            unreachable!("selected candidate must have a full resolved commit")
        }
    };
    let version = match &candidate.version {
        Availability::Present(version) => version.clone(),
        Availability::Empty | Availability::Unavailable => {
            unreachable!("selected candidate must have a released version")
        }
    };
    let date_observations = if candidate.release_dates.is_empty() {
        gaps.push(typed_gap_for_candidate(
            candidate,
            RELEASE_DATE_EVIDENCE_UNAVAILABLE,
        ));
        Availability::Unavailable
    } else {
        Availability::Present(candidate.release_dates.clone())
    };
    let rationale = selection_rationale(&rows, selected_index, date_observations.is_present());
    let mut baseline_evidence = candidate.source_evidence.clone();
    baseline_evidence.extend(
        candidate
            .release_dates
            .iter()
            .map(|date| date.evidence.clone()),
    );
    sort_dedup_evidence(&mut baseline_evidence);
    sort_dedup_gaps(&mut gaps);

    BaselineDecision::Selected(ReleaseBaseline {
        reference,
        commit: commit.clone(),
        resolved_commit: commit,
        version,
        release_date_observations: date_observations,
        candidate_comparisons: rows,
        rationale: ExactText::new(rationale),
        evidence: baseline_evidence,
        gaps,
    })
}

fn no_unambiguous(
    mut rows: Vec<CandidateComparison>,
    mut blockers: Vec<ExactText>,
    mut gaps: Vec<UnavailableSourceGap>,
) -> BaselineDecision {
    push_unique(&mut blockers, NO_UNAMBIGUOUS_RELEASE_BASELINE);
    for row in &mut rows {
        row.selected = false;
        row.rationale = comparison_rationale(row, false, Some(NO_UNAMBIGUOUS_RELEASE_BASELINE));
    }
    for row in &rows {
        for blocker in &row.blockers {
            push_unique(&mut blockers, blocker.as_str());
        }
    }
    gaps.push(selector_gap(NO_UNAMBIGUOUS_RELEASE_BASELINE));
    sort_dedup_texts(&mut blockers);
    sort_dedup_gaps(&mut gaps);
    BaselineDecision::NoUnambiguous {
        reason: ExactText::new(NO_UNAMBIGUOUS_RELEASE_BASELINE),
        candidate_comparisons: rows,
        blockers,
        gaps,
    }
}

fn candidate_from_local_ref(observation: &LocalRefObservation) -> ReleaseCandidate {
    let full_ref = observation.full_ref.as_str();
    let version = full_ref
        .strip_prefix("refs/tags/")
        .filter(|value| !value.is_empty())
        .map(|value| Availability::Present(ExactText::new(value.to_owned())))
        .unwrap_or(Availability::Empty);
    let mut candidate = ReleaseCandidate::new(
        format!("local-git:{full_ref}"),
        version,
        Availability::Empty,
        Availability::Present(observation.full_ref.clone()),
        observation.resolved_commit.clone(),
        Vec::new(),
        vec![observation.reference.clone()],
    );
    add_ref_date(&mut candidate, &observation.date, &observation.reference);
    candidate
}

fn normalize_remote_candidates(remote: &RemoteSnapshot, candidates: &mut Vec<ReleaseCandidate>) {
    let Availability::Present(references) = &remote.references else {
        return;
    };
    for observation in references {
        if !is_remote_release_or_tag_ref(observation) {
            continue;
        }
        candidates.push(candidate_from_remote_ref(remote, observation));
    }
}

fn candidate_from_remote_ref(
    remote: &RemoteSnapshot,
    observation: &RemoteReferenceObservation,
) -> ReleaseCandidate {
    let full_ref = observation.full_ref.as_str();
    let version = release_version_from_ref(full_ref);
    let mut source_evidence = vec![
        remote.snapshot_reference.clone(),
        observation.reference.clone(),
    ];
    sort_dedup_evidence(&mut source_evidence);
    let mut candidate = ReleaseCandidate::new(
        format!("remote:{}:{full_ref}", remote.snapshot.as_str()),
        version,
        Availability::Empty,
        Availability::Present(observation.full_ref.clone()),
        observation.resolved_commit.clone(),
        Vec::new(),
        source_evidence,
    );
    add_ref_date(&mut candidate, &observation.date, &observation.reference);
    candidate
}

fn candidate_from_document(declaration: &ReleaseDocumentDeclaration) -> ReleaseCandidate {
    let path = declaration.path.as_str();
    let candidate_id = format!(
        "document:{path}:{}-{}:{}",
        declaration.span.start,
        declaration.span.end,
        declaration.version.as_str()
    );
    let mut candidate = ReleaseCandidate::new(
        candidate_id,
        Availability::Present(declaration.version.clone()),
        Availability::Present(declaration.text.clone()),
        Availability::Empty,
        Availability::Empty,
        Vec::new(),
        vec![declaration.reference.clone()],
    );
    add_text_dates(
        &mut candidate,
        declaration.text.as_str(),
        &declaration.reference,
    );
    if is_readme_path(path) {
        candidate
            .blockers
            .push(ExactText::new("unresolved reference evidence"));
    }
    candidate
}

fn candidate_from_manifest(declaration: &PackageManifestVersionDeclaration) -> ReleaseCandidate {
    let path = declaration.path.as_str();
    let candidate_id = format!(
        "manifest:{path}:{}-{}:{}",
        declaration.span.start,
        declaration.span.end,
        declaration.version.as_str()
    );
    let mut candidate = ReleaseCandidate::new(
        candidate_id,
        Availability::Present(declaration.version.clone()),
        Availability::Present(declaration.text.clone()),
        Availability::Empty,
        Availability::Empty,
        Vec::new(),
        vec![declaration.reference.clone()],
    );
    add_text_dates(
        &mut candidate,
        declaration.text.as_str(),
        &declaration.reference,
    );
    candidate
}

fn normalize_candidate(candidate: &mut ReleaseCandidate) {
    sort_dedup_evidence(&mut candidate.source_evidence);
    candidate.release_dates.sort();
    candidate.release_dates.dedup();
    sort_dedup_texts(&mut candidate.invalid_release_dates);
    let mut blockers = candidate.blockers.clone();
    if !candidate.reference.is_present() {
        push_unique(&mut blockers, "exact reference unavailable");
    }
    if !candidate.resolved_commit.is_present() {
        push_unique(&mut blockers, "full resolved commit unavailable");
    }
    if !candidate.version.is_present() {
        push_unique(&mut blockers, "released version unavailable");
    }
    if candidate.release_dates.is_empty() {
        push_unique(&mut blockers, RELEASE_DATE_EVIDENCE_UNAVAILABLE);
    }
    for date in &candidate.invalid_release_dates {
        push_unique(
            &mut blockers,
            format!("invalid release-date observation: {}", date.as_str()),
        );
    }
    sort_dedup_texts(&mut blockers);
    candidate.blockers = blockers;
}

fn coalesce_corresponding_reference_candidates(
    candidates: Vec<ReleaseCandidate>,
) -> Vec<ReleaseCandidate> {
    let mut coalesced: Vec<ReleaseCandidate> = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let reference = match &candidate.reference {
            Availability::Present(reference) => Some(reference.as_str().to_owned()),
            Availability::Empty | Availability::Unavailable => None,
        };
        let matching_index = reference.as_deref().and_then(|reference| {
            coalesced.iter().position(|existing| {
                matches!(
                    &existing.reference,
                    Availability::Present(existing_reference)
                        if existing_reference.as_str() == reference
                ) && reference_candidates_compatible(existing, &candidate)
            })
        });

        if let Some(index) = matching_index {
            merge_corresponding_candidates(&mut coalesced[index], candidate);
        } else {
            coalesced.push(candidate);
        }
    }
    coalesced
}

fn reference_candidates_compatible(left: &ReleaseCandidate, right: &ReleaseCandidate) -> bool {
    availabilities_compatible(&left.version, &right.version)
        && availabilities_compatible(&left.exact_declaration, &right.exact_declaration)
        && availabilities_compatible(&left.reference, &right.reference)
        && availabilities_compatible(&left.resolved_commit, &right.resolved_commit)
        && date_evidence_compatible(left, right)
}

fn availabilities_compatible<T: PartialEq>(
    left: &Availability<T>,
    right: &Availability<T>,
) -> bool {
    match (left, right) {
        (Availability::Present(left), Availability::Present(right)) => left == right,
        _ => true,
    }
}

fn date_evidence_compatible(left: &ReleaseCandidate, right: &ReleaseCandidate) -> bool {
    if left.invalid_release_dates != right.invalid_release_dates
        && (!left.invalid_release_dates.is_empty() || !right.invalid_release_dates.is_empty())
    {
        return false;
    }
    if left.release_dates.is_empty() || right.release_dates.is_empty() {
        return true;
    }
    candidate_date_instants(left) == candidate_date_instants(right)
}

fn candidate_date_instants(candidate: &ReleaseCandidate) -> Vec<ReleaseInstant> {
    let mut instants = candidate
        .release_dates
        .iter()
        .filter_map(|date| parse_release_instant(date.date.as_str()).ok())
        .collect::<Vec<_>>();
    instants.sort();
    instants.dedup();
    instants
}

fn merge_corresponding_candidates(left: &mut ReleaseCandidate, right: ReleaseCandidate) {
    if right.candidate_id < left.candidate_id {
        left.candidate_id = right.candidate_id.clone();
    }
    left.version = merge_availability(&left.version, &right.version);
    left.exact_declaration = merge_availability(&left.exact_declaration, &right.exact_declaration);
    left.reference = merge_availability(&left.reference, &right.reference);
    left.resolved_commit = merge_availability(&left.resolved_commit, &right.resolved_commit);
    left.release_dates.extend(right.release_dates);
    left.source_evidence.extend(right.source_evidence);
    left.blockers.extend(right.blockers);
    left.invalid_release_dates
        .extend(right.invalid_release_dates);
    normalize_candidate(left);
}

fn merge_availability<T: Clone>(
    left: &Availability<T>,
    right: &Availability<T>,
) -> Availability<T> {
    match (left, right) {
        (Availability::Present(value), _) => Availability::Present(value.clone()),
        (_, Availability::Present(value)) => Availability::Present(value.clone()),
        (Availability::Unavailable, _) | (_, Availability::Unavailable) => {
            Availability::Unavailable
        }
        _ => Availability::Empty,
    }
}

fn comparison_for_candidate(candidate: ReleaseCandidate) -> CandidateComparison {
    let selectable = candidate.is_fully_linked();
    let blockers = candidate.blockers.clone();
    let rationale = comparison_rationale_from_candidate(&candidate, false, None);
    CandidateComparison {
        candidate_id: candidate.candidate_id.clone(),
        reference: candidate.reference.clone(),
        resolved_commit: candidate.resolved_commit.clone(),
        version: candidate.version.clone(),
        release_dates: candidate.release_dates.clone(),
        selectable,
        selected: false,
        blockers,
        rationale: ExactText::new(rationale),
        evidence: candidate.source_evidence.clone(),
        candidate,
    }
}

fn comparison_rationale(
    row: &CandidateComparison,
    selected: bool,
    decision_gap: Option<&str>,
) -> ExactText {
    ExactText::new(comparison_rationale_from_candidate(
        &row.candidate,
        selected,
        decision_gap,
    ))
}

fn comparison_rationale_from_candidate(
    candidate: &ReleaseCandidate,
    selected: bool,
    decision_gap: Option<&str>,
) -> String {
    let status = if selected { "selected" } else { "considered" };
    let dates = if candidate.release_dates.is_empty() {
        RELEASE_DATE_EVIDENCE_UNAVAILABLE.to_owned()
    } else {
        candidate
            .release_dates
            .iter()
            .map(|date| date.date.as_str().to_owned())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut result = format!(
        "{status} candidate {}: reference={}, commit={}, version={}, dates={}",
        candidate.candidate_id,
        availability_text(&candidate.reference),
        availability_text(&candidate.resolved_commit),
        availability_text(&candidate.version),
        dates
    );
    if !candidate.blockers.is_empty() {
        result.push_str("; blockers=");
        result.push_str(&join_texts(&candidate.blockers));
    }
    if let Some(decision_gap) = decision_gap {
        result.push_str("; decision=");
        result.push_str(decision_gap);
    }
    result
}

fn selection_rationale(
    rows: &[CandidateComparison],
    selected_index: usize,
    date_available: bool,
) -> String {
    let selected = &rows[selected_index];
    let reason = if date_available {
        let latest = selected
            .latest_date()
            .map(|date| date.date.as_str())
            .unwrap_or(RELEASE_DATE_EVIDENCE_UNAVAILABLE);
        format!(
            "selected candidate {} because it is the unique newest fully linked candidate by validated release instant in date evidence `{latest}`",
            selected.candidate_id
        )
    } else {
        format!(
            "selected candidate {} because it is the unique fully linked candidate; {}",
            selected.candidate_id, RELEASE_DATE_EVIDENCE_UNAVAILABLE
        )
    };
    let comparisons = rows
        .iter()
        .map(|row| row.rationale.as_str().to_owned())
        .collect::<Vec<_>>()
        .join(" | ");
    format!("{reason}; considered every candidate: {comparisons}")
}

fn conflicting_reference_blockers(
    rows: &[CandidateComparison],
    linked: &[usize],
) -> Vec<(usize, Vec<ExactText>)> {
    let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for index in linked {
        if let Availability::Present(reference) = &rows[*index].reference {
            groups
                .entry(reference.as_str().to_owned())
                .or_default()
                .push(*index);
        }
    }

    let mut result: BTreeMap<usize, Vec<ExactText>> = BTreeMap::new();
    for (reference, indices) in groups {
        if indices.len() < 2 {
            continue;
        }

        let commits = indices
            .iter()
            .map(|index| &rows[*index].resolved_commit)
            .collect::<Vec<_>>();
        let versions = indices
            .iter()
            .map(|index| &rows[*index].version)
            .collect::<Vec<_>>();
        let mut reasons = Vec::new();
        if available_values_conflict(&commits) {
            reasons.push(ExactText::new(format!(
                "conflicting commit evidence for exact reference `{reference}`"
            )));
        }
        if available_values_conflict(&versions) {
            reasons.push(ExactText::new(format!(
                "conflicting version evidence for exact reference `{reference}`"
            )));
        }
        if indices.iter().enumerate().any(|(position, left)| {
            indices[position + 1..].iter().any(|right| {
                !date_evidence_compatible(&rows[*left].candidate, &rows[*right].candidate)
            })
        }) {
            reasons.push(ExactText::new(format!(
                "conflicting release-date evidence for exact reference `{reference}`"
            )));
        }
        if reasons.is_empty() {
            reasons.push(ExactText::new(format!(
                "duplicate exact reference observations for `{reference}`"
            )));
        }
        for index in indices {
            let row_reasons = result.entry(index).or_default();
            for reason in &reasons {
                push_unique(row_reasons, reason.as_str());
            }
        }
    }
    result.into_iter().collect()
}

fn available_values_conflict<T: PartialEq>(values: &[&Availability<T>]) -> bool {
    let mut first: Option<&T> = None;
    for availability in values {
        if let Availability::Present(value) = *availability {
            if let Some(previous) = first {
                if previous != value {
                    return true;
                }
            } else {
                first = Some(value);
            }
        }
    }
    false
}

fn latest_date_value(rows: &[CandidateComparison], indices: &[usize]) -> Option<ReleaseInstant> {
    indices
        .iter()
        .filter_map(|index| latest_date_value_for_row(&rows[*index]))
        .max()
}

fn latest_date_value_for_row(row: &CandidateComparison) -> Option<ReleaseInstant> {
    row.release_dates
        .iter()
        .filter_map(|date| parse_release_instant(date.date.as_str()).ok())
        .max()
}

fn newest_date_texts(
    rows: &[CandidateComparison],
    indices: &[usize],
    latest: &ReleaseInstant,
) -> Vec<String> {
    let mut dates = Vec::new();
    for index in indices {
        for date in &rows[*index].release_dates {
            if parse_release_instant(date.date.as_str())
                .map(|instant| instant.eq(latest))
                .unwrap_or(false)
            {
                dates.push(date.date.as_str().to_owned());
            }
        }
    }
    dates.sort();
    dates.dedup();
    dates
}

fn source_gaps(
    evidence: &LocalReleaseEvidence,
    rows: &[CandidateComparison],
) -> Vec<UnavailableSourceGap> {
    let mut gaps = evidence.gaps.clone();
    add_availability_gap(
        &mut gaps,
        &evidence.refs,
        EvidenceSourceKind::LocalGit,
        "local-refs",
        "local tag references unavailable",
    );
    add_availability_gap(
        &mut gaps,
        &evidence.release_documents,
        EvidenceSourceKind::ReleaseDocument,
        "discovery",
        "release document source unavailable",
    );
    add_availability_gap(
        &mut gaps,
        &evidence.package_manifests,
        EvidenceSourceKind::PackageManifest,
        "discovery",
        "package manifest source unavailable",
    );
    if matches!(evidence.remote, Availability::Unavailable) {
        gaps.push(UnavailableSourceGap::new(
            source_identity(EvidenceSourceKind::RemoteSnapshot, "injected"),
            "remote snapshot unavailable",
        ));
    }
    if let Availability::Present(remote) = &evidence.remote {
        if matches!(remote.references, Availability::Unavailable) {
            gaps.push(UnavailableSourceGap::new(
                remote.source.clone(),
                "remote release/tag references unavailable",
            ));
        }
    }
    for row in rows {
        if row.candidate.release_dates.is_empty() {
            gaps.push(typed_gap_for_candidate(
                &row.candidate,
                RELEASE_DATE_EVIDENCE_UNAVAILABLE,
            ));
        }
        for date in &row.candidate.invalid_release_dates {
            gaps.push(typed_gap_for_candidate(
                &row.candidate,
                format!("invalid release-date observation: {}", date.as_str()),
            ));
        }
    }
    sort_dedup_gaps(&mut gaps);
    gaps
}

fn add_availability_gap<T>(
    gaps: &mut Vec<UnavailableSourceGap>,
    value: &Availability<T>,
    kind: EvidenceSourceKind,
    name: &str,
    reason: &str,
) {
    if matches!(value, Availability::Unavailable) {
        gaps.push(UnavailableSourceGap::new(
            source_identity(kind, name),
            reason,
        ));
    }
}

fn add_ref_date(
    candidate: &mut ReleaseCandidate,
    date: &Availability<ExactText>,
    evidence: &EvidenceReference,
) {
    if let Availability::Present(date) = date {
        match ReleaseDateObservation::try_new(date.as_str(), evidence.clone()) {
            Ok(observation) => candidate.release_dates.push(observation),
            Err(_) => candidate.invalid_release_dates.push(date.clone()),
        }
    }
}

fn add_text_dates(candidate: &mut ReleaseCandidate, text: &str, evidence: &EvidenceReference) {
    for date in extract_date_strings(text) {
        if let Ok(observation) = ReleaseDateObservation::try_new(date, evidence.clone()) {
            candidate.release_dates.push(observation);
        }
    }
}

fn is_local_tag_ref(reference: &str) -> bool {
    reference.starts_with("refs/tags/")
}

fn is_remote_release_or_tag_ref(observation: &RemoteReferenceObservation) -> bool {
    let reference = observation.full_ref.as_str();
    if reference.starts_with("refs/tags/")
        || reference.starts_with("refs/release/")
        || reference.starts_with("refs/releases/")
        || reference.contains("/release/")
        || reference.ends_with("/release")
    {
        return true;
    }
    reference.split('/').any(|component| {
        component == "release" || component == "releases" || component.starts_with("release-")
    })
}

fn release_version_from_ref(reference: &str) -> Availability<ExactText> {
    let suffix = reference
        .strip_prefix("refs/tags/")
        .or_else(|| reference.strip_prefix("refs/release/"))
        .or_else(|| reference.strip_prefix("refs/releases/"))
        .or_else(|| reference.rsplit_once("/release/").map(|(_, suffix)| suffix))
        .or_else(|| {
            reference
                .rsplit('/')
                .next()
                .and_then(|leaf| leaf.strip_prefix("release-"))
        })
        .filter(|suffix| !suffix.is_empty());
    suffix
        .map(|suffix| Availability::Present(ExactText::new(suffix.to_owned())))
        .unwrap_or(Availability::Empty)
}

fn is_readme_path(path: &str) -> bool {
    !path.contains('/')
        && path
            .rsplit_once('.')
            .map(|(stem, extension)| {
                stem.eq_ignore_ascii_case("readme") && extension.eq_ignore_ascii_case("md")
            })
            .unwrap_or(false)
}

fn source_identity(kind: EvidenceSourceKind, name: impl Into<String>) -> EvidenceSourceIdentity {
    EvidenceSourceIdentity {
        kind,
        name: ExactText::new(name),
    }
}

fn typed_gap_for_candidate(
    candidate: &ReleaseCandidate,
    reason: impl Into<String>,
) -> UnavailableSourceGap {
    let source = candidate
        .source_evidence
        .first()
        .map(|evidence| evidence.source.clone())
        .unwrap_or_else(|| source_identity(EvidenceSourceKind::LocalGit, "release-selector"));
    UnavailableSourceGap::new(source, reason)
}

fn selector_gap(reason: impl Into<String>) -> UnavailableSourceGap {
    UnavailableSourceGap::new(
        source_identity(EvidenceSourceKind::LocalGit, "release-selector"),
        reason,
    )
}

fn availability_text<T: std::fmt::Display>(value: &Availability<T>) -> String {
    match value {
        Availability::Present(value) => value.to_string(),
        Availability::Empty => "empty".to_owned(),
        Availability::Unavailable => "unavailable".to_owned(),
    }
}

fn join_texts(values: &[ExactText]) -> String {
    values
        .iter()
        .map(|value| value.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn push_unique(values: &mut Vec<ExactText>, value: impl Into<String>) {
    let value = ExactText::new(value);
    if !values.contains(&value) {
        values.push(value);
    }
}

fn sort_dedup_texts(values: &mut Vec<ExactText>) {
    values.sort();
    values.dedup();
}

fn sort_dedup_evidence(values: &mut Vec<EvidenceReference>) {
    values.sort();
    values.dedup();
}

fn sort_dedup_gaps(values: &mut Vec<UnavailableSourceGap>) {
    values.sort();
    values.dedup();
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReleaseInstant {
    whole_seconds: i64,
    fraction: String,
}

impl Ord for ReleaseInstant {
    fn cmp(&self, other: &Self) -> Ordering {
        self.whole_seconds
            .cmp(&other.whole_seconds)
            .then_with(|| compare_fractions(&self.fraction, &other.fraction))
    }
}

impl PartialOrd for ReleaseInstant {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn compare_release_date_observations(
    left: &ReleaseDateObservation,
    right: &ReleaseDateObservation,
) -> Ordering {
    let left_instant = parse_release_instant(left.date.as_str());
    let right_instant = parse_release_instant(right.date.as_str());
    match (left_instant, right_instant) {
        (Ok(left), Ok(right)) => left.cmp(&right),
        (Ok(_), Err(_)) => Ordering::Greater,
        (Err(_), Ok(_)) => Ordering::Less,
        (Err(_), Err(_)) => left.date.cmp(&right.date),
    }
}

fn compare_fractions(left: &str, right: &str) -> Ordering {
    let length = left.len().max(right.len());
    for index in 0..length {
        let left_digit = left.as_bytes().get(index).copied().unwrap_or(b'0');
        let right_digit = right.as_bytes().get(index).copied().unwrap_or(b'0');
        match left_digit.cmp(&right_digit) {
            Ordering::Equal => continue,
            ordering => return ordering,
        }
    }
    Ordering::Equal
}

fn parse_release_instant(value: &str) -> Result<ReleaseInstant, FoundationError> {
    if value.is_empty() {
        return Err(FoundationError::invalid(
            "release_date",
            "date observations must not be empty",
        ));
    }
    let bytes = value.as_bytes();
    if bytes.len() < 10
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || bytes[4] != b'-'
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || bytes[7] != b'-'
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return Err(FoundationError::invalid(
            "release_date",
            "date must have an ISO/RFC3339-like YYYY-MM-DD shape",
        ));
    }

    let year = (u32::from(bytes[0] - b'0') * 1000)
        + (u32::from(bytes[1] - b'0') * 100)
        + (u32::from(bytes[2] - b'0') * 10)
        + u32::from(bytes[3] - b'0');
    let month = parse_two_digits(&bytes[5..7]);
    let day = parse_two_digits(&bytes[8..10]);
    if !(1..=12).contains(&month) {
        return Err(FoundationError::invalid(
            "release_date",
            "date month is outside its ISO-like range",
        ));
    }
    let days_in_month = match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day == 0 || day > days_in_month {
        return Err(FoundationError::invalid(
            "release_date",
            "date day is outside its ISO-like range",
        ));
    }

    if bytes.len() == 10 {
        return Ok(ReleaseInstant {
            whole_seconds: days_from_civil(year as i64, month as i64, day as i64) * 86_400,
            fraction: String::new(),
        });
    }
    if !matches!(bytes[10], b'T' | b't' | b' ') || bytes.len() < 19 {
        return Err(FoundationError::invalid(
            "release_date",
            "date time must use an ISO/RFC3339-like separator and time",
        ));
    }
    if bytes[13] != b':'
        || bytes[16] != b':'
        || !bytes[11..13].iter().all(u8::is_ascii_digit)
        || !bytes[14..16].iter().all(u8::is_ascii_digit)
        || !bytes[17..19].iter().all(u8::is_ascii_digit)
    {
        return Err(FoundationError::invalid(
            "release_date",
            "date time must have HH:MM:SS shape",
        ));
    }
    let hour = parse_two_digits(&bytes[11..13]);
    let minute = parse_two_digits(&bytes[14..16]);
    let second = parse_two_digits(&bytes[17..19]);
    if hour > 23 || minute > 59 || second > 60 {
        return Err(FoundationError::invalid(
            "release_date",
            "date time is outside its ISO-like range",
        ));
    }

    let mut index = 19;
    let mut fraction = String::new();
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return Err(FoundationError::invalid(
                "release_date",
                "fractional seconds require at least one digit",
            ));
        }
        fraction = String::from_utf8(bytes[start..index].to_vec()).expect("ASCII digits");
        while fraction.ends_with('0') {
            fraction.pop();
        }
    }

    let timezone = &bytes[index..];
    let offset_minutes = if timezone == b"Z" || timezone == b"z" {
        0_i64
    } else {
        if (timezone.len() != 6 && timezone.len() != 5)
            || !matches!(timezone.first(), Some(b'+' | b'-'))
            || !timezone[1..3].iter().all(u8::is_ascii_digit)
            || (timezone.len() == 6 && timezone[3] != b':')
            || !timezone[timezone.len() - 2..]
                .iter()
                .all(u8::is_ascii_digit)
        {
            return Err(FoundationError::invalid(
                "release_date",
                "date timezone must have +HH:MM or +HHMM shape",
            ));
        }
        let offset_hour = parse_two_digits(&timezone[1..3]);
        let offset_minute = if timezone.len() == 6 {
            parse_two_digits(&timezone[4..6])
        } else {
            parse_two_digits(&timezone[3..5])
        };
        if offset_hour > 23 || offset_minute > 59 {
            return Err(FoundationError::invalid(
                "release_date",
                "date timezone is outside its ISO-like range",
            ));
        }
        let sign = if timezone[0] == b'+' { 1_i64 } else { -1_i64 };
        sign * (i64::from(offset_hour) * 60 + i64::from(offset_minute))
    };

    let local_seconds = days_from_civil(year as i64, month as i64, day as i64) * 86_400
        + i64::from(hour) * 3_600
        + i64::from(minute) * 60
        + i64::from(second);
    Ok(ReleaseInstant {
        whole_seconds: local_seconds - offset_minutes * 60,
        fraction,
    })
}

fn is_leap_year(year: u32) -> bool {
    year % 400 == 0 || (year % 4 == 0 && year % 100 != 0)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year / 400
    } else {
        (adjusted_year - 399) / 400
    };
    let year_of_era = adjusted_year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era
}

fn validate_date_shape(value: &str) -> Result<(), FoundationError> {
    parse_release_instant(value).map(|_| ())
}

fn parse_two_digits(value: &[u8]) -> u32 {
    u32::from(value[0] - b'0') * 10 + u32::from(value[1] - b'0')
}

fn extract_date_strings(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut result = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_digit()
                || matches!(
                    bytes[index],
                    b'-' | b':' | b'T' | b't' | b'Z' | b'z' | b'.' | b'+'
                ))
        {
            index += 1;
        }
        let token = &text[start..index];
        if validate_date_shape(token).is_ok() && !result.iter().any(|item| item == token) {
            result.push(token.to_owned());
        }
    }
    result
}
