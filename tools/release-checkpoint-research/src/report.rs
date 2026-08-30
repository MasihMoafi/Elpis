//! Typed assembly and rendering for the release-checkpoint research report.
//!
//! This module deliberately keeps the report model as the source of truth.  The
//! Markdown and JSON renderers both consume [`ResearchReport`]; neither renderer
//! reconstructs stage results from untyped values.

use crate::{
    ArtifactInventory, Availability, BaselineDecision, BuildPolicyReport, CompletionComparison,
    DeltaReport, EvidenceId, EvidenceReference, EvidenceSet, ExactText, FoundationError,
    IgnorePatternProposal, LocalReleaseEvidence, ReadmeUpdateInput, ReleaseSelectionReport,
    RemovalRegister, StartSnapshot, TriggerEvaluation, UntrackingFollowUp, UtcSeconds,
    WorkflowInventory, WorktreeInventories, WorktreeInventory,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// The stable schema identifier for the assembled report.
pub const RESEARCH_REPORT_SCHEMA_VERSION: &str = "research-report-1";
/// The only visualization statement emitted by the report model.
pub const VISUALIZATION_EXCLUSION_STATEMENT: &str =
    "Approved visualization content is excluded from this report; no visualization URL or source identifier was fetched or generated.";
/// The required integrity statement for the research-only boundary.
pub const NO_IMPLEMENTATION_CHANGE_STATEMENT: &str =
    "No source, ignore-file, CI-workflow, Git-history, or remote-repository implementation change was performed.";
/// The four fixed Markdown section headings, in their required order.
pub const RESEARCH_REPORT_SECTION_HEADINGS: [&str; 10] = [
    "Run identity and scope",
    "Working Tree State",
    "Evidence catalog",
    "Release evidence and baseline",
    "Delta",
    "Artifact inventory",
    "Ignore research and removal register",
    "CI inventory and causality",
    "Ordered action recommendations",
    "Integrity and validation",
];

const MAX_ACTION_TEXT: usize = 500;

impl<T> Default for Availability<T> {
    fn default() -> Self {
        Self::Empty
    }
}

impl Default for ExactText {
    fn default() -> Self {
        Self::new("")
    }
}

fn invalid(field: &'static str, reason: impl Into<String>) -> FoundationError {
    FoundationError::Invalid {
        field,
        reason: reason.into(),
    }
}

fn serialization(reason: impl Into<String>) -> FoundationError {
    FoundationError::Serialization(reason.into())
}

fn validate_bounded_non_empty(
    field: &'static str,
    value: &ExactText,
    maximum: usize,
) -> Result<(), FoundationError> {
    if value.as_str().trim().is_empty() {
        return Err(invalid(field, "value must contain non-whitespace text"));
    }
    if value.as_str().chars().count() > maximum {
        return Err(invalid(
            field,
            format!("value must contain at most {maximum} characters"),
        ));
    }
    Ok(())
}

/// The closed set of conclusion labels emitted by this report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum ResearchConclusionLabel {
    Fact,
    Recommendation,
    Gap,
}

impl ResearchConclusionLabel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fact => "FACT",
            Self::Recommendation => "RECOMMENDATION",
            Self::Gap => "GAP",
        }
    }
}

/// A stable, cited conclusion.  Facts and gaps cannot be created without at
/// least one evidence ID; recommendations are additionally tied to facts or
/// gaps by [`ActionRecommendation::supporting_citations`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LabelledConclusion {
    pub id: EvidenceId,
    pub label: ResearchConclusionLabel,
    pub statement: ExactText,
    pub evidence_ids: Vec<EvidenceId>,
}

impl<'de> Deserialize<'de> for LabelledConclusion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            id: EvidenceId,
            label: ResearchConclusionLabel,
            statement: ExactText,
            evidence_ids: Vec<EvidenceId>,
        }

        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.id, wire.label, wire.statement, wire.evidence_ids)
            .map_err(serde::de::Error::custom)
    }
}

impl LabelledConclusion {
    pub fn new(
        id: impl Into<String>,
        label: ResearchConclusionLabel,
        statement: impl Into<ExactText>,
        evidence_ids: Vec<EvidenceId>,
    ) -> Result<Self, FoundationError> {
        let id = EvidenceId::new(id.into())?;
        let statement = statement.into();
        if statement.as_str().trim().is_empty() {
            return Err(invalid(
                "conclusion_statement",
                "value must contain non-whitespace text",
            ));
        }
        let mut seen = BTreeSet::new();
        for evidence_id in &evidence_ids {
            if !seen.insert(evidence_id) {
                return Err(invalid(
                    "conclusion_evidence",
                    "a conclusion cannot repeat an evidence ID",
                ));
            }
        }
        if matches!(
            label,
            ResearchConclusionLabel::Fact | ResearchConclusionLabel::Gap
        ) && evidence_ids.is_empty()
        {
            return Err(invalid(
                "conclusion_evidence",
                "FACT and GAP conclusions require evidence",
            ));
        }
        Ok(Self {
            id,
            label,
            statement,
            evidence_ids,
        })
    }

    pub fn fact(
        id: impl Into<String>,
        statement: impl Into<ExactText>,
        evidence_ids: Vec<EvidenceId>,
    ) -> Result<Self, FoundationError> {
        Self::new(id, ResearchConclusionLabel::Fact, statement, evidence_ids)
    }

    pub fn recommendation(
        id: impl Into<String>,
        statement: impl Into<ExactText>,
        evidence_ids: Vec<EvidenceId>,
    ) -> Result<Self, FoundationError> {
        Self::new(
            id,
            ResearchConclusionLabel::Recommendation,
            statement,
            evidence_ids,
        )
    }

    pub fn gap(
        id: impl Into<String>,
        statement: impl Into<ExactText>,
        evidence_ids: Vec<EvidenceId>,
    ) -> Result<Self, FoundationError> {
        Self::new(id, ResearchConclusionLabel::Gap, statement, evidence_ids)
    }

    pub fn is_fact(&self) -> bool {
        self.label == ResearchConclusionLabel::Fact
    }

    pub fn is_gap(&self) -> bool {
        self.label == ResearchConclusionLabel::Gap
    }

    pub fn is_recommendation(&self) -> bool {
        self.label == ResearchConclusionLabel::Recommendation
    }

    /// Compatibility accessor using the design document's evidence wording.
    pub fn evidence_references(&self) -> &[EvidenceId] {
        &self.evidence_ids
    }
}

/// A typed evidence record used by the report catalog.  Stage-owned evidence
/// references remain embedded in their original typed records as well.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportEvidenceReference {
    pub id: EvidenceId,
    pub reference: EvidenceReference,
    pub observed_text_or_digest: Availability<ExactText>,
    pub observed_at: Availability<UtcSeconds>,
}

impl ReportEvidenceReference {
    pub fn new(
        id: EvidenceId,
        reference: EvidenceReference,
        observed_text_or_digest: Availability<ExactText>,
        observed_at: Availability<UtcSeconds>,
    ) -> Self {
        Self {
            id,
            reference,
            observed_text_or_digest,
            observed_at,
        }
    }
}

/// The evidence catalog and the report-level FACT/GAP conclusions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct EvidenceCatalog {
    pub records: Vec<ReportEvidenceReference>,
    pub evidence: EvidenceSet,
    pub source_gaps: Vec<LabelledConclusion>,
    pub conclusions: Vec<LabelledConclusion>,
}

impl EvidenceCatalog {
    pub fn new(
        records: Vec<ReportEvidenceReference>,
        evidence: EvidenceSet,
        source_gaps: Vec<LabelledConclusion>,
        conclusions: Vec<LabelledConclusion>,
    ) -> Self {
        Self {
            records,
            evidence,
            source_gaps,
            conclusions,
        }
    }

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn citations(&self) -> &EvidenceSet {
        &self.evidence
    }
}

/// Run identity, input scope, and the explicit visualization exclusion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunIdentityAndScope {
    pub run_id: ExactText,
    pub scope: ExactText,
    pub snapshot: StartSnapshot,
    pub input_provenance: Availability<ExactText>,
    pub allowlist: Availability<Vec<ExactText>>,
    pub visualization_exclusion: ExactText,
    pub gaps: Vec<LabelledConclusion>,
}

impl RunIdentityAndScope {
    pub fn new(
        run_id: impl Into<String>,
        scope: impl Into<String>,
        snapshot: StartSnapshot,
        input_provenance: Availability<ExactText>,
        allowlist: Availability<Vec<ExactText>>,
    ) -> Self {
        Self {
            run_id: ExactText::new(run_id),
            scope: ExactText::new(scope),
            snapshot,
            input_provenance,
            allowlist,
            visualization_exclusion: ExactText::new(VISUALIZATION_EXCLUSION_STATEMENT),
            gaps: Vec::new(),
        }
    }

    pub fn from_snapshot(snapshot: StartSnapshot) -> Self {
        let scope = snapshot.identity.repository_root.as_str().to_owned();
        Self::new(
            "run-not-supplied",
            scope,
            snapshot,
            Availability::Unavailable,
            Availability::Unavailable,
        )
    }

    pub fn with_gaps(mut self, gaps: Vec<LabelledConclusion>) -> Self {
        self.gaps = gaps;
        self
    }

    pub fn visualization_exclusion_statement(&self) -> &str {
        self.visualization_exclusion.as_str()
    }
}

/// The four independent worktree categories plus the optional full inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkingTreeState {
    pub inventories: WorktreeInventories,
    pub worktree: Availability<WorktreeInventory>,
    pub clean: Availability<bool>,
    pub gaps: Vec<LabelledConclusion>,
}

impl WorkingTreeState {
    pub fn new(inventories: WorktreeInventories) -> Self {
        let clean = inventories.clean_fact();
        Self {
            inventories,
            worktree: Availability::Empty,
            clean,
            gaps: Vec::new(),
        }
    }

    pub fn empty() -> Self {
        Self::new(WorktreeInventories::empty())
    }

    pub fn with_worktree(mut self, worktree: WorktreeInventory) -> Self {
        self.worktree = Availability::Present(worktree);
        self
    }

    pub fn with_gaps(mut self, gaps: Vec<LabelledConclusion>) -> Self {
        self.gaps = gaps;
        self
    }
}

/// Release observations and either a selected or explicitly non-selected
/// baseline decision.  Keeping both the aggregate selection report and the
/// decision lets later audit assembly retain every candidate comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ReleaseEvidenceAndBaseline {
    pub local_evidence: Availability<LocalReleaseEvidence>,
    pub selection_report: Availability<ReleaseSelectionReport>,
    pub baseline_decision: Availability<BaselineDecision>,
    pub gaps: Vec<LabelledConclusion>,
}

impl ReleaseEvidenceAndBaseline {
    pub fn new(
        local_evidence: Availability<LocalReleaseEvidence>,
        selection_report: Availability<ReleaseSelectionReport>,
        baseline_decision: Availability<BaselineDecision>,
    ) -> Self {
        Self {
            local_evidence,
            selection_report,
            baseline_decision,
            gaps: Vec::new(),
        }
    }

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn unavailable() -> Self {
        Self {
            local_evidence: Availability::Unavailable,
            selection_report: Availability::Unavailable,
            baseline_decision: Availability::Unavailable,
            gaps: Vec::new(),
        }
    }

    pub fn with_gaps(mut self, gaps: Vec<LabelledConclusion>) -> Self {
        self.gaps = gaps;
        self
    }
}

/// The committed delta or current-only fallback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DeltaSection {
    pub report: Availability<DeltaReport>,
    pub gaps: Vec<LabelledConclusion>,
}

impl DeltaSection {
    pub fn new(report: Availability<DeltaReport>) -> Self {
        Self {
            report,
            gaps: Vec::new(),
        }
    }

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn unavailable() -> Self {
        Self {
            report: Availability::Unavailable,
            gaps: Vec::new(),
        }
    }

    pub fn with_gaps(mut self, gaps: Vec<LabelledConclusion>) -> Self {
        self.gaps = gaps;
        self
    }
}

/// The artifact candidate inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ArtifactInventorySection {
    pub inventory: Availability<ArtifactInventory>,
    pub gaps: Vec<LabelledConclusion>,
}

impl ArtifactInventorySection {
    pub fn new(inventory: Availability<ArtifactInventory>) -> Self {
        Self {
            inventory,
            gaps: Vec::new(),
        }
    }

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn unavailable() -> Self {
        Self {
            inventory: Availability::Unavailable,
            gaps: Vec::new(),
        }
    }

    pub fn with_gaps(mut self, gaps: Vec<LabelledConclusion>) -> Self {
        self.gaps = gaps;
        self
    }
}

/// Ignore proposals, tracked-file follow-ups, and the exact removal subset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct IgnoreResearchAndRemovalRegister {
    pub proposals: Availability<Vec<IgnorePatternProposal>>,
    pub untracking_follow_ups: Availability<BTreeMap<crate::RepoRelativePath, UntrackingFollowUp>>,
    pub removal_register: Availability<RemovalRegister>,
    pub gaps: Vec<LabelledConclusion>,
}

impl IgnoreResearchAndRemovalRegister {
    pub fn new(
        proposals: Availability<Vec<IgnorePatternProposal>>,
        untracking_follow_ups: Availability<BTreeMap<crate::RepoRelativePath, UntrackingFollowUp>>,
        removal_register: Availability<RemovalRegister>,
    ) -> Self {
        Self {
            proposals,
            untracking_follow_ups,
            removal_register,
            gaps: Vec::new(),
        }
    }

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn unavailable() -> Self {
        Self {
            proposals: Availability::Unavailable,
            untracking_follow_ups: Availability::Unavailable,
            removal_register: Availability::Unavailable,
            gaps: Vec::new(),
        }
    }

    pub fn with_gaps(mut self, gaps: Vec<LabelledConclusion>) -> Self {
        self.gaps = gaps;
        self
    }
}

/// Workflow inventory, README causality input, trigger results, observed runs,
/// execution filtering, and build activation policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CiInventoryAndCausality {
    pub workflows: Availability<WorkflowInventory>,
    pub readme_update: Availability<ReadmeUpdateInput>,
    pub trigger_evaluations: Availability<Vec<TriggerEvaluation>>,
    pub observed_ci_runs: Availability<Vec<crate::ObservedCiRun>>,
    pub execution_evidence: Availability<crate::ExecutionEvidence>,
    pub build_policy: Availability<BuildPolicyReport>,
    pub gaps: Vec<LabelledConclusion>,
}

impl CiInventoryAndCausality {
    pub fn new(
        workflows: Availability<WorkflowInventory>,
        readme_update: Availability<ReadmeUpdateInput>,
        trigger_evaluations: Availability<Vec<TriggerEvaluation>>,
        observed_ci_runs: Availability<Vec<crate::ObservedCiRun>>,
        execution_evidence: Availability<crate::ExecutionEvidence>,
        build_policy: Availability<BuildPolicyReport>,
    ) -> Self {
        Self {
            workflows,
            readme_update,
            trigger_evaluations,
            observed_ci_runs,
            execution_evidence,
            build_policy,
            gaps: Vec::new(),
        }
    }

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn unavailable() -> Self {
        Self {
            workflows: Availability::Unavailable,
            readme_update: Availability::Unavailable,
            trigger_evaluations: Availability::Unavailable,
            observed_ci_runs: Availability::Unavailable,
            execution_evidence: Availability::Unavailable,
            build_policy: Availability::Unavailable,
            gaps: Vec::new(),
        }
    }

    pub fn with_gaps(mut self, gaps: Vec<LabelledConclusion>) -> Self {
        self.gaps = gaps;
        self
    }
}

/// Completion integrity, validation conclusions, and the research-only
/// implementation boundary statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct IntegrityAndValidation {
    pub completion: Availability<CompletionComparison>,
    pub validation: Vec<LabelledConclusion>,
    pub no_implementation_change: ExactText,
    pub gaps: Vec<LabelledConclusion>,
}

impl IntegrityAndValidation {
    pub fn new(completion: Availability<CompletionComparison>) -> Self {
        Self {
            completion,
            validation: Vec::new(),
            no_implementation_change: ExactText::new(NO_IMPLEMENTATION_CHANGE_STATEMENT),
            gaps: Vec::new(),
        }
    }

    pub fn empty() -> Self {
        Self {
            completion: Availability::Empty,
            validation: Vec::new(),
            no_implementation_change: ExactText::new(NO_IMPLEMENTATION_CHANGE_STATEMENT),
            gaps: Vec::new(),
        }
    }

    pub fn unavailable() -> Self {
        Self {
            completion: Availability::Unavailable,
            validation: Vec::new(),
            no_implementation_change: ExactText::new(NO_IMPLEMENTATION_CHANGE_STATEMENT),
            gaps: Vec::new(),
        }
    }

    pub fn with_validation(mut self, validation: Vec<LabelledConclusion>) -> Self {
        self.validation = validation;
        self
    }

    pub fn with_gaps(mut self, gaps: Vec<LabelledConclusion>) -> Self {
        self.gaps = gaps;
        self
    }
}

/// The four and only four top-level action areas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum ActionArea {
    ArtifactRetention,
    IgnorePatterns,
    TrackedFileHandling,
    CiBuildActivation,
}

impl ActionArea {
    pub const ORDER: [Self; 4] = [
        Self::ArtifactRetention,
        Self::IgnorePatterns,
        Self::TrackedFileHandling,
        Self::CiBuildActivation,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ArtifactRetention => "ArtifactRetention",
            Self::IgnorePatterns => "IgnorePatterns",
            Self::TrackedFileHandling => "TrackedFileHandling",
            Self::CiBuildActivation => "CiBuildActivation",
        }
    }
}

/// Explicitly represents either no affected path or a deterministic path list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AffectedPathsOrNone {
    NoneAffected,
    Paths(Vec<crate::RepoRelativePath>),
}

impl AffectedPathsOrNone {
    pub const fn none() -> Self {
        Self::NoneAffected
    }

    pub fn paths(mut paths: Vec<crate::RepoRelativePath>) -> Result<Self, FoundationError> {
        if paths.is_empty() {
            return Err(invalid(
                "affected_paths_or_none",
                "an empty path list must use NoneAffected",
            ));
        }
        paths.sort();
        paths.dedup();
        Ok(Self::Paths(paths))
    }

    pub fn is_none(&self) -> bool {
        matches!(self, Self::NoneAffected)
    }

    pub fn as_paths(&self) -> Option<&[crate::RepoRelativePath]> {
        match self {
            Self::NoneAffected => None,
            Self::Paths(paths) => Some(paths.as_slice()),
        }
    }
}

/// One complete top-level action recommendation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActionRecommendation {
    pub priority: u8,
    pub action_area: ActionArea,
    pub statement: LabelledConclusion,
    pub supporting_citations: Vec<EvidenceId>,
    pub affected_paths_or_none: AffectedPathsOrNone,
    pub risk: ExactText,
    pub verification_method: ExactText,
}

impl<'de> Deserialize<'de> for ActionRecommendation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            priority: u8,
            action_area: ActionArea,
            statement: LabelledConclusion,
            supporting_citations: Vec<EvidenceId>,
            affected_paths_or_none: AffectedPathsOrNone,
            risk: ExactText,
            verification_method: ExactText,
        }

        let wire = Wire::deserialize(deserializer)?;
        Self::new(
            wire.priority,
            wire.action_area,
            wire.statement,
            wire.supporting_citations,
            wire.affected_paths_or_none,
            wire.risk,
            wire.verification_method,
        )
        .map_err(serde::de::Error::custom)
    }
}

impl ActionRecommendation {
    pub fn new(
        priority: u8,
        action_area: ActionArea,
        statement: LabelledConclusion,
        supporting_citations: Vec<EvidenceId>,
        affected_paths_or_none: AffectedPathsOrNone,
        risk: impl Into<ExactText>,
        verification_method: impl Into<ExactText>,
    ) -> Result<Self, FoundationError> {
        if !(1..=4).contains(&priority) {
            return Err(invalid(
                "action_priority",
                "top-level action priorities must be in the range 1..=4",
            ));
        }
        if statement.label != ResearchConclusionLabel::Recommendation {
            return Err(invalid(
                "action_statement",
                "an action statement must use the Recommendation label",
            ));
        }
        if supporting_citations.is_empty() {
            return Err(invalid(
                "supporting_citations",
                "an action needs at least one supporting FACT or GAP ID",
            ));
        }
        let mut seen = BTreeSet::new();
        for citation in &supporting_citations {
            if !seen.insert(citation) {
                return Err(invalid(
                    "supporting_citations",
                    "supporting FACT/GAP IDs may not repeat",
                ));
            }
        }
        if let AffectedPathsOrNone::Paths(paths) = &affected_paths_or_none {
            if paths.is_empty() {
                return Err(invalid(
                    "affected_paths_or_none",
                    "an empty path list must use NoneAffected",
                ));
            }
            if paths.windows(2).any(|window| window[0] >= window[1]) {
                return Err(invalid(
                    "affected_paths_or_none",
                    "affected paths must be sorted and unique",
                ));
            }
        }
        let risk = risk.into();
        let verification_method = verification_method.into();
        validate_bounded_non_empty("action_risk", &risk, MAX_ACTION_TEXT)?;
        validate_bounded_non_empty("verification_method", &verification_method, MAX_ACTION_TEXT)?;
        Ok(Self {
            priority,
            action_area,
            statement,
            supporting_citations,
            affected_paths_or_none,
            risk,
            verification_method,
        })
    }

    pub fn area(&self) -> ActionArea {
        self.action_area
    }

    pub fn affected_paths(&self) -> Option<&[crate::RepoRelativePath]> {
        self.affected_paths_or_none.as_paths()
    }
}

/// All typed inputs needed to assemble a report.  The later audit stage can
/// fill this value directly from its stage results without passing through JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchReportParts {
    pub run_identity_and_scope: RunIdentityAndScope,
    pub working_tree_state: WorkingTreeState,
    pub evidence_catalog: EvidenceCatalog,
    pub release_evidence_and_baseline: ReleaseEvidenceAndBaseline,
    pub delta: DeltaSection,
    pub artifact_inventory: ArtifactInventorySection,
    pub ignore_research_and_removal_register: IgnoreResearchAndRemovalRegister,
    pub ci_inventory_and_causality: CiInventoryAndCausality,
    pub action_recommendations: Vec<ActionRecommendation>,
    pub integrity_and_validation: IntegrityAndValidation,
}

impl ResearchReportParts {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        run_identity_and_scope: RunIdentityAndScope,
        working_tree_state: WorkingTreeState,
        evidence_catalog: EvidenceCatalog,
        release_evidence_and_baseline: ReleaseEvidenceAndBaseline,
        delta: DeltaSection,
        artifact_inventory: ArtifactInventorySection,
        ignore_research_and_removal_register: IgnoreResearchAndRemovalRegister,
        ci_inventory_and_causality: CiInventoryAndCausality,
        action_recommendations: Vec<ActionRecommendation>,
        integrity_and_validation: IntegrityAndValidation,
    ) -> Self {
        Self {
            run_identity_and_scope,
            working_tree_state,
            evidence_catalog,
            release_evidence_and_baseline,
            delta,
            artifact_inventory,
            ignore_research_and_removal_register,
            ci_inventory_and_causality,
            action_recommendations,
            integrity_and_validation,
        }
    }
}

/// The one typed report model used by both renderers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResearchReport {
    pub schema_version: ExactText,
    pub run_identity_and_scope: RunIdentityAndScope,
    pub working_tree_state: WorkingTreeState,
    pub evidence_catalog: EvidenceCatalog,
    pub release_evidence_and_baseline: ReleaseEvidenceAndBaseline,
    pub delta: DeltaSection,
    pub artifact_inventory: ArtifactInventorySection,
    pub ignore_research_and_removal_register: IgnoreResearchAndRemovalRegister,
    pub ci_inventory_and_causality: CiInventoryAndCausality,
    pub action_recommendations: Vec<ActionRecommendation>,
    pub integrity_and_validation: IntegrityAndValidation,
}

impl<'de> Deserialize<'de> for ResearchReport {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            schema_version: ExactText,
            run_identity_and_scope: RunIdentityAndScope,
            working_tree_state: WorkingTreeState,
            evidence_catalog: EvidenceCatalog,
            release_evidence_and_baseline: ReleaseEvidenceAndBaseline,
            delta: DeltaSection,
            artifact_inventory: ArtifactInventorySection,
            ignore_research_and_removal_register: IgnoreResearchAndRemovalRegister,
            ci_inventory_and_causality: CiInventoryAndCausality,
            action_recommendations: Vec<ActionRecommendation>,
            integrity_and_validation: IntegrityAndValidation,
        }

        let wire = Wire::deserialize(deserializer)?;
        let report = Self {
            schema_version: wire.schema_version,
            run_identity_and_scope: wire.run_identity_and_scope,
            working_tree_state: wire.working_tree_state,
            evidence_catalog: wire.evidence_catalog,
            release_evidence_and_baseline: wire.release_evidence_and_baseline,
            delta: wire.delta,
            artifact_inventory: wire.artifact_inventory,
            ignore_research_and_removal_register: wire.ignore_research_and_removal_register,
            ci_inventory_and_causality: wire.ci_inventory_and_causality,
            action_recommendations: wire.action_recommendations,
            integrity_and_validation: wire.integrity_and_validation,
        };
        report.validate().map_err(serde::de::Error::custom)?;
        Ok(report)
    }
}

impl ResearchReport {
    pub fn new(parts: ResearchReportParts) -> Result<Self, FoundationError> {
        let mut action_recommendations = parts.action_recommendations;
        action_recommendations.sort_by(|left, right| {
            left.priority
                .cmp(&right.priority)
                .then_with(|| left.action_area.cmp(&right.action_area))
        });
        let report = Self {
            schema_version: ExactText::new(RESEARCH_REPORT_SCHEMA_VERSION),
            run_identity_and_scope: parts.run_identity_and_scope,
            working_tree_state: parts.working_tree_state,
            evidence_catalog: parts.evidence_catalog,
            release_evidence_and_baseline: parts.release_evidence_and_baseline,
            delta: parts.delta,
            artifact_inventory: parts.artifact_inventory,
            ignore_research_and_removal_register: parts.ignore_research_and_removal_register,
            ci_inventory_and_causality: parts.ci_inventory_and_causality,
            action_recommendations,
            integrity_and_validation: parts.integrity_and_validation,
        };
        report.validate()?;
        Ok(report)
    }

    pub fn from_parts(parts: ResearchReportParts) -> Result<Self, FoundationError> {
        Self::new(parts)
    }

    pub fn validate(&self) -> Result<(), FoundationError> {
        if self.schema_version.as_str() != RESEARCH_REPORT_SCHEMA_VERSION {
            return Err(invalid(
                "schema_version",
                "unsupported research report schema version",
            ));
        }
        if self.run_identity_and_scope.visualization_exclusion.as_str()
            != VISUALIZATION_EXCLUSION_STATEMENT
        {
            return Err(invalid(
                "visualization_exclusion",
                "the fixed visualization exclusion statement is required",
            ));
        }
        if self
            .integrity_and_validation
            .no_implementation_change
            .as_str()
            != NO_IMPLEMENTATION_CHANGE_STATEMENT
        {
            return Err(invalid(
                "no_implementation_change",
                "the fixed research-only integrity statement is required",
            ));
        }
        let serialized =
            serde_json::to_string(self).map_err(|error| serialization(error.to_string()))?;
        if contains_visualization_identifier(&serialized) {
            return Err(invalid(
                "visualization_scope",
                "approved visualization URLs and source identifiers are excluded",
            ));
        }

        validate_gap_collection("evidence_source_gaps", &self.evidence_catalog.source_gaps)?;
        validate_gap_collection("run_identity_gaps", &self.run_identity_and_scope.gaps)?;
        validate_gap_collection("worktree_gaps", &self.working_tree_state.gaps)?;
        validate_gap_collection("release_gaps", &self.release_evidence_and_baseline.gaps)?;
        validate_gap_collection("delta_gaps", &self.delta.gaps)?;
        validate_gap_collection("artifact_gaps", &self.artifact_inventory.gaps)?;
        validate_gap_collection(
            "ignore_gaps",
            &self.ignore_research_and_removal_register.gaps,
        )?;
        validate_gap_collection("ci_gaps", &self.ci_inventory_and_causality.gaps)?;
        validate_gap_collection("integrity_gaps", &self.integrity_and_validation.gaps)?;

        let evidence_ids = self.evidence_ids()?;
        let conclusions = self.conclusions()?;
        for conclusion in conclusions.values() {
            validate_conclusion_shape(conclusion)?;
            for evidence_id in &conclusion.evidence_ids {
                if !evidence_ids.contains(evidence_id) {
                    return Err(invalid(
                        "conclusion_evidence",
                        format!(
                            "conclusion `{}` references unknown evidence ID `{evidence_id}`",
                            conclusion.id
                        ),
                    ));
                }
            }
        }
        self.validate_actions(&conclusions, &evidence_ids)?;
        Ok(())
    }

    fn evidence_ids(&self) -> Result<BTreeSet<EvidenceId>, FoundationError> {
        let mut ids = BTreeSet::new();
        for record in &self.evidence_catalog.records {
            if !ids.insert(record.id.clone()) {
                return Err(invalid(
                    "evidence_catalog",
                    format!("duplicate evidence ID `{}`", record.id),
                ));
            }
        }
        for citation in &self.evidence_catalog.evidence.citations {
            if !ids.insert(citation.id.clone()) {
                return Err(invalid(
                    "evidence_catalog",
                    format!("duplicate evidence ID `{}`", citation.id),
                ));
            }
        }
        Ok(ids)
    }

    fn conclusions(&self) -> Result<BTreeMap<EvidenceId, LabelledConclusion>, FoundationError> {
        let mut conclusions = BTreeMap::new();
        let mut add = |conclusion: &LabelledConclusion| -> Result<(), FoundationError> {
            if conclusions
                .insert(conclusion.id.clone(), conclusion.clone())
                .is_some()
            {
                return Err(invalid(
                    "conclusions",
                    format!("duplicate conclusion ID `{}`", conclusion.id),
                ));
            }
            Ok(())
        };

        for conclusion in &self.evidence_catalog.source_gaps {
            add(conclusion)?;
        }
        for conclusion in &self.evidence_catalog.conclusions {
            add(conclusion)?;
        }
        for conclusion in &self.run_identity_and_scope.gaps {
            add(conclusion)?;
        }
        for conclusion in &self.working_tree_state.gaps {
            add(conclusion)?;
        }
        for conclusion in &self.release_evidence_and_baseline.gaps {
            add(conclusion)?;
        }
        for conclusion in &self.delta.gaps {
            add(conclusion)?;
        }
        for conclusion in &self.artifact_inventory.gaps {
            add(conclusion)?;
        }
        for conclusion in &self.ignore_research_and_removal_register.gaps {
            add(conclusion)?;
        }
        for conclusion in &self.ci_inventory_and_causality.gaps {
            add(conclusion)?;
        }
        for conclusion in &self.integrity_and_validation.validation {
            add(conclusion)?;
        }
        for conclusion in &self.integrity_and_validation.gaps {
            add(conclusion)?;
        }
        Ok(conclusions)
    }

    fn validate_actions(
        &self,
        conclusions: &BTreeMap<EvidenceId, LabelledConclusion>,
        evidence_ids: &BTreeSet<EvidenceId>,
    ) -> Result<(), FoundationError> {
        if self.action_recommendations.len() != 4 {
            return Err(invalid(
                "action_recommendations",
                "a research report requires exactly four top-level actions",
            ));
        }
        let mut priorities = BTreeSet::new();
        let mut areas = BTreeSet::new();
        let mut action_ids = BTreeSet::new();
        for (index, action) in self.action_recommendations.iter().enumerate() {
            if action.priority != (index as u8 + 1) {
                return Err(invalid(
                    "action_priority",
                    "top-level actions must be ordered with priorities 1 through 4",
                ));
            }
            if !priorities.insert(action.priority) || !areas.insert(action.action_area) {
                return Err(invalid(
                    "action_recommendations",
                    "top-level action priorities and areas must be unique",
                ));
            }
            if action.action_area != ActionArea::ORDER[index] {
                return Err(invalid(
                    "action_area",
                    "top-level action areas are not in the required order",
                ));
            }
            validate_conclusion_shape(&action.statement)?;
            for evidence_id in &action.statement.evidence_ids {
                if !evidence_ids.contains(evidence_id) {
                    return Err(invalid(
                        "action_statement_evidence",
                        format!(
                            "action statement `{}` references unknown evidence ID `{evidence_id}`",
                            action.statement.id
                        ),
                    ));
                }
            }
            if !action_ids.insert(action.statement.id.clone())
                || conclusions.contains_key(&action.statement.id)
            {
                return Err(invalid(
                    "action_statement",
                    format!("duplicate action conclusion ID `{}`", action.statement.id),
                ));
            }
            if !action.statement.is_recommendation() {
                return Err(invalid(
                    "action_statement",
                    "top-level action statements must be recommendations",
                ));
            }
            let mut supporting_ids = BTreeSet::new();
            for supporting_id in &action.supporting_citations {
                if !supporting_ids.insert(supporting_id) {
                    return Err(invalid(
                        "supporting_citations",
                        "supporting FACT/GAP IDs may not repeat",
                    ));
                }
                let Some(conclusion) = conclusions.get(supporting_id) else {
                    return Err(invalid(
                        "supporting_citations",
                        format!("unknown FACT/GAP conclusion ID `{supporting_id}`"),
                    ));
                };
                if !conclusion.is_fact() && !conclusion.is_gap() {
                    return Err(invalid(
                        "supporting_citations",
                        format!("supporting ID `{supporting_id}` is not a FACT or GAP"),
                    ));
                }
            }
            if let AffectedPathsOrNone::Paths(paths) = &action.affected_paths_or_none {
                if paths.is_empty() || paths.windows(2).any(|window| window[0] >= window[1]) {
                    return Err(invalid(
                        "affected_paths_or_none",
                        "affected paths must be non-empty, sorted, and unique",
                    ));
                }
            }
            validate_bounded_non_empty("action_risk", &action.risk, MAX_ACTION_TEXT)?;
            validate_bounded_non_empty(
                "verification_method",
                &action.verification_method,
                MAX_ACTION_TEXT,
            )?;
        }
        Ok(())
    }

    /// Render the exact ten-section Markdown view of this report.
    pub fn render_markdown(&self) -> String {
        let mut output = String::from("# Release Checkpoint Research\n\n");
        append_section(
            &mut output,
            RESEARCH_REPORT_SECTION_HEADINGS[0],
            format!(
                "- run_id: `{}`\n- scope: `{}`\n- snapshot: {}\n- input_provenance: {}\n- allowlist: {}\n- visualization exclusion: {}\n\n{}",
                self.run_identity_and_scope.run_id,
                self.run_identity_and_scope.scope,
                "Present",
                availability_state(&self.run_identity_and_scope.input_provenance),
                availability_state(&self.run_identity_and_scope.allowlist),
                self.run_identity_and_scope.visualization_exclusion,
                json_block(&self.run_identity_and_scope),
            ),
        );
        append_section(
            &mut output,
            RESEARCH_REPORT_SECTION_HEADINGS[1],
            format!(
                "- staged: {}\n- unstaged: {}\n- untracked: {}\n- ignored: {}\n- clean: {}\n- full worktree inventory: {}\n\n{}",
                availability_state(&self.working_tree_state.inventories.staged),
                availability_state(&self.working_tree_state.inventories.unstaged),
                availability_state(&self.working_tree_state.inventories.untracked),
                availability_state(&self.working_tree_state.inventories.ignored),
                availability_state(&self.working_tree_state.clean),
                availability_state(&self.working_tree_state.worktree),
                json_block(&self.working_tree_state),
            ),
        );
        append_section(
            &mut output,
            RESEARCH_REPORT_SECTION_HEADINGS[2],
            format!(
                "- evidence records: {}\n- citations: {}\n- source gaps: {}\n- conclusions: {}\n\n{}",
                collection_state(&self.evidence_catalog.records),
                collection_state(&self.evidence_catalog.evidence.citations),
                collection_state(&self.evidence_catalog.source_gaps),
                collection_state(&self.evidence_catalog.conclusions),
                json_block(&self.evidence_catalog),
            ),
        );
        append_section(
            &mut output,
            RESEARCH_REPORT_SECTION_HEADINGS[3],
            format!(
                "- local evidence: {}\n- selection report: {}\n- baseline decision: {}\n- gaps: {}\n\n{}",
                availability_state(&self.release_evidence_and_baseline.local_evidence),
                availability_state(&self.release_evidence_and_baseline.selection_report),
                availability_state(&self.release_evidence_and_baseline.baseline_decision),
                collection_state(&self.release_evidence_and_baseline.gaps),
                json_block(&self.release_evidence_and_baseline),
            ),
        );
        append_section(
            &mut output,
            RESEARCH_REPORT_SECTION_HEADINGS[4],
            format!(
                "- delta report: {}\n- gaps: {}\n\n{}",
                availability_state(&self.delta.report),
                collection_state(&self.delta.gaps),
                json_block(&self.delta),
            ),
        );
        append_section(
            &mut output,
            RESEARCH_REPORT_SECTION_HEADINGS[5],
            format!(
                "- artifact inventory: {}\n- gaps: {}\n\n{}",
                availability_state(&self.artifact_inventory.inventory),
                collection_state(&self.artifact_inventory.gaps),
                json_block(&self.artifact_inventory),
            ),
        );
        append_section(
            &mut output,
            RESEARCH_REPORT_SECTION_HEADINGS[6],
            format!(
                "- ignore proposals: {}\n- untracking follow-ups: {}\n- removal register: {}\n- gaps: {}\n\n{}",
                availability_state(&self.ignore_research_and_removal_register.proposals),
                availability_state(
                    &self
                        .ignore_research_and_removal_register
                        .untracking_follow_ups
                ),
                availability_state(
                    &self
                        .ignore_research_and_removal_register
                        .removal_register
                ),
                collection_state(&self.ignore_research_and_removal_register.gaps),
                json_block(&self.ignore_research_and_removal_register),
            ),
        );
        append_section(
            &mut output,
            RESEARCH_REPORT_SECTION_HEADINGS[7],
            format!(
                "- workflows: {}\n- README update: {}\n- trigger evaluations: {}\n- observed CI runs: {}\n- execution evidence: {}\n- build policy: {}\n- gaps: {}\n\n{}",
                availability_state(&self.ci_inventory_and_causality.workflows),
                availability_state(&self.ci_inventory_and_causality.readme_update),
                availability_state(&self.ci_inventory_and_causality.trigger_evaluations),
                availability_state(&self.ci_inventory_and_causality.observed_ci_runs),
                availability_state(&self.ci_inventory_and_causality.execution_evidence),
                availability_state(&self.ci_inventory_and_causality.build_policy),
                collection_state(&self.ci_inventory_and_causality.gaps),
                json_block(&self.ci_inventory_and_causality),
            ),
        );
        append_section(
            &mut output,
            RESEARCH_REPORT_SECTION_HEADINGS[8],
            format!(
                "- ordered entries: {}\n\n{}",
                self.action_recommendations.len(),
                json_block(&self.action_recommendations),
            ),
        );
        append_section(
            &mut output,
            RESEARCH_REPORT_SECTION_HEADINGS[9],
            format!(
                "- completion comparison: {}\n- validation conclusions: {}\n- gaps: {}\n- no implementation change: {}\n\n{}",
                availability_state(&self.integrity_and_validation.completion),
                collection_state(&self.integrity_and_validation.validation),
                collection_state(&self.integrity_and_validation.gaps),
                self.integrity_and_validation.no_implementation_change,
                json_block(&self.integrity_and_validation),
            ),
        );
        output
    }

    /// Serialize this exact typed report as deterministic pretty JSON.
    pub fn render_json(&self) -> Result<String, FoundationError> {
        self.validate()?;
        serde_json::to_string_pretty(self).map_err(|error| serialization(error.to_string()))
    }

    pub fn serialize_json(&self) -> Result<String, FoundationError> {
        self.render_json()
    }
}

fn validate_conclusion_shape(conclusion: &LabelledConclusion) -> Result<(), FoundationError> {
    if conclusion.id.as_str().is_empty() {
        return Err(invalid("conclusion_id", "conclusion IDs must be non-empty"));
    }
    if conclusion.statement.as_str().trim().is_empty() {
        return Err(invalid(
            "conclusion_statement",
            "value must contain non-whitespace text",
        ));
    }
    let mut ids = BTreeSet::new();
    for evidence_id in &conclusion.evidence_ids {
        if !ids.insert(evidence_id) {
            return Err(invalid(
                "conclusion_evidence",
                "a conclusion cannot repeat an evidence ID",
            ));
        }
    }
    if matches!(
        conclusion.label,
        ResearchConclusionLabel::Fact | ResearchConclusionLabel::Gap
    ) && conclusion.evidence_ids.is_empty()
    {
        return Err(invalid(
            "conclusion_evidence",
            "FACT and GAP conclusions require evidence",
        ));
    }
    Ok(())
}

fn validate_gap_collection(
    field: &'static str,
    gaps: &[LabelledConclusion],
) -> Result<(), FoundationError> {
    for gap in gaps {
        validate_conclusion_shape(gap)?;
        if !gap.is_gap() {
            return Err(invalid(field, "a named gap must use the GAP label"));
        }
    }
    Ok(())
}

fn contains_visualization_identifier(serialized: &str) -> bool {
    let lower = serialized.to_ascii_lowercase();
    lower.contains("masihmoafi") && lower.contains("projects/elpis")
}

fn availability_state<T>(value: &Availability<T>) -> &'static str {
    match value {
        Availability::Empty => "Empty",
        Availability::Unavailable => "Unavailable",
        Availability::Present(_) => "Present",
    }
}

fn collection_state<T>(values: &[T]) -> &'static str {
    if values.is_empty() {
        "Empty"
    } else {
        "Present"
    }
}

fn json_block<T: Serialize>(value: &T) -> String {
    let json = serde_json::to_string_pretty(value).expect("typed report values serialize");
    format!("```json\n{json}\n```")
}

fn append_section(output: &mut String, heading: &str, body: String) {
    output.push_str("## ");
    output.push_str(heading);
    output.push_str("\n");
    output.push_str(&body);
    if !body.ends_with('\n') {
        output.push('\n');
    }
    output.push('\n');
}

/// Assemble and validate one report from typed stage results.
pub fn assemble_research_report(
    parts: ResearchReportParts,
) -> Result<ResearchReport, FoundationError> {
    ResearchReport::new(parts)
}

/// Compatibility alias for later audit assembly.
pub fn assemble_report(parts: ResearchReportParts) -> Result<ResearchReport, FoundationError> {
    assemble_research_report(parts)
}

/// Render Markdown from the typed report model.
pub fn render_markdown(report: &ResearchReport) -> String {
    report.render_markdown()
}

/// Render JSON from the typed report model.
pub fn render_json(report: &ResearchReport) -> Result<String, FoundationError> {
    report.render_json()
}

/// Compatibility alias for callers that name the operation explicitly.
pub fn serialize_json(report: &ResearchReport) -> Result<String, FoundationError> {
    report.serialize_json()
}

pub type ResearchReportModel = ResearchReport;
pub type ReportParts = ResearchReportParts;
pub type FactGapConclusion = LabelledConclusion;
pub type NamedGap = LabelledConclusion;
pub type ActionPlanEntry = ActionRecommendation;
pub type AffectedPaths = AffectedPathsOrNone;
pub type IdentityAndScope = RunIdentityAndScope;
pub type WorktreeState = WorkingTreeState;
pub type ReleaseSection = ReleaseEvidenceAndBaseline;
pub type ArtifactSection = ArtifactInventorySection;
pub type IgnoreSection = IgnoreResearchAndRemovalRegister;
pub type CiSection = CiInventoryAndCausality;
pub type IntegritySection = IntegrityAndValidation;

/// Validate a report at the audit-stage boundary before publication.
pub fn validate_report(report: &ResearchReport) -> Result<(), FoundationError> {
    report.validate()
}

/// Compatibility spelling for Markdown callers.
pub fn render_report_markdown(report: &ResearchReport) -> String {
    render_markdown(report)
}

/// Compatibility spelling for JSON callers.
pub fn render_report_json(report: &ResearchReport) -> Result<String, FoundationError> {
    render_json(report)
}

pub type ResearchReportBuilder = ResearchReportParts;
