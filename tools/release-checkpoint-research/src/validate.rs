//! Strict report validation and the final artifact-directory publication boundary.
//!
//! The report assembler intentionally permits explicit `Empty` and `Unavailable`
//! observations while collection is in progress.  This module is the last gate:
//! it rejects malformed typed values, unsafe boundary claims, and unresolved
//! recommendations before a renderer is used for publication.  Publication is
//! implemented here rather than by the legacy direct writer so temporary files
//! never leave the research artifact directory.

use crate::{
    is_visualization_path, ActionArea, ActionDependencyClassification, AffectedPathsOrNone,
    ArtifactStatus, Availability, BuildExtraction, BuildPolicyReport, CheckoutState,
    CiInventoryAndCausality, CompletionComparison, CompletionStatus, ConditionEvaluation,
    ConsumerResult, EvidenceCitation, EvidenceId, EvidenceLocator, EvidenceReference,
    EvidenceReferenceLocator, ExactText, Fingerprint, FoundationError, FullId,
    IgnorePatternProposal, InclusiveSpan, LabelledConclusion, PrimaryClassification,
    ProducerDiscovery, RemovalRegister, RepoRelativePath, ReportOutput, ResearchConclusionLabel,
    ResearchReport, RetentionRecommendation, StartSnapshot, TriggerEvaluation, UntrackingFollowUp,
    WorkflowClassification, WorkflowEvent, WorkflowInventory, WorkflowRecord,
    WorkflowTriggerInventory, WorktreePathObservation, ARTIFACT_DIRECTORY,
    NO_IMPLEMENTATION_CHANGE_STATEMENT, NO_OBSERVED_RUN_GAP, RESEARCH_REPORT_SCHEMA_VERSION,
    RESEARCH_REPORT_SECTION_HEADINGS, VISUALIZATION_EXCLUSION_STATEMENT,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

/// One stable, human-readable validation reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportValidationError {
    /// Reasons are ordered by the report traversal, making failures stable and
    /// useful in tests and in an audit log.
    pub reasons: Vec<String>,
}

impl ReportValidationError {
    pub fn new(reasons: Vec<String>) -> Self {
        Self { reasons }
    }

    pub fn single(reason: impl Into<String>) -> Self {
        Self {
            reasons: vec![reason.into()],
        }
    }

    pub fn reasons(&self) -> &[String] {
        &self.reasons
    }

    /// Compatibility accessor for callers that describe reasons as errors.
    pub fn errors(&self) -> &[String] {
        &self.reasons
    }

    pub fn is_empty(&self) -> bool {
        self.reasons.is_empty()
    }

    pub fn len(&self) -> usize {
        self.reasons.len()
    }

    pub fn contains(&self, text: &str) -> bool {
        self.reasons.iter().any(|reason| reason.contains(text))
    }
}

impl fmt::Display for ReportValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.reasons.is_empty() {
            return formatter.write_str("research report validation failed");
        }
        formatter.write_str("research report validation failed: ")?;
        for (index, reason) in self.reasons.iter().enumerate() {
            if index != 0 {
                formatter.write_str("; ")?;
            }
            formatter.write_str(reason)?;
        }
        Ok(())
    }
}

impl std::error::Error for ReportValidationError {}

/// Errors raised while validating, staging, or atomically publishing a report.
#[derive(Debug)]
pub enum ReportPublicationError {
    Validation(ReportValidationError),
    Foundation(FoundationError),
    Integrity(String),
    Boundary(String),
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl fmt::Display for ReportPublicationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(error) => error.fmt(formatter),
            Self::Foundation(error) => error.fmt(formatter),
            Self::Integrity(reason) => write!(formatter, "report integrity check failed: {reason}"),
            Self::Boundary(reason) => write!(formatter, "unsafe report boundary: {reason}"),
            Self::Io { operation, source } => write!(formatter, "{operation}: {source}"),
        }
    }
}

impl std::error::Error for ReportPublicationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Validation(error) => Some(error),
            Self::Foundation(error) => Some(error),
            Self::Io { source, .. } => Some(source),
            Self::Integrity(_) | Self::Boundary(_) => None,
        }
    }
}

impl From<ReportValidationError> for ReportPublicationError {
    fn from(error: ReportValidationError) -> Self {
        Self::Validation(error)
    }
}

impl From<FoundationError> for ReportPublicationError {
    fn from(error: FoundationError) -> Self {
        Self::Foundation(error)
    }
}

/// The result of an in-artifact publication.  The report is derived once and
/// both output paths are fixed by the foundation `ReportOutput` enum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResearchReportPublication {
    pub markdown: crate::PublishedReport,
    pub json: Option<crate::PublishedReport>,
    pub completion: CompletionComparison,
}

/// Compatibility name for callers that prefer the shorter publication name.
pub type AtomicReportPublication = ResearchReportPublication;

/// Validate the complete typed report before rendering or publication.
///
/// Explicit `Empty` stage values are accepted because they mean that an
/// inspected source contained no records (or that assembly has not supplied a
/// stage yet).  A completion `Unavailable` or `Failed` value is never accepted;
/// `Empty` is a non-claim and is filled with a fresh verified comparison by the
/// atomic writer.  Call [`validate_research_report_for_publication`] when a
/// caller needs a report that already carries a completion claim.
pub fn validate_research_report(report: &ResearchReport) -> Result<(), ReportValidationError> {
    let mut validator = Validator::default();
    validator.validate(report);
    validator.finish()
}

/// Validate a report that is ready to be rendered as a final user-visible
/// artifact.  A final rendering must carry a verified no-change comparison.
pub fn validate_research_report_for_publication(
    report: &ResearchReport,
) -> Result<(), ReportValidationError> {
    validate_research_report(report)?;
    let mut validator = Validator::default();
    validator.validate_completion_claim(&report.integrity_and_validation.completion);
    validator.require_verified_completion(
        &report.integrity_and_validation.completion,
        "integrity_and_validation.completion",
    );
    validator.finish()
}

/// Render Markdown only after strict report and completion validation.
pub fn render_validated_markdown(report: &ResearchReport) -> Result<String, ReportValidationError> {
    validate_research_report_for_publication(report)?;
    let rendered = report.render_markdown();
    validate_rendered_headings(&rendered).map_err(ReportValidationError::single)?;
    Ok(rendered)
}

/// Render JSON only after strict report and completion validation.
pub fn render_validated_json(report: &ResearchReport) -> Result<String, ReportValidationError> {
    validate_research_report_for_publication(report)?;
    serde_json::to_string_pretty(report)
        .map_err(|error| ReportValidationError::single(format!("JSON rendering failed: {error}")))
}

/// Compatibility aliases for callers that name the operation after the report.
pub fn render_research_report_markdown(
    report: &ResearchReport,
) -> Result<String, ReportValidationError> {
    render_validated_markdown(report)
}

pub fn render_research_report_json(
    report: &ResearchReport,
) -> Result<String, ReportValidationError> {
    render_validated_json(report)
}

/// Validate, compare completion integrity, and publish the Markdown report plus
/// an optional JSON companion using in-directory temporary files and rename.
///
/// No filesystem path is opened until report validation and the first fresh
/// completion comparison have succeeded.  The report is cloned so the writer
/// can attach the comparison it actually verified without mutating the caller's
/// assembled model.
pub fn write_research_reports_atomically(
    session: &crate::AuditSession,
    report: &ResearchReport,
    include_json: bool,
) -> Result<ResearchReportPublication, ReportPublicationError> {
    validate_research_report(report)?;

    let first_completion = stable_completion(session, false)?;
    ensure_verified_completion(&first_completion)?;

    let mut published_report = report.clone();
    published_report.integrity_and_validation.completion =
        Availability::Present(first_completion.clone());
    validate_research_report_for_publication(&published_report)?;

    // Recheck immediately before opening any temporary output.  This closes the
    // interval between the first comparison and rendering/serialization.
    let before_stage = stable_completion(session, false)?;
    ensure_verified_completion(&before_stage)?;
    published_report.integrity_and_validation.completion =
        Availability::Present(before_stage.clone());
    validate_research_report_for_publication(&published_report)?;
    let markdown = published_report.render_markdown();
    let json = if include_json {
        Some(
            serde_json::to_string_pretty(&published_report).map_err(|error| {
                ReportValidationError::single(format!("JSON rendering failed: {error}"))
            })?,
        )
    } else {
        None
    };

    let (artifact, artifact_ancestors_created) = prepare_artifact_directory(session)?;
    let markdown_temp = stage_temporary_file(&artifact, markdown.as_bytes(), "md")?;
    let json_temp = match json.as_deref() {
        Some(contents) => match stage_temporary_file(&artifact, contents.as_bytes(), "json") {
            Ok(path) => Some(path),
            Err(error) => {
                remove_if_regular_temp(&markdown_temp);
                return Err(error);
            }
        },
        None => None,
    };

    let before_rename = stable_completion(session, artifact_ancestors_created)?;
    if let Err(error) = ensure_verified_completion(&before_rename) {
        remove_if_regular_temp(&markdown_temp);
        if let Some(path) = &json_temp {
            remove_if_regular_temp(path);
        }
        return Err(error);
    }

    let markdown_path = artifact.join(ReportOutput::ResearchReportMarkdown.filename());
    let json_path = artifact.join(ReportOutput::ResearchReportJson.filename());
    if let Err(error) = validate_final_output_path(&artifact, &markdown_path) {
        remove_if_regular_temp(&markdown_temp);
        if let Some(path) = &json_temp {
            remove_if_regular_temp(path);
        }
        return Err(error);
    }
    if let Some(path) = &json_temp {
        if let Err(error) = validate_final_output_path(&artifact, &json_path) {
            remove_if_regular_temp(&markdown_temp);
            remove_if_regular_temp(path);
            return Err(error);
        }
    }

    let markdown_result = atomic_rename(&markdown_temp, &markdown_path);
    if let Err(error) = markdown_result {
        remove_if_regular_temp(&markdown_temp);
        if let Some(path) = &json_temp {
            remove_if_regular_temp(path);
        }
        return Err(error);
    }

    let json_publication = if let Some(path) = json_temp {
        if let Err(error) = atomic_rename(&path, &json_path) {
            // The Markdown rename is already an atomic, permitted publication;
            // do not remove an unrelated existing file or claim the JSON exists.
            remove_if_regular_temp(&path);
            return Err(error);
        }
        Some(crate::PublishedReport {
            output: ReportOutput::ResearchReportJson,
            path: absolute_path(&json_path)?,
            bytes_written: json.as_ref().map_or(0, |text| text.len() as u64),
        })
    } else {
        None
    };

    sync_directory(&artifact)?;
    let completion = before_rename;
    Ok(ResearchReportPublication {
        markdown: crate::PublishedReport {
            output: ReportOutput::ResearchReportMarkdown,
            path: absolute_path(&markdown_path)?,
            bytes_written: markdown.len() as u64,
        },
        json: json_publication,
        completion,
    })
}

/// A convenience spelling for a single Markdown-only publication.
pub fn write_research_report_atomically(
    session: &crate::AuditSession,
    report: &ResearchReport,
) -> Result<ResearchReportPublication, ReportPublicationError> {
    write_research_reports_atomically(session, report, false)
}

#[derive(Default)]
struct Validator {
    reasons: Vec<String>,
    evidence_ids: BTreeSet<EvidenceId>,
    conclusions: BTreeMap<EvidenceId, ResearchConclusionLabel>,
    fact_gap_ids: BTreeSet<EvidenceId>,
}

impl Validator {
    fn finish(self) -> Result<(), ReportValidationError> {
        if self.reasons.is_empty() {
            Ok(())
        } else {
            Err(ReportValidationError::new(self.reasons))
        }
    }

    fn issue(&mut self, field: impl Into<String>, reason: impl Into<String>) {
        self.reasons
            .push(format!("{}: {}", field.into(), reason.into()));
    }

    fn validate(&mut self, report: &ResearchReport) {
        // Keep the prior public validator/API as a compatibility check, then
        // perform the stricter checks below and report all discovered reasons.
        if let Err(error) = report.validate() {
            self.issue("legacy_schema", error.to_string());
        }

        self.validate_schema_and_sections(report);
        self.validate_identity(report);
        self.validate_evidence_catalog(report);
        self.collect_conclusions(report);
        self.validate_conclusions(report);
        self.validate_worktree(report);
        self.validate_artifacts(report);
        self.validate_ignore_research(report);
        self.validate_ci(report);
        self.validate_actions(report);
        self.validate_integrity(report);
        self.validate_serialized_boundary_strings(report);
    }

    fn validate_schema_and_sections(&mut self, report: &ResearchReport) {
        if report.schema_version.as_str() != RESEARCH_REPORT_SCHEMA_VERSION {
            self.issue(
                "schema_version",
                format!("expected `{RESEARCH_REPORT_SCHEMA_VERSION}`"),
            );
        }
        let expected = [
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
        if RESEARCH_REPORT_SECTION_HEADINGS != expected {
            self.issue(
                "sections",
                "the compiled fixed section schema does not contain the required ten headings",
            );
        }
        if RESEARCH_REPORT_SECTION_HEADINGS.len() != 10 {
            self.issue("sections", "exactly ten fixed sections are required");
        }
        if report
            .run_identity_and_scope
            .visualization_exclusion
            .as_str()
            != VISUALIZATION_EXCLUSION_STATEMENT
        {
            self.issue(
                "run_identity_and_scope.visualization_exclusion",
                "the fixed visualization exclusion statement is required",
            );
        }
        if report
            .integrity_and_validation
            .no_implementation_change
            .as_str()
            != NO_IMPLEMENTATION_CHANGE_STATEMENT
        {
            self.issue(
                "integrity_and_validation.no_implementation_change",
                "the fixed no-implementation-change statement is required",
            );
        }
    }

    fn validate_identity(&mut self, report: &ResearchReport) {
        let identity = &report.run_identity_and_scope;
        self.non_empty("run_identity_and_scope.run_id", &identity.run_id);
        self.non_empty("run_identity_and_scope.scope", &identity.scope);
        self.validate_snapshot(&identity.snapshot);
        self.validate_text_identifier(
            "run_identity_and_scope.visualization_exclusion",
            &identity.visualization_exclusion,
        );
        self.validate_availability_text_list(
            "run_identity_and_scope.allowlist",
            &identity.allowlist,
        );
        if let Availability::Present(value) = &identity.input_provenance {
            if value.as_str().trim().is_empty() {
                self.issue(
                    "run_identity_and_scope.input_provenance",
                    "present provenance must be non-empty",
                );
            }
        }
        for (index, gap) in identity.gaps.iter().enumerate() {
            self.validate_conclusion_shape(
                &format!("run_identity_and_scope.gaps[{index}]"),
                gap,
                true,
            );
        }
    }

    fn validate_snapshot(&mut self, snapshot: &StartSnapshot) {
        if snapshot.captured_at_utc.get() == 0 {
            self.issue(
                "run_identity_and_scope.snapshot.captured_at_utc",
                "UTC timestamp must be greater than zero",
            );
        }
        let identity = &snapshot.identity;
        if identity.repository_root.as_str().trim().is_empty()
            || !identity.repository_root.as_path().is_absolute()
        {
            self.issue(
                "run_identity_and_scope.snapshot.identity.repository_root",
                "repository root must be a complete absolute path",
            );
        }
        match &identity.checkout {
            CheckoutState::Branch(name) => {
                if name.as_str().trim().is_empty() || name.as_str().contains(['\0', '\n', '\r']) {
                    self.issue(
                        "run_identity_and_scope.snapshot.identity.checkout",
                        "branch state must have a non-empty safe branch name",
                    );
                }
            }
            CheckoutState::Detached => {}
        }
        self.validate_full_id(
            "run_identity_and_scope.snapshot.identity.head",
            &identity.head,
        );
        self.validate_fingerprint(
            "run_identity_and_scope.snapshot.identity.git_fingerprint",
            &identity.git_fingerprint,
        );
        if let Availability::Present(remotes) = &identity.remote_fingerprints {
            for (name, fingerprint) in remotes {
                if name.as_str().trim().is_empty() || name.as_str().contains('\0') {
                    self.issue(
                        "run_identity_and_scope.snapshot.identity.remote_fingerprints",
                        "remote names must be non-empty and NUL-free",
                    );
                }
                self.validate_fingerprint("remote_fingerprint", fingerprint);
            }
        }

        if snapshot.protected_artifact.path.as_str() != ARTIFACT_DIRECTORY {
            self.issue(
                "run_identity_and_scope.snapshot.protected_artifact.path",
                format!("must be exactly `{ARTIFACT_DIRECTORY}`"),
            );
        }
        if let Availability::Present(metadata) = &snapshot.protected_artifact.metadata {
            if !metadata.is_directory || metadata.is_symlink || metadata.is_regular_file {
                self.issue(
                    "run_identity_and_scope.snapshot.protected_artifact.metadata",
                    "protected artifact metadata must describe a real directory",
                );
            }
        }
        self.validate_fingerprint(
            "run_identity_and_scope.snapshot.filesystem.fingerprint",
            &snapshot.filesystem.fingerprint,
        );
        for (key, entry) in &snapshot.filesystem.entries {
            self.validate_repo_path("filesystem_snapshot.key", key);
            self.validate_repo_path("filesystem_snapshot.entry.path", &entry.path);
            if key != &entry.path {
                self.issue(
                    "filesystem_snapshot.entries",
                    "filesystem map key must equal the entry path",
                );
            }
            if is_artifact_path(key.as_str()) {
                self.issue(
                    "filesystem_snapshot.entries",
                    "outside-artifact snapshot must not contain the artifact subtree",
                );
            }
            self.validate_filesystem_entry(entry);
        }
    }

    fn validate_filesystem_entry(&mut self, entry: &crate::FilesystemEntrySnapshot) {
        let metadata = &entry.metadata;
        let type_matches = match entry.entry_type {
            crate::FilesystemEntryType::Directory => {
                metadata.is_directory && !metadata.is_regular_file && !metadata.is_symlink
            }
            crate::FilesystemEntryType::RegularFile => {
                metadata.is_regular_file && !metadata.is_directory && !metadata.is_symlink
            }
            crate::FilesystemEntryType::Symlink => metadata.is_symlink,
            _ => !metadata.is_directory && !metadata.is_regular_file && !metadata.is_symlink,
        };
        if !type_matches {
            self.issue(
                "filesystem_snapshot.entry.metadata",
                "filesystem entry type and metadata disagree",
            );
        }
        match entry.entry_type {
            crate::FilesystemEntryType::RegularFile => {
                if !entry.content_fingerprint.is_present() {
                    self.issue(
                        "filesystem_snapshot.entry.content_fingerprint",
                        "regular files require a content fingerprint",
                    );
                }
                if !entry.symlink_target.is_empty() {
                    self.issue(
                        "filesystem_snapshot.entry.symlink_target",
                        "regular files cannot carry a symlink target",
                    );
                }
            }
            crate::FilesystemEntryType::Symlink => {
                if !entry.symlink_target.is_present() {
                    self.issue(
                        "filesystem_snapshot.entry.symlink_target",
                        "symlinks require an un-followed target",
                    );
                }
                if !entry.content_fingerprint.is_empty() {
                    self.issue(
                        "filesystem_snapshot.entry.content_fingerprint",
                        "symlinks cannot carry a regular-file content fingerprint",
                    );
                }
            }
            _ => {
                if !entry.content_fingerprint.is_empty() || !entry.symlink_target.is_empty() {
                    self.issue(
                        "filesystem_snapshot.entry",
                        "non-file, non-symlink entries cannot carry file evidence",
                    );
                }
            }
        }
        if let Availability::Present(fingerprint) = &entry.content_fingerprint {
            self.validate_fingerprint("filesystem_snapshot.content_fingerprint", fingerprint);
        }
    }

    fn validate_evidence_catalog(&mut self, report: &ResearchReport) {
        let catalog = &report.evidence_catalog;
        for (index, record) in catalog.records.iter().enumerate() {
            self.validate_evidence_id(&format!("evidence_catalog.records[{index}].id"), &record.id);
            self.insert_evidence_id(&record.id, "evidence_catalog.records");
            self.validate_evidence_reference(
                &format!("evidence_catalog.records[{index}].reference"),
                &record.reference,
            );
            self.validate_availability_observation(
                &format!("evidence_catalog.records[{index}].observed_text_or_digest"),
                &record.observed_text_or_digest,
            );
            if let Availability::Present(timestamp) = record.observed_at {
                if timestamp.get() == 0 {
                    self.issue(
                        format!("evidence_catalog.records[{index}].observed_at"),
                        "timestamp must be greater than zero",
                    );
                }
            }
        }
        for (index, citation) in catalog.evidence.citations.iter().enumerate() {
            self.validate_evidence_citation(
                &format!("evidence_catalog.evidence.citations[{index}]"),
                citation,
            );
            self.insert_evidence_id(&citation.id, "evidence_catalog.evidence");
        }
    }

    fn collect_conclusions(&mut self, report: &ResearchReport) {
        for (field, conclusions) in report_conclusion_collections(report) {
            for conclusion in conclusions {
                if self
                    .conclusions
                    .insert(conclusion.id.clone(), conclusion.label)
                    .is_some()
                {
                    self.issue(
                        field,
                        format!("duplicate conclusion ID `{}`", conclusion.id),
                    );
                }
                if matches!(
                    conclusion.label,
                    ResearchConclusionLabel::Fact | ResearchConclusionLabel::Gap
                ) {
                    self.fact_gap_ids.insert(conclusion.id.clone());
                }
            }
        }
        for action in &report.action_recommendations {
            let conclusion = &action.statement;
            if self
                .conclusions
                .insert(conclusion.id.clone(), conclusion.label)
                .is_some()
            {
                self.issue(
                    "action_recommendations",
                    format!("duplicate conclusion ID `{}`", conclusion.id),
                );
            }
        }
    }

    fn validate_conclusions(&mut self, report: &ResearchReport) {
        for (field, conclusions) in report_conclusion_collections(report) {
            for (index, conclusion) in conclusions.iter().enumerate() {
                self.validate_conclusion_shape(&format!("{field}[{index}]"), conclusion, true);
                if field.contains("gaps") && conclusion.label != ResearchConclusionLabel::Gap {
                    self.issue(
                        format!("{field}[{index}].label"),
                        "gap collections require the GAP label",
                    );
                }
            }
        }
        for (index, action) in report.action_recommendations.iter().enumerate() {
            let field = format!("action_recommendations[{index}].statement");
            self.validate_conclusion_shape(&field, &action.statement, false);
            if action.statement.label != ResearchConclusionLabel::Recommendation {
                self.issue(field, "action statement must use the RECOMMENDATION label");
            }
        }
    }

    fn validate_conclusion_shape(
        &mut self,
        field: &str,
        conclusion: &LabelledConclusion,
        recommendation_evidence_required: bool,
    ) {
        self.validate_evidence_id(&format!("{field}.id"), &conclusion.id);
        self.non_empty(&format!("{field}.statement"), &conclusion.statement);
        let mut seen = BTreeSet::new();
        for evidence_id in &conclusion.evidence_ids {
            if !seen.insert(evidence_id) {
                self.issue(
                    format!("{field}.evidence_ids"),
                    "evidence IDs must be unique",
                );
            }
            if !self.evidence_ids.contains(evidence_id) {
                self.issue(
                    format!("{field}.evidence_ids"),
                    format!("unknown evidence ID `{evidence_id}`"),
                );
            }
        }
        if matches!(
            conclusion.label,
            ResearchConclusionLabel::Fact | ResearchConclusionLabel::Gap
        ) && conclusion.evidence_ids.is_empty()
        {
            self.issue(
                format!("{field}.evidence_ids"),
                "FACT and GAP conclusions require at least one evidence reference",
            );
        }
        if conclusion.label == ResearchConclusionLabel::Recommendation {
            if recommendation_evidence_required && conclusion.evidence_ids.is_empty() {
                self.issue(
                    format!("{field}.evidence_ids"),
                    "RECOMMENDATION conclusions require evidence",
                );
            }
            if self.fact_gap_ids.is_empty() {
                self.issue(
                    field,
                    "RECOMMENDATION has no same-report FACT or GAP citation",
                );
            }
        }
    }

    fn validate_worktree(&mut self, report: &ResearchReport) {
        let inventories = &report.working_tree_state.inventories;
        self.validate_worktree_inventory("staged", &inventories.staged);
        self.validate_worktree_inventory("unstaged", &inventories.unstaged);
        self.validate_worktree_inventory("untracked", &inventories.untracked);
        self.validate_worktree_inventory("ignored", &inventories.ignored);
        let expected_clean = inventories.clean_fact();
        if report.working_tree_state.clean != expected_clean {
            self.issue(
                "working_tree_state.clean",
                "clean state does not match staged/unstaged/untracked inventories",
            );
        }
    }

    fn validate_worktree_inventory(
        &mut self,
        name: &str,
        inventory: &Availability<Vec<WorktreePathObservation>>,
    ) {
        if let Availability::Present(entries) = inventory {
            let mut paths = BTreeSet::new();
            for (index, entry) in entries.iter().enumerate() {
                self.validate_repo_path(
                    &format!("working_tree_state.{name}[{index}].path"),
                    &entry.path,
                );
                self.validate_evidence_reference(
                    &format!("working_tree_state.{name}[{index}].reference"),
                    &entry.reference,
                );
                if !paths.insert(entry.path.clone()) {
                    self.issue(
                        format!("working_tree_state.{name}"),
                        "inventory paths must be unique",
                    );
                }
                if entry.status.as_str().trim().is_empty() {
                    self.issue(
                        format!("working_tree_state.{name}[{index}].status"),
                        "status must be explicit",
                    );
                }
            }
        }
    }

    fn validate_artifacts(&mut self, report: &ResearchReport) {
        let section = &report.artifact_inventory;
        match &section.inventory {
            Availability::Present(inventory) => {
                self.validate_full_id(
                    "artifact_inventory.audited_revision",
                    &inventory.audited_revision,
                );
                if inventory.audited_at_utc.get() == 0 {
                    self.issue(
                        "artifact_inventory.audited_at_utc",
                        "timestamp must be greater than zero",
                    );
                }
                for (path, candidate) in &inventory.candidates {
                    self.validate_repo_path("artifact_inventory.candidate_key", path);
                    self.validate_artifact_candidate(path, candidate);
                }
                if inventory.candidates.is_empty() {
                    // An inspected empty artifact inventory is represented by an
                    // available empty map and is still a valid observation.
                }
            }
            Availability::Empty | Availability::Unavailable => {}
        }
        let expected_removals = match &section.inventory {
            Availability::Present(inventory) => inventory
                .candidates
                .iter()
                .filter_map(|(path, candidate)| {
                    (candidate.retention_recommendation == RetentionRecommendation::Remove)
                        .then_some(path.clone())
                })
                .collect::<BTreeSet<_>>(),
            Availability::Empty => BTreeSet::new(),
            Availability::Unavailable => BTreeSet::new(),
        };
        match (
            &report.ignore_research_and_removal_register.removal_register,
            &section.inventory,
        ) {
            (Availability::Present(register), Availability::Present(_)) => {
                self.validate_removal_register(register, &expected_removals);
            }
            (Availability::Empty, Availability::Empty) => {}
            (Availability::Unavailable, Availability::Unavailable) => {}
            (Availability::Empty, Availability::Present(_)) => {
                if !expected_removals.is_empty() {
                    self.issue(
                        "ignore_research_and_removal_register.removal_register",
                        "the removal register is missing records for Remove candidates",
                    );
                }
            }
            (Availability::Unavailable, Availability::Present(_)) => {
                self.issue(
                    "ignore_research_and_removal_register.removal_register",
                    "an unavailable removal register cannot accompany an available artifact inventory",
                );
            }
            (Availability::Present(_), _) => {
                self.issue(
                    "ignore_research_and_removal_register.removal_register",
                    "a removal register requires an available artifact inventory",
                );
            }
            (Availability::Empty, Availability::Unavailable)
            | (Availability::Unavailable, Availability::Empty) => {
                self.issue(
                    "ignore_research_and_removal_register.removal_register",
                    "artifact and removal availability states must agree",
                );
            }
        }
    }

    fn validate_artifact_candidate(
        &mut self,
        key: &RepoRelativePath,
        candidate: &crate::ArtifactCandidate,
    ) {
        self.validate_repo_path("artifact_inventory.candidate.path", &candidate.path);
        if key != &candidate.path {
            self.issue(
                "artifact_inventory.candidates",
                "candidate map key must equal candidate.path",
            );
        }
        if candidate.absent != inverse_status(candidate.filesystem) {
            self.issue(
                "artifact_inventory.candidate.absent",
                "absent status must be the inverse of filesystem status",
            );
        }
        self.validate_evidence_reference(
            "artifact_inventory.candidate.classification_evidence",
            &candidate.classification_evidence,
        );
        if let PrimaryClassification::Custom(value) = &candidate.classification {
            self.bounded_text("artifact_inventory.candidate.classification", value, 1, 50);
        }
        if candidate.purpose.labels.is_empty() {
            self.issue(
                "artifact_inventory.candidate.purpose.labels",
                "at least one purpose label is required",
            );
        }
        self.bounded_str(
            "artifact_inventory.candidate.purpose.description",
            candidate.purpose.description.as_str(),
            1,
            500,
        );
        if candidate.purpose.evidence.is_empty() {
            self.issue(
                "artifact_inventory.candidate.purpose.evidence",
                "purpose evidence is required",
            );
        }
        for reference in &candidate.purpose.evidence {
            self.validate_evidence_reference(
                "artifact_inventory.candidate.purpose.evidence",
                reference,
            );
        }
        if candidate.consumers.is_empty() {
            self.issue(
                "artifact_inventory.candidate.consumers",
                "exactly one named or no-consumer result is required",
            );
        }
        let no_consumer_count = candidate
            .consumers
            .iter()
            .filter(|consumer| consumer.is_no_consumer())
            .count();
        if no_consumer_count > 0 && candidate.consumers.len() != 1 {
            self.issue(
                "artifact_inventory.candidate.consumers",
                "NoConsumer cannot be combined with named consumers",
            );
        }
        for consumer in &candidate.consumers {
            match consumer {
                ConsumerResult::Named { name, evidence } => {
                    self.non_empty("artifact_inventory.candidate.consumer.name", name);
                    if evidence.is_empty() {
                        self.issue(
                            "artifact_inventory.candidate.consumer.evidence",
                            "named consumers require evidence",
                        );
                    }
                    for reference in evidence {
                        self.validate_evidence_reference(
                            "artifact_inventory.candidate.consumer.evidence",
                            reference,
                        );
                    }
                }
                ConsumerResult::NoConsumer => {}
            }
        }
        match &candidate.producers {
            ProducerDiscovery::Named { producers } => {
                if producers.is_empty() {
                    self.issue(
                        "artifact_inventory.candidate.producers",
                        "named producer discovery cannot be empty",
                    );
                }
                for producer in producers {
                    self.non_empty("artifact_inventory.candidate.producer.name", &producer.name);
                    if producer.evidence.is_empty() {
                        self.issue(
                            "artifact_inventory.candidate.producer.evidence",
                            "named producers require evidence",
                        );
                    }
                    for reference in &producer.evidence {
                        self.validate_evidence_reference(
                            "artifact_inventory.candidate.producer.evidence",
                            reference,
                        );
                    }
                }
            }
            ProducerDiscovery::NotDiscoverable | ProducerDiscovery::NotApplicable => {}
        }
        for reference in candidate.retention_detail.evidence() {
            self.validate_evidence_reference(
                "artifact_inventory.candidate.retention_detail.evidence",
                reference,
            );
        }
        for reference in candidate.retention_detail.required_use.evidence() {
            self.validate_evidence_reference(
                "artifact_inventory.candidate.retention_detail.required_use.evidence",
                reference,
            );
        }
        if candidate
            .retention_detail
            .validate_for(candidate.retention_recommendation)
            .is_err()
        {
            self.issue(
                "artifact_inventory.candidate.retention_detail",
                "retention detail is invalid for its recommendation",
            );
        }
        match candidate.retention_recommendation {
            RetentionRecommendation::Retain => {
                if !matches!(
                    candidate.retention,
                    crate::RetentionDecision::Keep | crate::RetentionDecision::Unassessed
                ) {
                    self.issue(
                        "artifact_inventory.candidate.retention",
                        "Retain must use the legacy Keep or initial Unassessed projection",
                    );
                }
                if candidate.retention_detail.reason.is_some()
                    || candidate.retention_detail.destination.is_some()
                {
                    self.issue(
                        "artifact_inventory.candidate.retention_detail",
                        "Retain cannot carry remove or move-only fields",
                    );
                }
            }
            RetentionRecommendation::Remove => {
                if candidate.retention != crate::RetentionDecision::Remove {
                    self.issue(
                        "artifact_inventory.candidate.retention",
                        "Remove must use the legacy Remove projection",
                    );
                }
                if candidate.required_use()
                    || candidate.tracked.is_unverified()
                    || candidate.filesystem.is_unverified()
                    || candidate.remote.is_unverified()
                    || !candidate.retention_detail.required_use.is_no_required_use()
                {
                    self.issue(
                        "artifact_inventory.candidate.retention_recommendation",
                        "Remove is unsafe when required use or an unavailable source exists",
                    );
                }
                if candidate.retention_detail.reason.is_none()
                    || candidate.retention_detail.destination.is_some()
                {
                    self.issue(
                        "artifact_inventory.candidate.retention_detail",
                        "Remove requires a reason and no destination",
                    );
                }
            }
            RetentionRecommendation::Move => {
                if candidate.retention != crate::RetentionDecision::Keep
                    || candidate.retention_detail.destination.is_none()
                    || candidate.retention_detail.reason.is_some()
                {
                    self.issue(
                        "artifact_inventory.candidate.retention_detail",
                        "Move requires a destination and no remove reason",
                    );
                }
            }
            RetentionRecommendation::Regenerate => {
                if candidate.retention != crate::RetentionDecision::Keep
                    || candidate.retention_detail.reason.is_some()
                    || candidate.retention_detail.destination.is_some()
                    || matches!(candidate.producers, ProducerDiscovery::NotApplicable)
                {
                    self.issue(
                        "artifact_inventory.candidate.retention_detail",
                        "Regenerate requires an explicit producer or not-discoverable result",
                    );
                }
            }
        }
    }

    fn validate_removal_register(
        &mut self,
        register: &RemovalRegister,
        expected: &BTreeSet<RepoRelativePath>,
    ) {
        let actual = register.records.keys().cloned().collect::<BTreeSet<_>>();
        if &actual != expected {
            self.issue(
                "ignore_research_and_removal_register.removal_register",
                format!(
                    "records must equal the Remove subset; expected {expected:?}, got {actual:?}"
                ),
            );
        }
        for (path, record) in &register.records {
            self.validate_repo_path("removal_register.key", path);
            self.validate_repo_path("removal_register.record.path", &record.path);
            if path != &record.path {
                self.issue("removal_register", "record key must equal record.path");
            }
            self.bounded_text("removal_register.reason", &record.reason, 1, 500);
            if record.evidence.is_empty() {
                self.issue("removal_register.evidence", "removal evidence is required");
            }
            for reference in &record.evidence {
                self.validate_evidence_reference("removal_register.evidence", reference);
            }
        }
    }

    fn validate_ignore_research(&mut self, report: &ResearchReport) {
        let section = &report.ignore_research_and_removal_register;
        if let Availability::Present(proposals) = &section.proposals {
            for (index, proposal) in proposals.iter().enumerate() {
                self.validate_ignore_proposal(index, proposal);
            }
        }
        if let Availability::Present(follow_ups) = &section.untracking_follow_ups {
            for (key, follow_up) in follow_ups {
                self.validate_untracking_follow_up(key, follow_up);
            }
        }
        if matches!(section.proposals, Availability::Unavailable)
            && matches!(section.untracking_follow_ups, Availability::Present(_))
        {
            self.issue(
                "ignore_research_and_removal_register.untracking_follow_ups",
                "untracking recommendations cannot be present when the Ignore File is unavailable",
            );
        }
    }

    fn validate_ignore_proposal(&mut self, index: usize, proposal: &IgnorePatternProposal) {
        let field = format!("ignore_research_and_removal_register.proposals[{index}]");
        self.validate_pattern(&format!("{field}.pattern"), &proposal.pattern);
        if proposal.match_count == 0 {
            if !proposal.examples.is_empty() {
                self.issue(
                    format!("{field}.examples"),
                    "zero matches require zero examples",
                );
            }
        } else if proposal.examples.is_empty() || proposal.examples.len() > 5 {
            self.issue(
                format!("{field}.examples"),
                "positive matches require one through five examples",
            );
        }
        let mut previous = None;
        for path in &proposal.examples {
            self.validate_repo_path(&format!("{field}.examples"), path);
            if let Some(previous) = previous {
                if previous >= path {
                    self.issue(
                        format!("{field}.examples"),
                        "examples must be sorted and unique",
                    );
                }
            }
            previous = Some(path);
        }
        if let Some(paths) = proposal.required_exceptions.as_paths() {
            if paths.is_empty() {
                self.issue(
                    format!("{field}.required_exceptions"),
                    "exception path result cannot be empty",
                );
            }
            for path in paths {
                self.validate_repo_path(&format!("{field}.required_exceptions"), path);
            }
        }
        if proposal.evidence.is_empty() {
            self.issue(format!("{field}.evidence"), "pattern evidence is required");
        }
        for reference in &proposal.evidence {
            self.validate_evidence_reference(&format!("{field}.evidence"), reference);
        }
    }

    fn validate_untracking_follow_up(
        &mut self,
        key: &RepoRelativePath,
        follow_up: &UntrackingFollowUp,
    ) {
        self.validate_repo_path("untracking_follow_up.key", key);
        self.validate_repo_path("untracking_follow_up.path", &follow_up.path);
        if key != &follow_up.path {
            self.issue("untracking_follow_up", "map key must equal follow-up path");
        }
        self.validate_pattern("untracking_follow_up.pattern", &follow_up.pattern);
        if follow_up.evidence.is_empty() {
            self.issue("untracking_follow_up.evidence", "evidence is required");
        }
        for reference in &follow_up.evidence {
            self.validate_evidence_reference("untracking_follow_up.evidence", reference);
        }
    }

    fn validate_ci(&mut self, report: &ResearchReport) {
        let ci = &report.ci_inventory_and_causality;
        match &ci.workflows {
            Availability::Present(inventory) => {
                self.validate_workflow_inventory(inventory);
            }
            Availability::Empty | Availability::Unavailable => {}
        }
        if let Availability::Present(evaluations) = &ci.trigger_evaluations {
            for (index, evaluation) in evaluations.iter().enumerate() {
                self.validate_trigger_evaluation(index, evaluation);
            }
        }
        if let Availability::Present(runs) = &ci.observed_ci_runs {
            for (index, run) in runs.iter().enumerate() {
                self.validate_observed_run(index, run);
            }
        }
        if let Availability::Present(execution) = &ci.execution_evidence {
            if execution.matching_runs.is_empty() {
                if execution.no_matching_run_gap
                    != Availability::Present(ExactText::new(NO_OBSERVED_RUN_GAP))
                {
                    self.issue(
                        "ci_inventory_and_causality.execution_evidence.no_matching_run_gap",
                        "no matching run requires the exact no-observed-run gap",
                    );
                }
            } else if !execution.no_matching_run_gap.is_empty() {
                self.issue(
                    "ci_inventory_and_causality.execution_evidence.no_matching_run_gap",
                    "matching runs require an empty no-observed-run gap",
                );
            }
            for (index, run) in execution.matching_runs.iter().enumerate() {
                self.validate_observed_run(index, run);
            }
        }
        match &ci.build_policy {
            Availability::Present(policy) => self.validate_build_policy(ci, policy),
            Availability::Empty => {
                if matches!(ci.workflows, Availability::Present(_)) {
                    self.issue(
                        "ci_inventory_and_causality.build_policy",
                        "available workflow inventory requires an explicit build policy",
                    );
                }
            }
            Availability::Unavailable => {
                if !matches!(ci.workflows, Availability::Unavailable) {
                    self.issue(
                        "ci_inventory_and_causality.build_policy",
                        "unavailable build policy requires unavailable workflow inventory",
                    );
                }
            }
        }
    }

    fn validate_workflow_inventory(&mut self, inventory: &WorkflowInventory) {
        if let Availability::Present(directory) = &inventory.directory {
            if directory.path.as_str() != ".github/workflows" {
                self.issue(
                    "ci_inventory_and_causality.workflows.directory.path",
                    "workflow directory path must be `.github/workflows`",
                );
            }
        }
        let Some(records) = present_workflows(&inventory.workflows) else {
            return;
        };
        let mut paths = BTreeSet::new();
        for (index, workflow) in records.iter().enumerate() {
            self.validate_workflow_record(index, workflow);
            if !paths.insert(workflow.path.clone()) {
                self.issue(
                    "ci_inventory_and_causality.workflows.workflows",
                    "workflow paths must be unique",
                );
            }
        }
        if let Availability::Present(directory) = &inventory.directory {
            if directory.file_count != records.len() {
                self.issue(
                    "ci_inventory_and_causality.workflows.directory.file_count",
                    "workflow directory file count must equal the inventory length",
                );
            }
        }
    }

    fn validate_workflow_record(&mut self, index: usize, workflow: &WorkflowRecord) {
        let field = format!("ci_inventory_and_causality.workflows.workflows[{index}]");
        self.validate_repo_path(&format!("{field}.path"), &workflow.path);
        self.validate_span(&format!("{field}.source_span"), workflow.source_span);
        for (gap_index, gap) in workflow.parse_gaps.iter().enumerate() {
            self.validate_repo_path(&format!("{field}.parse_gaps[{gap_index}].path"), &gap.path);
            self.validate_span(&format!("{field}.parse_gaps[{gap_index}].span"), gap.span);
            self.non_empty(
                &format!("{field}.parse_gaps[{gap_index}].reason"),
                &gap.reason,
            );
        }
        self.validate_workflow_triggers(&format!("{field}.triggers"), &workflow.triggers);
        if let Availability::Present(conditions) = &workflow.job_conditions {
            for (condition_index, condition) in conditions.iter().enumerate() {
                self.non_empty(
                    &format!("{field}.job_conditions[{condition_index}].job"),
                    &condition.job,
                );
                self.validate_span(
                    &format!("{field}.job_conditions[{condition_index}].span"),
                    condition.span,
                );
                self.validate_located_text(
                    &format!("{field}.job_conditions[{condition_index}].condition"),
                    &condition.condition,
                );
            }
        }
        match &workflow.build {
            BuildExtraction::Commands(commands) => {
                if commands.is_empty() {
                    self.issue(
                        format!("{field}.build"),
                        "Commands must contain at least one qualifying command",
                    );
                }
                for (command_index, command) in commands.iter().enumerate() {
                    self.non_empty(
                        &format!("{field}.build.commands[{command_index}].text"),
                        &command.text,
                    );
                    self.non_empty(
                        &format!("{field}.build.commands[{command_index}].job"),
                        &command.job,
                    );
                    self.non_empty(
                        &format!("{field}.build.commands[{command_index}].step"),
                        &command.step,
                    );
                    self.validate_span(
                        &format!("{field}.build.commands[{command_index}].span"),
                        command.span,
                    );
                }
                if workflow.classification != WorkflowClassification::BuildWorkflow {
                    self.issue(
                        format!("{field}.classification"),
                        "a workflow with qualifying commands must be BuildWorkflow",
                    );
                }
                if workflow.categories.is_empty()
                    && workflow.classification == WorkflowClassification::NonBuildWorkflow
                {
                    self.issue(
                        format!("{field}.categories"),
                        "non-build workflows require a category",
                    );
                }
            }
            BuildExtraction::NoBuildCommand(no_build) => {
                self.non_empty(&format!("{field}.build.reason"), &no_build.reason);
                self.validate_span(&format!("{field}.build.span"), no_build.span);
                if workflow.classification != WorkflowClassification::NonBuildWorkflow
                    || workflow.categories.is_empty()
                {
                    self.issue(
                        format!("{field}.classification"),
                        "NoBuildCommand requires a categorized NonBuildWorkflow",
                    );
                }
            }
            BuildExtraction::Unavailable(gap) => {
                self.validate_repo_path(&format!("{field}.build.gap.path"), &gap.path);
                self.validate_span(&format!("{field}.build.gap.span"), gap.span);
                self.non_empty(&format!("{field}.build.gap.reason"), &gap.reason);
            }
        }
        if workflow.classification == WorkflowClassification::NonBuildWorkflow
            && workflow.categories.is_empty()
        {
            self.issue(
                format!("{field}.categories"),
                "NonBuildWorkflow requires at least one allowed category",
            );
        }
    }

    fn validate_workflow_triggers(&mut self, field: &str, triggers: &WorkflowTriggerInventory) {
        if let Availability::Present(events) = &triggers.events {
            let mut names = BTreeSet::new();
            for (index, event) in events.iter().enumerate() {
                self.validate_workflow_event(&format!("{field}.events[{index}]"), event);
                if !names.insert(event.name.clone()) {
                    self.issue(format!("{field}.events"), "event names must be unique");
                }
            }
        }
        for (name, values) in [
            ("branches", &triggers.branches),
            ("branches_ignore", &triggers.branches_ignore),
            ("tags", &triggers.tags),
            ("tags_ignore", &triggers.tags_ignore),
            ("paths", &triggers.paths),
            ("paths_ignore", &triggers.paths_ignore),
        ] {
            if let Availability::Present(values) = values {
                for (index, value) in values.iter().enumerate() {
                    self.non_empty(&format!("{field}.{name}[{index}].event"), &value.event);
                    self.non_empty(&format!("{field}.{name}[{index}].raw"), &value.raw);
                    self.non_empty(&format!("{field}.{name}[{index}].value"), &value.value);
                    self.validate_span(&format!("{field}.{name}[{index}].span"), value.span);
                }
            }
        }
        if let Availability::Present(values) = &triggers.schedules {
            for (index, value) in values.iter().enumerate() {
                self.validate_located_text(
                    &format!("{field}.schedules[{index}].cron"),
                    &value.cron,
                );
                self.validate_span(&format!("{field}.schedules[{index}].span"), value.span);
            }
        }
        if let Availability::Present(values) = &triggers.manual_inputs {
            for (index, value) in values.iter().enumerate() {
                self.validate_located_text(
                    &format!("{field}.manual_inputs[{index}].name"),
                    &value.name,
                );
                self.validate_span(&format!("{field}.manual_inputs[{index}].span"), value.span);
            }
        }
        if let Availability::Present(values) = &triggers.workflow_call_inputs {
            for (index, value) in values.iter().enumerate() {
                self.validate_located_text(
                    &format!("{field}.workflow_call_inputs[{index}].name"),
                    &value.name,
                );
                self.validate_span(
                    &format!("{field}.workflow_call_inputs[{index}].span"),
                    value.span,
                );
            }
        }
        if let Availability::Present(conditions) = &triggers.job_conditions {
            for (index, condition) in conditions.iter().enumerate() {
                self.validate_span(
                    &format!("{field}.job_conditions[{index}].span"),
                    condition.span,
                );
                self.validate_located_text(
                    &format!("{field}.job_conditions[{index}].condition"),
                    &condition.condition,
                );
            }
        }
        for (index, none) in triggers.none_configured.iter().enumerate() {
            self.validate_span(&format!("{field}.none_configured[{index}].span"), none.span);
        }
    }

    fn validate_workflow_event(&mut self, field: &str, event: &WorkflowEvent) {
        self.non_empty(&format!("{field}.name"), &event.name);
        self.non_empty(&format!("{field}.raw_name"), &event.raw_name);
        self.validate_span(&format!("{field}.span"), event.span);
        for (name, values) in [
            ("branches", &event.branches),
            ("branches_ignore", &event.branches_ignore),
            ("tags", &event.tags),
            ("tags_ignore", &event.tags_ignore),
            ("paths", &event.paths),
            ("paths_ignore", &event.paths_ignore),
        ] {
            if let Availability::Present(values) = values {
                for (index, value) in values.iter().enumerate() {
                    self.validate_located_text(&format!("{field}.{name}[{index}]"), value);
                }
            }
        }
        if let Availability::Present(schedules) = &event.schedules {
            for (index, schedule) in schedules.iter().enumerate() {
                self.validate_located_text(
                    &format!("{field}.schedules[{index}].cron"),
                    &schedule.cron,
                );
                self.validate_span(&format!("{field}.schedules[{index}].span"), schedule.span);
            }
        }
        for (index, none) in event.none_configured.iter().enumerate() {
            self.validate_span(&format!("{field}.none_configured[{index}].span"), none.span);
        }
    }

    fn validate_trigger_evaluation(&mut self, index: usize, evaluation: &TriggerEvaluation) {
        let field = format!("ci_inventory_and_causality.trigger_evaluations[{index}]");
        self.validate_repo_path(&format!("{field}.workflow_path"), &evaluation.workflow_path);
        self.non_empty(&format!("{field}.event"), &evaluation.event);
        if evaluation.conditions.is_empty() {
            self.issue(
                format!("{field}.conditions"),
                "every outcome requires conditions",
            );
        }
        for (condition_index, condition) in evaluation.conditions.iter().enumerate() {
            self.validate_condition_evaluation(
                &format!("{field}.conditions[{condition_index}]"),
                condition,
            );
        }
        if evaluation.result == crate::TriggerResult::Undetermined
            && !evaluation.unavailable_condition.is_present()
        {
            self.issue(
                format!("{field}.unavailable_condition"),
                "Undetermined outcomes require an unavailable condition",
            );
        }
    }

    fn validate_condition_evaluation(&mut self, field: &str, condition: &ConditionEvaluation) {
        self.validate_repo_path(&format!("{field}.workflow_path"), &condition.workflow_path);
        self.validate_span(&format!("{field}.source_span"), condition.source_span);
        self.validate_evidence_locator(&format!("{field}.evidence"), &condition.evidence);
        if condition.evidence.path != condition.workflow_path
            || condition.evidence.span != condition.source_span
        {
            self.issue(
                field,
                "condition evidence must cite its workflow path and source span",
            );
        }
        if condition.result == crate::TriggerResult::Undetermined
            && !condition.unavailable_condition.is_present()
        {
            self.issue(
                format!("{field}.unavailable_condition"),
                "Undetermined outcomes require an unavailable condition",
            );
        }
        if let Availability::Present(values) = &condition.configured_values {
            for (index, value) in values.iter().enumerate() {
                self.validate_located_text(&format!("{field}.configured_values[{index}]"), value);
            }
        }
    }

    fn validate_observed_run(&mut self, index: usize, run: &crate::ObservedCiRun) {
        let field = format!("ci_inventory_and_causality.observed_ci_runs[{index}]");
        for (name, value) in [
            ("run_id", &run.run_id),
            ("workflow_id_or_path", &run.workflow_id_or_path),
            ("event", &run.event),
            ("ref", &run.r#ref),
            ("outcome", &run.outcome),
        ] {
            if let Availability::Present(value) = value {
                self.non_empty(&format!("{field}.{name}"), value);
            }
        }
        if let Availability::Present(commit) = &run.commit {
            self.validate_full_id(&format!("{field}.commit"), commit);
        }
    }

    fn validate_build_policy(&mut self, ci: &CiInventoryAndCausality, policy: &BuildPolicyReport) {
        let Some(inventory) = present_workflow_inventory(&ci.workflows) else {
            if !policy.predicates.is_empty()
                || !policy.expected_results.is_empty()
                || !policy.action_dependencies.is_empty()
            {
                self.issue(
                    "ci_inventory_and_causality.build_policy",
                    "policy records require an available workflow inventory",
                );
            }
            return;
        };
        let build_records = match &inventory.workflows {
            Availability::Present(records) => records
                .iter()
                .filter(|workflow| workflow.is_workflow() && workflow.is_build_workflow())
                .collect::<Vec<_>>(),
            Availability::Empty | Availability::Unavailable => Vec::new(),
        };
        let mut expected_keys = BTreeSet::new();
        for outcome in &policy.expected_results {
            self.validate_repo_path(
                "build_policy.expected_results.workflow_path",
                &outcome.workflow_path,
            );
            self.non_empty("build_policy.expected_results.event", &outcome.event);
            self.non_empty(
                "build_policy.expected_results.activation_condition",
                &outcome.activation_condition,
            );
            self.validate_span(
                "build_policy.expected_results.source_span",
                outcome.source_span,
            );
            self.validate_evidence_locator(
                "build_policy.expected_results.evidence",
                &outcome.evidence,
            );
            if outcome.evidence.path != outcome.workflow_path
                || outcome.evidence.span != outcome.source_span
            {
                self.issue(
                    "build_policy.expected_results.evidence",
                    "expected outcome evidence must cite workflow path and span",
                );
            }
            if !expected_keys.insert((outcome.workflow_path.clone(), outcome.event.clone())) {
                self.issue(
                    "build_policy.expected_results",
                    "workflow/event outcomes must be unique",
                );
            }
            if let crate::ExpectedBuildResult::ResultCannotBeDetermined {
                unavailable_condition,
            } = &outcome.result
            {
                self.non_empty(
                    "build_policy.expected_results.unavailable_condition",
                    unavailable_condition,
                );
            }
        }
        let mut predicate_keys = BTreeSet::new();
        for predicate in &policy.predicates {
            self.validate_repo_path(
                "build_policy.predicates.workflow_path",
                &predicate.workflow_path,
            );
            self.non_empty("build_policy.predicates.event", &predicate.event);
            self.non_empty(
                "build_policy.predicates.activation_condition",
                &predicate.activation_condition,
            );
            self.validate_span("build_policy.predicates.source_span", predicate.source_span);
            self.validate_evidence_locator("build_policy.predicates.evidence", &predicate.evidence);
            if predicate.evidence.path != predicate.workflow_path
                || predicate.evidence.span != predicate.source_span
            {
                self.issue(
                    "build_policy.predicates.evidence",
                    "activation predicate evidence must cite workflow path and span",
                );
            }
            if predicate.conditions.is_empty() {
                self.issue(
                    "build_policy.predicates.conditions",
                    "activation predicates require at least one explicit condition",
                );
            }
            if !predicate_keys.insert((predicate.workflow_path.clone(), predicate.event.clone())) {
                self.issue(
                    "build_policy.predicates",
                    "workflow/event predicates must be unique",
                );
            }
            for condition in &predicate.conditions {
                self.validate_repo_path(
                    "build_policy.predicate.condition.workflow_path",
                    &condition.workflow_path,
                );
                self.validate_span(
                    "build_policy.predicate.condition.source_span",
                    condition.source_span,
                );
                self.validate_evidence_locator(
                    "build_policy.predicate.condition.evidence",
                    &condition.evidence,
                );
                if condition.evidence.path != condition.workflow_path
                    || condition.evidence.span != condition.source_span
                {
                    self.issue(
                        "build_policy.predicate.condition.evidence",
                        "activation condition evidence must cite workflow path and span",
                    );
                }
                if let Availability::Present(values) = &condition.configured_values {
                    for value in values {
                        self.validate_located_text(
                            "build_policy.predicate.configured_value",
                            value,
                        );
                    }
                }
            }
        }
        for workflow in &build_records {
            let event_count = match &workflow.triggers.events {
                Availability::Present(events) => events.len(),
                Availability::Empty => 0,
                Availability::Unavailable => 0,
            };
            let expected_for_workflow = policy
                .expected_results
                .iter()
                .filter(|outcome| outcome.workflow_path == workflow.path)
                .count();
            if event_count > 0 && expected_for_workflow != event_count {
                self.issue(
                    "build_policy.expected_results",
                    format!(
                        "Build Workflow `{}` requires exactly one outcome per documented event",
                        workflow.path
                    ),
                );
            }
            let predicate_for_workflow = policy
                .predicates
                .iter()
                .filter(|predicate| predicate.workflow_path == workflow.path)
                .count();
            let required_predicates = event_count.max(1);
            if predicate_for_workflow != required_predicates {
                self.issue(
                    "build_policy.predicates",
                    format!(
                        "Build Workflow `{}` requires one activation predicate per event (or one unavailable predicate)",
                        workflow.path
                    ),
                );
            }
        }
        for dependency in &policy.action_dependencies {
            self.non_empty(
                "build_policy.action_dependencies.action",
                &dependency.action,
            );
            self.non_empty(
                "build_policy.action_dependencies.activation_condition",
                &dependency.activation_condition,
            );
            self.validate_repo_path(
                "build_policy.action_dependencies.workflow_path",
                &dependency.workflow_path,
            );
            self.validate_span(
                "build_policy.action_dependencies.source_span",
                dependency.source_span,
            );
            self.validate_evidence_locator(
                "build_policy.action_dependencies.evidence",
                &dependency.evidence,
            );
            if dependency.evidence.path != dependency.workflow_path
                || dependency.evidence.span != dependency.source_span
            {
                self.issue(
                    "build_policy.action_dependencies.evidence",
                    "dependency evidence must cite workflow path and span",
                );
            }
            if dependency.classification == ActionDependencyClassification::Undetermined
                && !dependency.unavailable_condition.is_present()
            {
                self.issue(
                    "build_policy.action_dependencies.unavailable_condition",
                    "Undetermined action dependencies require an unavailable condition",
                );
            }
        }
        if policy.action_dependencies.is_empty() {
            if policy.no_actions_documented
                != Availability::Present(ExactText::new("none documented"))
            {
                self.issue(
                    "build_policy.no_actions_documented",
                    "an empty action list requires the explicit none-documented outcome",
                );
            }
        } else if !policy.no_actions_documented.is_empty() {
            self.issue(
                "build_policy.no_actions_documented",
                "a non-empty action list cannot claim none documented",
            );
        }
    }

    fn validate_actions(&mut self, report: &ResearchReport) {
        if report.action_recommendations.len() != 4 {
            self.issue(
                "action_recommendations",
                "exactly four ordered action recommendations are required",
            );
        }
        let mut priorities = BTreeSet::new();
        let mut areas = BTreeSet::new();
        for (index, action) in report.action_recommendations.iter().enumerate() {
            let field = format!("action_recommendations[{index}]");
            if action.priority != index as u8 + 1 {
                self.issue(
                    format!("{field}.priority"),
                    "priorities must be exactly 1, 2, 3, 4 in order",
                );
            }
            if !priorities.insert(action.priority) {
                self.issue(format!("{field}.priority"), "priorities must be unique");
            }
            if !areas.insert(action.action_area) {
                self.issue(
                    format!("{field}.action_area"),
                    "action areas must be unique",
                );
            }
            if index < ActionArea::ORDER.len() && action.action_area != ActionArea::ORDER[index] {
                self.issue(
                    format!("{field}.action_area"),
                    "action areas must follow the required order",
                );
            }
            self.bounded_text(&format!("{field}.risk"), &action.risk, 1, 500);
            self.bounded_text(
                &format!("{field}.verification_method"),
                &action.verification_method,
                1,
                500,
            );
            match &action.affected_paths_or_none {
                AffectedPathsOrNone::NoneAffected => {}
                AffectedPathsOrNone::Paths(paths) => {
                    if paths.is_empty() {
                        self.issue(
                            format!("{field}.affected_paths_or_none"),
                            "empty path lists must use NoneAffected",
                        );
                    }
                    let mut previous = None;
                    for path in paths {
                        self.validate_repo_path(&format!("{field}.affected_paths_or_none"), path);
                        if let Some(previous) = previous {
                            if previous >= path {
                                self.issue(
                                    format!("{field}.affected_paths_or_none"),
                                    "affected paths must be sorted and unique",
                                );
                            }
                        }
                        previous = Some(path);
                    }
                }
            }
            let mut citations = BTreeSet::new();
            if action.supporting_citations.is_empty() {
                self.issue(
                    format!("{field}.supporting_citations"),
                    "each action requires at least one FACT/GAP citation",
                );
            }
            for citation in &action.supporting_citations {
                if !citations.insert(citation) {
                    self.issue(
                        format!("{field}.supporting_citations"),
                        "supporting citations must be unique",
                    );
                }
                match self.conclusions.get(citation) {
                    Some(ResearchConclusionLabel::Fact) | Some(ResearchConclusionLabel::Gap) => {}
                    Some(_) => self.issue(
                        format!("{field}.supporting_citations"),
                        format!("citation `{citation}` is not a FACT or GAP"),
                    ),
                    None => self.issue(
                        format!("{field}.supporting_citations"),
                        format!("unresolved recommendation citation `{citation}`"),
                    ),
                }
            }
        }
        for area in ActionArea::ORDER {
            if !areas.contains(&area) {
                self.issue(
                    "action_recommendations",
                    format!("missing action area `{}`", area.as_str()),
                );
            }
        }
    }

    fn validate_integrity(&mut self, report: &ResearchReport) {
        self.validate_completion_claim(&report.integrity_and_validation.completion);
        for (index, conclusion) in report
            .integrity_and_validation
            .validation
            .iter()
            .enumerate()
        {
            self.validate_conclusion_shape(
                &format!("integrity_and_validation.validation[{index}]"),
                conclusion,
                true,
            );
        }
    }

    fn validate_completion_claim(&mut self, completion: &Availability<CompletionComparison>) {
        match completion {
            Availability::Empty => {}
            Availability::Unavailable => self.issue(
                "integrity_and_validation.completion",
                "an unavailable completion boundary cannot support an integrity claim",
            ),
            Availability::Present(comparison) => {
                self.validate_fingerprint(
                    "integrity_and_validation.completion.start_fingerprint",
                    &comparison.start_fingerprint,
                );
                if comparison.start_filesystem_fingerprint.as_str().is_empty() {
                    self.issue(
                        "integrity_and_validation.completion.start_filesystem_fingerprint",
                        "filesystem fingerprint must be present",
                    );
                }
                self.validate_fingerprint(
                    "integrity_and_validation.completion.start_filesystem_fingerprint",
                    &comparison.start_filesystem_fingerprint,
                );
                if comparison.checked_at_utc.get() == 0 {
                    self.issue(
                        "integrity_and_validation.completion.checked_at_utc",
                        "timestamp must be greater than zero",
                    );
                }
                if comparison.status != CompletionStatus::VerifiedNoChanges {
                    self.issue(
                        "integrity_and_validation.completion.status",
                        "integrity claims require VerifiedNoChanges",
                    );
                }
                match &comparison.current_fingerprint {
                    Availability::Present(current) if current == &comparison.start_fingerprint => {}
                    Availability::Present(_) => self.issue(
                        "integrity_and_validation.completion.current_fingerprint",
                        "current Git fingerprint must equal the start fingerprint",
                    ),
                    Availability::Empty | Availability::Unavailable => self.issue(
                        "integrity_and_validation.completion.current_fingerprint",
                        "current Git fingerprint is unavailable",
                    ),
                }
                match &comparison.current_filesystem_fingerprint {
                    Availability::Present(current)
                        if current == &comparison.start_filesystem_fingerprint => {}
                    Availability::Present(_) => self.issue(
                        "integrity_and_validation.completion.current_filesystem_fingerprint",
                        "current filesystem fingerprint must equal the start fingerprint",
                    ),
                    Availability::Empty | Availability::Unavailable => self.issue(
                        "integrity_and_validation.completion.current_filesystem_fingerprint",
                        "current filesystem fingerprint is unavailable",
                    ),
                }
                if !comparison.failure_reason.is_empty() {
                    self.issue(
                        "integrity_and_validation.completion.failure_reason",
                        "VerifiedNoChanges must have an empty failure reason",
                    );
                }
            }
        }
    }

    fn require_verified_completion(
        &mut self,
        completion: &Availability<CompletionComparison>,
        field: &str,
    ) {
        if !matches!(completion, Availability::Present(value) if value.status == CompletionStatus::VerifiedNoChanges)
        {
            self.issue(
                field,
                "a final renderer requires VerifiedNoChanges completion integrity",
            );
        }
    }

    fn validate_serialized_boundary_strings(&mut self, report: &ResearchReport) {
        let value = match serde_json::to_value(report) {
            Ok(value) => value,
            Err(error) => {
                self.issue(
                    "serialization",
                    format!("report cannot be serialized: {error}"),
                );
                return;
            }
        };
        walk_boundary_json(&value, "report", &mut self.reasons);
    }

    fn validate_evidence_citation(&mut self, field: &str, citation: &EvidenceCitation) {
        self.validate_evidence_id(&format!("{field}.id"), &citation.id);
        self.validate_evidence_locator(&format!("{field}.locator"), &citation.locator);
        if let Availability::Present(quote) = &citation.quote {
            if quote.as_str().is_empty() {
                self.issue(format!("{field}.quote"), "present quote cannot be empty");
            }
        }
    }

    fn validate_evidence_reference(&mut self, field: &str, reference: &EvidenceReference) {
        if reference.source.name.as_str().trim().is_empty()
            || reference.source.name.as_str().contains('\0')
        {
            self.issue(
                format!("{field}.source"),
                "source identity must be non-empty and NUL-free",
            );
        }
        match &reference.locator {
            EvidenceReferenceLocator::File(locator) => {
                self.validate_evidence_locator(&format!("{field}.locator"), locator)
            }
            EvidenceReferenceLocator::WorktreePath(path) => {
                self.validate_repo_path(&format!("{field}.locator"), path)
            }
            EvidenceReferenceLocator::GitRef(value)
            | EvidenceReferenceLocator::RemoteSnapshot(value)
            | EvidenceReferenceLocator::RemoteReference(value) => {
                if value.as_str().trim().is_empty() || value.as_str().contains('\0') {
                    self.issue(
                        format!("{field}.locator"),
                        "locator must be non-empty and NUL-free",
                    );
                }
            }
        }
    }

    fn validate_evidence_locator(&mut self, field: &str, locator: &EvidenceLocator) {
        self.validate_repo_path(&format!("{field}.path"), &locator.path);
        self.validate_span(&format!("{field}.span"), locator.span);
    }

    fn validate_located_text(&mut self, field: &str, value: &crate::LocatedText) {
        self.non_empty(&format!("{field}.raw"), &value.raw);
        self.non_empty(&format!("{field}.value"), &value.value);
        self.validate_span(&format!("{field}.span"), value.span);
    }

    fn validate_availability_observation(&mut self, field: &str, value: &Availability<ExactText>) {
        if let Availability::Present(value) = value {
            if value.as_str().is_empty() {
                self.issue(field, "present observation cannot be empty");
            }
        }
    }

    fn validate_availability_text_list(
        &mut self,
        field: &str,
        value: &Availability<Vec<ExactText>>,
    ) {
        if let Availability::Present(values) = value {
            for (index, value) in values.iter().enumerate() {
                if value.as_str().trim().is_empty() {
                    self.issue(format!("{field}[{index}]"), "text must be non-empty");
                }
            }
        }
    }

    fn validate_repo_path(&mut self, field: &str, path: &RepoRelativePath) {
        if RepoRelativePath::new(path.as_str().to_owned()).is_err() {
            self.issue(field, "path is not a normalized repository-relative path");
        }
        if is_visualization_path(path.as_str()) {
            self.issue(
                field,
                "visualization identifiers are outside the audit boundary",
            );
        }
    }

    fn validate_span(&mut self, field: &str, span: InclusiveSpan) {
        if span.start == 0 || span.end == 0 || span.end < span.start {
            self.issue(field, "span must be one-based and have end >= start");
        }
    }

    fn validate_full_id(&mut self, field: &str, id: &FullId) {
        if FullId::new(id.as_str().to_owned()).is_err() {
            self.issue(
                field,
                "ID must be a complete 40- or 64-character hexadecimal object ID",
            );
        }
    }

    fn validate_evidence_id(&mut self, field: &str, id: &EvidenceId) {
        if EvidenceId::new(id.as_str().to_owned()).is_err() {
            self.issue(field, "ID must be non-empty ASCII identifier text");
        }
    }

    fn insert_evidence_id(&mut self, id: &EvidenceId, field: &str) {
        if !self.evidence_ids.insert(id.clone()) {
            self.issue(field, format!("duplicate evidence ID `{id}`"));
        }
    }

    fn validate_fingerprint(&mut self, field: &str, fingerprint: &Fingerprint) {
        if Fingerprint::new(fingerprint.as_str().to_owned()).is_err() {
            self.issue(field, "fingerprint must be non-empty hexadecimal text");
        }
    }

    fn validate_pattern(&mut self, field: &str, pattern: &ExactText) {
        if pattern.as_str().trim().is_empty() || pattern.as_str().contains('\0') {
            self.issue(field, "pattern must be non-empty and NUL-free");
        }
    }

    fn validate_text_identifier(&mut self, field: &str, value: &ExactText) {
        if value.as_str().trim().is_empty() {
            self.issue(field, "value must be non-empty");
        }
    }

    fn non_empty(&mut self, field: &str, value: &ExactText) {
        if value.as_str().trim().is_empty() {
            self.issue(field, "value must contain non-whitespace text");
        }
    }

    fn bounded_text(&mut self, field: &str, value: &ExactText, minimum: usize, maximum: usize) {
        self.bounded_str(field, value.as_str(), minimum, maximum);
    }

    fn bounded_str(&mut self, field: &str, value: &str, minimum: usize, maximum: usize) {
        let length = value.chars().count();
        if length < minimum || length > maximum || value.trim().is_empty() {
            self.issue(
                field,
                format!("text must be non-whitespace and contain {minimum}..={maximum} characters"),
            );
        }
    }
}

fn report_conclusion_collections<'a>(
    report: &'a ResearchReport,
) -> [(&'static str, &'a [LabelledConclusion]); 10] {
    [
        (
            "evidence_catalog.source_gaps",
            report.evidence_catalog.source_gaps.as_slice(),
        ),
        (
            "evidence_catalog.conclusions",
            report.evidence_catalog.conclusions.as_slice(),
        ),
        (
            "run_identity_and_scope.gaps",
            report.run_identity_and_scope.gaps.as_slice(),
        ),
        (
            "working_tree_state.gaps",
            report.working_tree_state.gaps.as_slice(),
        ),
        (
            "release_evidence_and_baseline.gaps",
            report.release_evidence_and_baseline.gaps.as_slice(),
        ),
        ("delta.gaps", report.delta.gaps.as_slice()),
        (
            "artifact_inventory.gaps",
            report.artifact_inventory.gaps.as_slice(),
        ),
        (
            "ignore_research_and_removal_register.gaps",
            report.ignore_research_and_removal_register.gaps.as_slice(),
        ),
        (
            "ci_inventory_and_causality.gaps",
            report.ci_inventory_and_causality.gaps.as_slice(),
        ),
        (
            "integrity_and_validation.gaps",
            report.integrity_and_validation.gaps.as_slice(),
        ),
    ]
}

fn inverse_status(status: ArtifactStatus) -> ArtifactStatus {
    match status {
        ArtifactStatus::Yes => ArtifactStatus::No,
        ArtifactStatus::No => ArtifactStatus::Yes,
        ArtifactStatus::Unverified => ArtifactStatus::Unverified,
    }
}

fn present_workflows(value: &Availability<Vec<WorkflowRecord>>) -> Option<&[WorkflowRecord]> {
    match value {
        Availability::Present(records) => Some(records.as_slice()),
        Availability::Empty | Availability::Unavailable => None,
    }
}

fn present_workflow_inventory(
    value: &Availability<WorkflowInventory>,
) -> Option<&WorkflowInventory> {
    match value {
        Availability::Present(inventory) => Some(inventory),
        Availability::Empty | Availability::Unavailable => None,
    }
}

fn validate_rendered_headings(rendered: &str) -> Result<(), String> {
    let actual = rendered
        .lines()
        .filter_map(|line| line.strip_prefix("## "))
        .collect::<Vec<_>>();
    let expected = RESEARCH_REPORT_SECTION_HEADINGS.to_vec();
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "rendered report must contain exactly the ten fixed headings in order; got {actual:?}"
        ))
    }
}

fn walk_boundary_json(value: &Value, field: &str, reasons: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let (Some(Value::Number(start)), Some(Value::Number(end))) =
                (object.get("start"), object.get("end"))
            {
                let start = start.as_u64().unwrap_or(0);
                let end = end.as_u64().unwrap_or(0);
                if start == 0 || end == 0 || end < start {
                    reasons.push(format!(
                        "{field}: inclusive span must be one-based and have end >= start"
                    ));
                }
            }
            if let (Some(Value::Number(line)), Some(Value::Number(column))) =
                (object.get("line"), object.get("column"))
            {
                if line.as_u64().unwrap_or(0) == 0 || column.as_u64().unwrap_or(0) == 0 {
                    reasons.push(format!(
                        "{field}: source position must use one-based line and column"
                    ));
                }
            }
            for (key, child) in object {
                let child_field = format!("{field}.{key}");
                if matches!(
                    key.as_str(),
                    "path" | "workflow_path" | "destination" | "repository_relative_path"
                ) || key.ends_with("_path")
                {
                    if let Value::String(path) = child {
                        if RepoRelativePath::new(path.clone()).is_err() {
                            reasons
                                .push(format!("{child_field}: invalid repository-relative path"));
                        }
                        if is_visualization_path(path) {
                            reasons.push(format!(
                                "{child_field}: visualization identifier is denylisted"
                            ));
                        }
                    }
                }
                walk_boundary_json(child, &child_field, reasons);
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                walk_boundary_json(child, &format!("{field}[{index}]"), reasons);
            }
        }
        Value::String(text) => {
            if is_visualization_path(text) {
                reasons.push(format!("{field}: visualization identifier is denylisted"));
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn is_artifact_path(path: &str) -> bool {
    path == ARTIFACT_DIRECTORY || path.starts_with(&format!("{ARTIFACT_DIRECTORY}/"))
}

fn failure_reason_text(comparison: &CompletionComparison) -> Option<&str> {
    match &comparison.failure_reason {
        Availability::Present(reason) => Some(reason.as_str()),
        Availability::Empty | Availability::Unavailable => None,
    }
}

fn stable_completion(
    session: &crate::AuditSession,
    allow_created_artifact_ancestors: bool,
) -> Result<CompletionComparison, ReportPublicationError> {
    // The foundation comparison captures the filesystem before its Git
    // identity probe. Git may atomically replace `.git/index` during that
    // read-only probe, changing only the index inode. Capture the filesystem
    // once after the probe and normalize that known ordering race; all content,
    // type, symlink, permission, hard-link, and non-index identity changes fail.
    let comparison = session.compare_completion();
    let current_filesystem =
        crate::capture_filesystem_snapshot(session.boundary().repository_root())
            .map_err(|error| ReportPublicationError::Foundation(error))?;
    let current_git_matches = matches!(
        &comparison.current_fingerprint,
        Availability::Present(current) if current == &comparison.start_fingerprint
    );
    if !current_git_matches {
        return Err(ReportPublicationError::Integrity(
            failure_reason_text(&comparison)
                .unwrap_or("Git identity or remote fingerprint changed")
                .to_owned(),
        ));
    }
    let filesystem_matches = equivalent_outside_filesystem(
        &session.snapshot().filesystem,
        &current_filesystem,
        allow_created_artifact_ancestors,
    );
    let filesystem_only_failure = matches!(
        &comparison.failure_reason,
        Availability::Present(reason)
            if reason.as_str() == "outside-artifact filesystem snapshot changed"
    );
    if !filesystem_matches
        || (comparison.status != CompletionStatus::VerifiedNoChanges && !filesystem_only_failure)
    {
        return Err(ReportPublicationError::Integrity(
            failure_reason_text(&comparison)
                .unwrap_or("outside-artifact filesystem snapshot changed")
                .to_owned(),
        ));
    }
    let mut normalized = comparison;
    normalized.status = CompletionStatus::VerifiedNoChanges;
    normalized.current_filesystem_fingerprint =
        Availability::Present(session.snapshot().filesystem.fingerprint().clone());
    normalized.failure_reason = Availability::Empty;
    Ok(normalized)
}

fn equivalent_outside_filesystem(
    start: &crate::FilesystemSnapshot,
    current: &crate::FilesystemSnapshot,
    allow_created_artifact_ancestors: bool,
) -> bool {
    if !allow_created_artifact_ancestors && start.entries.len() != current.entries.len() {
        return false;
    }
    let index_path = match crate::RepoRelativePath::new(".git/index") {
        Ok(path) => path,
        Err(_) => return false,
    };
    let index_replaced = match (
        start.entries.get(&index_path),
        current.entries.get(&index_path),
    ) {
        (Some(start_entry), Some(current_entry)) => {
            start_entry.metadata.inode != current_entry.metadata.inode
        }
        _ => false,
    };
    if !start.entries.iter().all(|(path, start_entry)| {
        let Some(current_entry) = current.entries.get(path) else {
            return false;
        };
        if allow_created_artifact_ancestors && is_artifact_ancestor_path(path.as_str()) {
            equivalent_artifact_ancestor_entry(start_entry, current_entry)
        } else {
            match path.as_str() {
                ".git" => {
                    equivalent_git_directory_entry(start_entry, current_entry, index_replaced)
                }
                ".git/index" => {
                    equivalent_git_index_entry(start_entry, current_entry, index_replaced)
                }
                _ => start_entry == current_entry,
            }
        }
    }) {
        return false;
    }
    if allow_created_artifact_ancestors {
        current.entries.iter().all(|(path, current_entry)| {
            start.entries.contains_key(path)
                || (is_artifact_ancestor_path(path.as_str())
                    && current_entry.entry_type == crate::FilesystemEntryType::Directory
                    && current_entry.metadata.is_directory
                    && !current_entry.metadata.is_symlink)
        })
    } else {
        true
    }
}

fn is_artifact_ancestor_path(path: &str) -> bool {
    matches!(path, ".kiro" | ".kiro/specs")
}

fn equivalent_artifact_ancestor_entry(
    start: &crate::FilesystemEntrySnapshot,
    current: &crate::FilesystemEntrySnapshot,
) -> bool {
    start.path == current.path
        && start.entry_type == crate::FilesystemEntryType::Directory
        && current.entry_type == crate::FilesystemEntryType::Directory
        && start.content_fingerprint.is_empty()
        && current.content_fingerprint.is_empty()
        && start.symlink_target.is_empty()
        && current.symlink_target.is_empty()
        && start.metadata.is_directory
        && current.metadata.is_directory
        && !start.metadata.is_symlink
        && !current.metadata.is_symlink
        && start.metadata.device == current.metadata.device
        && start.metadata.inode == current.metadata.inode
        && start.metadata.hard_links == current.metadata.hard_links
        && start.metadata.mode == current.metadata.mode
}

fn equivalent_git_directory_entry(
    start: &crate::FilesystemEntrySnapshot,
    current: &crate::FilesystemEntrySnapshot,
    index_replaced: bool,
) -> bool {
    start.path == current.path
        && start.entry_type == current.entry_type
        && start.content_fingerprint == current.content_fingerprint
        && start.symlink_target == current.symlink_target
        && start.metadata.is_directory == current.metadata.is_directory
        && start.metadata.is_regular_file == current.metadata.is_regular_file
        && start.metadata.is_symlink == current.metadata.is_symlink
        && start.metadata.bytes == current.metadata.bytes
        && (index_replaced
            || start.metadata.modified_utc_seconds == current.metadata.modified_utc_seconds)
        && start.metadata.device == current.metadata.device
        && start.metadata.inode == current.metadata.inode
        && start.metadata.hard_links == current.metadata.hard_links
        && start.metadata.mode == current.metadata.mode
}

fn equivalent_git_index_entry(
    start: &crate::FilesystemEntrySnapshot,
    current: &crate::FilesystemEntrySnapshot,
    index_replaced: bool,
) -> bool {
    start.path == current.path
        && start.entry_type == current.entry_type
        && start.content_fingerprint == current.content_fingerprint
        && start.symlink_target == current.symlink_target
        && start.metadata.is_directory == current.metadata.is_directory
        && start.metadata.is_regular_file == current.metadata.is_regular_file
        && start.metadata.is_symlink == current.metadata.is_symlink
        && start.metadata.bytes == current.metadata.bytes
        && (index_replaced
            || start.metadata.modified_utc_seconds == current.metadata.modified_utc_seconds)
        && start.metadata.device == current.metadata.device
        && (index_replaced || start.metadata.inode == current.metadata.inode)
        && start.metadata.hard_links == current.metadata.hard_links
        && start.metadata.mode == current.metadata.mode
}

fn ensure_verified_completion(
    comparison: &CompletionComparison,
) -> Result<(), ReportPublicationError> {
    if comparison.status != CompletionStatus::VerifiedNoChanges {
        let reason = match &comparison.failure_reason {
            Availability::Present(reason) => reason.as_str().to_owned(),
            Availability::Empty => "completion comparison was not verified".to_owned(),
            Availability::Unavailable => {
                "completion comparison failure reason unavailable".to_owned()
            }
        };
        return Err(ReportPublicationError::Integrity(reason));
    }
    if !matches!(
        &comparison.current_fingerprint,
        Availability::Present(current) if current == &comparison.start_fingerprint
    ) {
        return Err(ReportPublicationError::Integrity(
            "current Git identity/fingerprint is unavailable or changed".to_owned(),
        ));
    }
    if !matches!(
        &comparison.current_filesystem_fingerprint,
        Availability::Present(current) if current == &comparison.start_filesystem_fingerprint
    ) {
        return Err(ReportPublicationError::Integrity(
            "outside-artifact filesystem fingerprint is unavailable or changed".to_owned(),
        ));
    }
    Ok(())
}

fn prepare_artifact_directory(
    session: &crate::AuditSession,
) -> Result<(PathBuf, bool), ReportPublicationError> {
    let root = session.boundary().repository_root();
    let artifact = session.boundary().artifact_directory();
    let expected = root.join(ARTIFACT_DIRECTORY);
    if artifact != &expected
        || artifact.strip_prefix(root).ok() != Some(Path::new(ARTIFACT_DIRECTORY))
    {
        return Err(ReportPublicationError::Boundary(
            "artifact directory is not the fixed in-repository research path".to_owned(),
        ));
    }
    let created = ensure_directory_chain(root, ARTIFACT_DIRECTORY)?;
    Ok((artifact.to_path_buf(), created))
}

fn ensure_directory_chain(root: &Path, relative: &str) -> Result<bool, ReportPublicationError> {
    let mut current = root.to_path_buf();
    let mut created = false;
    for component in relative.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(ReportPublicationError::Boundary(
                "artifact path contains an unsafe component".to_owned(),
            ));
        }
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(ReportPublicationError::Boundary(format!(
                        "artifact path component `{}` is not a real directory",
                        current.display()
                    )));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|source| ReportPublicationError::Io {
                    operation: "create report artifact directory",
                    source,
                })?;
                created = true;
                let created_metadata = fs::symlink_metadata(&current).map_err(|source| {
                    ReportPublicationError::Io {
                        operation: "inspect created report artifact directory",
                        source,
                    }
                })?;
                if created_metadata.file_type().is_symlink() || !created_metadata.is_dir() {
                    return Err(ReportPublicationError::Boundary(format!(
                        "artifact path component `{}` is not a real directory",
                        current.display()
                    )));
                }
            }
            Err(source) => {
                return Err(ReportPublicationError::Io {
                    operation: "inspect report artifact directory",
                    source,
                });
            }
        }
    }
    Ok(created)
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn stage_temporary_file(
    artifact: &Path,
    contents: &[u8],
    extension: &str,
) -> Result<PathBuf, ReportPublicationError> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = format!(
        ".research-report.tmp-{}-{nonce}-{counter}.{extension}",
        std::process::id()
    );
    let path = artifact.join(name);
    if path.parent() != Some(artifact) {
        return Err(ReportPublicationError::Boundary(
            "temporary report path escaped the artifact directory".to_owned(),
        ));
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600).custom_flags(0o400000); // O_NOFOLLOW
    }
    let mut file = match options.open(&path) {
        Ok(file) => file,
        Err(source) => {
            return Err(ReportPublicationError::Io {
                operation: "open report temporary file",
                source,
            })
        }
    };
    let result = (|| {
        file.write_all(contents)
            .map_err(|source| ReportPublicationError::Io {
                operation: "write report temporary file",
                source,
            })?;
        file.flush().map_err(|source| ReportPublicationError::Io {
            operation: "flush report temporary file",
            source,
        })?;
        file.sync_all()
            .map_err(|source| ReportPublicationError::Io {
                operation: "sync report temporary file",
                source,
            })?;
        let metadata = file
            .metadata()
            .map_err(|source| ReportPublicationError::Io {
                operation: "inspect report temporary file",
                source,
            })?;
        if !metadata.is_file() || hard_link_count(&metadata) != 1 {
            return Err(ReportPublicationError::Boundary(
                "temporary report file is not a single regular file".to_owned(),
            ));
        }
        Ok(())
    })();
    drop(file);
    if result.is_err() {
        remove_if_regular_temp(&path);
    }
    result.map(|()| path)
}

fn validate_final_output_path(artifact: &Path, path: &Path) -> Result<(), ReportPublicationError> {
    if path.parent() != Some(artifact) {
        return Err(ReportPublicationError::Boundary(
            "final report path must be a direct artifact-directory child".to_owned(),
        ));
    }
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            ReportPublicationError::Boundary("final report path has no safe filename".to_owned())
        })?;
    ReportOutput::parse(filename).map_err(ReportPublicationError::Foundation)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(ReportPublicationError::Boundary(
                    "final report path may not be a symlink".to_owned(),
                ));
            }
            if !metadata.is_file() {
                return Err(ReportPublicationError::Boundary(
                    "final report path must be a regular file".to_owned(),
                ));
            }
            if hard_link_count(&metadata) != 1 {
                return Err(ReportPublicationError::Boundary(
                    "final report path may not be a hardlink".to_owned(),
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(ReportPublicationError::Io {
                operation: "inspect final report path",
                source,
            })
        }
    }
    Ok(())
}

fn atomic_rename(from: &Path, to: &Path) -> Result<(), ReportPublicationError> {
    if from.parent() != to.parent() {
        return Err(ReportPublicationError::Boundary(
            "temporary and final report paths must share one directory".to_owned(),
        ));
    }
    fs::rename(from, to).map_err(|source| ReportPublicationError::Io {
        operation: "atomically rename report output",
        source,
    })
}

fn sync_directory(path: &Path) -> Result<(), ReportPublicationError> {
    let directory = File::open(path).map_err(|source| ReportPublicationError::Io {
        operation: "open report artifact directory for sync",
        source,
    })?;
    directory
        .sync_all()
        .map_err(|source| ReportPublicationError::Io {
            operation: "sync report artifact directory",
            source,
        })
}

fn absolute_path(path: &Path) -> Result<crate::AbsolutePath, ReportPublicationError> {
    let value = path.to_str().ok_or_else(|| {
        ReportPublicationError::Boundary("report path is not valid UTF-8".to_owned())
    })?;
    crate::AbsolutePath::new(value.to_owned()).map_err(ReportPublicationError::Foundation)
}

fn remove_if_regular_temp(path: &Path) {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.file_type().is_symlink()
            && metadata.is_file()
            && hard_link_count(&metadata) == 1
        {
            let _ = fs::remove_file(path);
        }
    }
}

fn hard_link_count(metadata: &Metadata) -> u64 {
    #[cfg(unix)]
    {
        metadata.nlink()
    }
    #[cfg(not(unix))]
    {
        1
    }
}
