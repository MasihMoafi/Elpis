//! Read-only artifact inventory, classification, and evidence discovery.
//!
//! The inventory is deliberately a report over already-audited local inputs.  It
//! does not execute generators, build commands, or network operations.  The
//! root convenience collector may ask the existing read-only Git collectors for
//! local path inventories, but producer discovery itself only reads textual
//! files from the start snapshot.

use crate::{
    capture_start_snapshot, capture_worktree_inventory, collect_local_release_evidence,
    Availability, EvidenceReference, EvidenceReferenceLocator, EvidenceSourceIdentity,
    EvidenceSourceKind, ExactText, FilesystemEntrySnapshot, FilesystemEntryType,
    FilesystemSnapshot, FoundationError, FullId, InclusiveSpan, InventoryState, RepoRelativePath,
    StartSnapshot, UtcSeconds, WorktreeInventory,
};
use serde::de::{self, DeserializeOwned};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// The independent result of inspecting one artifact source.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum ArtifactStatus {
    Yes,
    No,
    Unverified,
}

impl Default for ArtifactStatus {
    fn default() -> Self {
        Self::Unverified
    }
}

impl ArtifactStatus {
    pub const fn is_yes(self) -> bool {
        matches!(self, Self::Yes)
    }

    pub const fn is_no(self) -> bool {
        matches!(self, Self::No)
    }

    pub const fn is_unverified(self) -> bool {
        matches!(self, Self::Unverified)
    }

    fn from_membership<T: Ord>(source: &Availability<BTreeSet<T>>, value: &T) -> Self {
        match source {
            Availability::Empty => Self::No,
            Availability::Unavailable => Self::Unverified,
            Availability::Present(values) => {
                if values.contains(value) {
                    Self::Yes
                } else {
                    Self::No
                }
            }
        }
    }

    const fn inverse(self) -> Self {
        match self {
            Self::Yes => Self::No,
            Self::No => Self::Yes,
            Self::Unverified => Self::Unverified,
        }
    }
}

/// The one primary classification assigned to each candidate.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub enum PrimaryClassification {
    ArchiveArtifact,
    HtmlArtifact,
    GeneratedArtifact,
    BuildOutput,
    Cache,
    Report,
    LocalOnlyFile,
    ObsoleteFile,
    Custom(ExactText),
}

impl PrimaryClassification {
    pub fn custom(value: impl Into<String>) -> Result<Self, FoundationError> {
        let value = value.into();
        validate_bounded_text("primary_classification", &value, 1, 50)?;
        Ok(Self::Custom(ExactText::new(value)))
    }

    pub fn archive_artifact() -> Self {
        Self::ArchiveArtifact
    }

    pub fn html_artifact() -> Self {
        Self::HtmlArtifact
    }

    pub fn generated_artifact() -> Self {
        Self::GeneratedArtifact
    }

    pub fn build_output() -> Self {
        Self::BuildOutput
    }

    pub fn cache() -> Self {
        Self::Cache
    }

    pub fn report() -> Self {
        Self::Report
    }

    pub fn local_only_file() -> Self {
        Self::LocalOnlyFile
    }

    pub fn obsolete_file() -> Self {
        Self::ObsoleteFile
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::ArchiveArtifact => "Archive Artifact",
            Self::HtmlArtifact => "HTML Artifact",
            Self::GeneratedArtifact => "Generated Artifact",
            Self::BuildOutput => "build output",
            Self::Cache => "cache",
            Self::Report => "report",
            Self::LocalOnlyFile => "local-only file",
            Self::ObsoleteFile => "obsolete file",
            Self::Custom(value) => value.as_str(),
        }
    }

    pub fn is_custom(&self) -> bool {
        matches!(self, Self::Custom(_))
    }
}

impl<'de> Deserialize<'de> for PrimaryClassification {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        enum Wire {
            ArchiveArtifact,
            HtmlArtifact,
            GeneratedArtifact,
            BuildOutput,
            Cache,
            Report,
            LocalOnlyFile,
            ObsoleteFile,
            Custom(String),
        }

        match Wire::deserialize(deserializer)? {
            Wire::ArchiveArtifact => Ok(Self::ArchiveArtifact),
            Wire::HtmlArtifact => Ok(Self::HtmlArtifact),
            Wire::GeneratedArtifact => Ok(Self::GeneratedArtifact),
            Wire::BuildOutput => Ok(Self::BuildOutput),
            Wire::Cache => Ok(Self::Cache),
            Wire::Report => Ok(Self::Report),
            Wire::LocalOnlyFile => Ok(Self::LocalOnlyFile),
            Wire::ObsoleteFile => Ok(Self::ObsoleteFile),
            Wire::Custom(value) => Self::custom(value).map_err(de::Error::custom),
        }
    }
}

/// The closed purpose vocabulary used by the inventory.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum PurposeLabel {
    Source,
    RuntimeAsset,
    Documentation,
    Test,
    PublishedEvaluation,
    Local,
    Other,
}

impl PurposeLabel {
    pub const ALL: [Self; 7] = [
        Self::Source,
        Self::RuntimeAsset,
        Self::Documentation,
        Self::Test,
        Self::PublishedEvaluation,
        Self::Local,
        Self::Other,
    ];
}

/// A non-empty deterministic set of purpose labels.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct PurposeLabelSet(BTreeSet<PurposeLabel>);

impl PurposeLabelSet {
    pub fn new<I>(labels: I) -> Result<Self, FoundationError>
    where
        I: IntoIterator<Item = PurposeLabel>,
    {
        let labels = labels.into_iter().collect::<BTreeSet<_>>();
        if labels.is_empty() {
            return Err(FoundationError::invalid(
                "purpose_labels",
                "at least one purpose label is required",
            ));
        }
        Ok(Self(labels))
    }

    pub fn singleton(label: PurposeLabel) -> Self {
        Self(std::iter::once(label).collect())
    }

    pub fn contains(&self, label: PurposeLabel) -> bool {
        self.0.contains(&label)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &PurposeLabel> {
        self.0.iter()
    }

    pub fn as_set(&self) -> &BTreeSet<PurposeLabel> {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PurposeLabelSet {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let labels = BTreeSet::<PurposeLabel>::deserialize(deserializer)?;
        Self::new(labels).map_err(de::Error::custom)
    }
}

/// A bounded, exact purpose explanation.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct PurposeDescription(ExactText);

impl PurposeDescription {
    pub fn new(value: impl Into<String>) -> Result<Self, FoundationError> {
        let value = value.into();
        validate_bounded_text("purpose_description", &value, 1, 500)?;
        if value.trim().is_empty() {
            return Err(FoundationError::invalid(
                "purpose_description",
                "the description must contain non-whitespace text",
            ));
        }
        Ok(Self(ExactText::new(value)))
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub fn into_inner(self) -> ExactText {
        self.0
    }
}

impl<'de> Deserialize<'de> for PurposeDescription {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

/// Purpose labels and their cited explanation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PurposeEvidence {
    pub labels: PurposeLabelSet,
    pub description: PurposeDescription,
    pub evidence: Vec<EvidenceReference>,
}

impl PurposeEvidence {
    pub fn new(
        labels: PurposeLabelSet,
        description: PurposeDescription,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        if evidence.is_empty() {
            return Err(FoundationError::invalid(
                "purpose_evidence",
                "a purpose description must have at least one evidence reference",
            ));
        }
        Ok(Self {
            labels,
            description,
            evidence: normalize_evidence(evidence),
        })
    }

    pub fn try_new(
        labels: PurposeLabelSet,
        description: PurposeDescription,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        Self::new(labels, description, evidence)
    }

    pub fn is_required_use(&self) -> bool {
        self.labels.contains(PurposeLabel::Source)
            || self.labels.contains(PurposeLabel::RuntimeAsset)
            || self.labels.contains(PurposeLabel::Documentation)
            || self.labels.contains(PurposeLabel::Test)
            || self.labels.contains(PurposeLabel::PublishedEvaluation)
    }
}

impl<'de> Deserialize<'de> for PurposeEvidence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            labels: PurposeLabelSet,
            description: PurposeDescription,
            evidence: Vec<EvidenceReference>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.labels, wire.description, wire.evidence).map_err(de::Error::custom)
    }
}

/// A named textual consumer, or the exact no-consumer result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ConsumerResult {
    Named {
        name: ExactText,
        evidence: Vec<EvidenceReference>,
    },
    NoConsumer,
}

impl ConsumerResult {
    pub fn named(
        name: impl Into<String>,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(FoundationError::invalid(
                "consumer_name",
                "a named consumer must be non-empty",
            ));
        }
        if evidence.is_empty() {
            return Err(FoundationError::invalid(
                "consumer_evidence",
                "a named consumer must have at least one evidence reference",
            ));
        }
        Ok(Self::Named {
            name: ExactText::new(name),
            evidence: normalize_evidence(evidence),
        })
    }

    pub const fn no_consumer() -> Self {
        Self::NoConsumer
    }

    pub fn is_no_consumer(&self) -> bool {
        matches!(self, Self::NoConsumer)
    }

    pub fn name(&self) -> Option<&ExactText> {
        match self {
            Self::Named { name, .. } => Some(name),
            Self::NoConsumer => None,
        }
    }

    pub fn evidence(&self) -> &[EvidenceReference] {
        match self {
            Self::Named { evidence, .. } => evidence,
            Self::NoConsumer => &[],
        }
    }
}

impl<'de> Deserialize<'de> for ConsumerResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        enum Wire {
            Named {
                name: ExactText,
                evidence: Vec<EvidenceReference>,
            },
            NoConsumer,
        }
        match Wire::deserialize(deserializer)? {
            Wire::Named { name, evidence } => {
                Self::named(name.into_inner(), evidence).map_err(de::Error::custom)
            }
            Wire::NoConsumer => Ok(Self::NoConsumer),
        }
    }
}

/// One named generation command with exact source evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProducerRecord {
    pub name: ExactText,
    pub evidence: Vec<EvidenceReference>,
}

impl ProducerRecord {
    pub fn new(
        name: impl Into<String>,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        let name = name.into();
        let record = Self {
            name: ExactText::new(name),
            evidence: normalize_evidence(evidence),
        };
        record.validate()?;
        Ok(record)
    }

    fn validate(&self) -> Result<(), FoundationError> {
        if self.name.as_str().trim().is_empty() {
            return Err(FoundationError::invalid(
                "producer_name",
                "a named producer must be non-empty",
            ));
        }
        if self.evidence.is_empty() {
            return Err(FoundationError::invalid(
                "producer_evidence",
                "a named producer must have at least one evidence reference",
            ));
        }
        Ok(())
    }
}

/// Producer discovery is explicit: every discovered producer is cited, and an
/// inability to discover one is never silently rendered as an empty list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ProducerDiscovery {
    Named { producers: Vec<ProducerRecord> },
    NotDiscoverable,
    NotApplicable,
}

impl ProducerDiscovery {
    pub fn discovered(producers: Vec<ProducerRecord>) -> Result<Self, FoundationError> {
        if producers.is_empty() {
            return Err(FoundationError::invalid(
                "producer_discovery",
                "discovered producer results must not be empty",
            ));
        }
        for producer in &producers {
            producer.validate()?;
        }
        Ok(Self::Named { producers })
    }

    pub fn named(producers: Vec<ProducerRecord>) -> Result<Self, FoundationError> {
        Self::discovered(producers)
    }

    pub const fn not_discoverable() -> Self {
        Self::NotDiscoverable
    }

    pub const fn not_applicable() -> Self {
        Self::NotApplicable
    }

    pub fn is_not_discoverable(&self) -> bool {
        matches!(self, Self::NotDiscoverable)
    }

    pub fn records(&self) -> &[ProducerRecord] {
        match self {
            Self::Named { producers } => producers,
            Self::NotDiscoverable | Self::NotApplicable => &[],
        }
    }
}

impl<'de> Deserialize<'de> for ProducerDiscovery {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        enum Wire {
            Named { producers: Vec<ProducerRecord> },
            NotDiscoverable,
            NotApplicable,
        }
        match Wire::deserialize(deserializer)? {
            Wire::Named { producers } => Self::discovered(producers).map_err(de::Error::custom),
            Wire::NotDiscoverable => Ok(Self::NotDiscoverable),
            Wire::NotApplicable => Ok(Self::NotApplicable),
        }
    }
}

/// A compatibility status retained for the p12-p14 artifact callers.
///
/// New retention policy code uses [`RetentionRecommendation`] and
/// [`RetentionDetail`].  This enum remains the small legacy projection so old
/// callers can continue to ask whether a candidate was explicitly marked for
/// removal without losing the richer policy record.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum RetentionDecision {
    Unassessed,
    Keep,
    Ignore,
    Remove,
}

impl Default for RetentionDecision {
    fn default() -> Self {
        Self::Unassessed
    }
}

impl RetentionDecision {
    pub const fn is_remove(self) -> bool {
        matches!(self, Self::Remove)
    }
}

/// The four closed retention recommendations. Classification is deliberately
/// separate from this policy vocabulary.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum RetentionRecommendation {
    Retain,
    Remove,
    Move,
    Regenerate,
}

impl Default for RetentionRecommendation {
    fn default() -> Self {
        Self::Retain
    }
}

impl RetentionRecommendation {
    pub const fn is_remove(self) -> bool {
        matches!(self, Self::Remove)
    }
}

/// The result of checking whether required use was found for a candidate.
/// Every state carries evidence; `Unverified` is never treated as proof that a
/// removal is safe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum RequiredUseAssessment {
    NoRequiredUse { evidence: Vec<EvidenceReference> },
    RequiredUse { evidence: Vec<EvidenceReference> },
    Unverified { evidence: Vec<EvidenceReference> },
}

impl RequiredUseAssessment {
    pub fn no_required_use(evidence: Vec<EvidenceReference>) -> Result<Self, FoundationError> {
        let evidence = normalize_evidence(evidence);
        if evidence.is_empty() {
            return Err(FoundationError::invalid(
                "required_use_evidence",
                "a no-required-use assessment needs evidence",
            ));
        }
        Ok(Self::NoRequiredUse { evidence })
    }

    pub fn required_use(evidence: Vec<EvidenceReference>) -> Result<Self, FoundationError> {
        let evidence = normalize_evidence(evidence);
        if evidence.is_empty() {
            return Err(FoundationError::invalid(
                "required_use_evidence",
                "a required-use assessment needs evidence",
            ));
        }
        Ok(Self::RequiredUse { evidence })
    }

    pub fn unverified(evidence: Vec<EvidenceReference>) -> Result<Self, FoundationError> {
        let evidence = normalize_evidence(evidence);
        if evidence.is_empty() {
            return Err(FoundationError::invalid(
                "required_use_evidence",
                "an unverified assessment needs evidence",
            ));
        }
        Ok(Self::Unverified { evidence })
    }

    pub fn is_no_required_use(&self) -> bool {
        matches!(self, Self::NoRequiredUse { .. })
    }

    pub fn is_required_use(&self) -> bool {
        matches!(self, Self::RequiredUse { .. })
    }

    pub fn is_unverified(&self) -> bool {
        matches!(self, Self::Unverified { .. })
    }

    pub fn evidence(&self) -> &[EvidenceReference] {
        match self {
            Self::NoRequiredUse { evidence }
            | Self::RequiredUse { evidence }
            | Self::Unverified { evidence } => evidence,
        }
    }
}

impl<'de> Deserialize<'de> for RequiredUseAssessment {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        enum Wire {
            NoRequiredUse { evidence: Vec<EvidenceReference> },
            RequiredUse { evidence: Vec<EvidenceReference> },
            Unverified { evidence: Vec<EvidenceReference> },
        }
        match Wire::deserialize(deserializer)? {
            Wire::NoRequiredUse { evidence } => {
                Self::no_required_use(evidence).map_err(de::Error::custom)
            }
            Wire::RequiredUse { evidence } => {
                Self::required_use(evidence).map_err(de::Error::custom)
            }
            Wire::Unverified { evidence } => Self::unverified(evidence).map_err(de::Error::custom),
        }
    }
}

/// Evidence and bounded parameters supporting one retention recommendation.
/// The recommendation itself remains a separate closed enum so classification
/// and policy cannot be confused in a report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RetentionDetail {
    pub evidence: Vec<EvidenceReference>,
    pub reason: Option<ExactText>,
    pub destination: Option<RepoRelativePath>,
    pub producer: ProducerDiscovery,
    pub required_use: RequiredUseAssessment,
}

impl RetentionDetail {
    pub fn new(
        evidence: Vec<EvidenceReference>,
        reason: Option<String>,
        destination: Option<RepoRelativePath>,
        producer: ProducerDiscovery,
        required_use: RequiredUseAssessment,
    ) -> Result<Self, FoundationError> {
        let evidence = normalize_evidence(evidence);
        if evidence.is_empty() {
            return Err(FoundationError::invalid(
                "retention_evidence",
                "every retention recommendation needs at least one evidence reference",
            ));
        }
        let reason = reason
            .map(|value| {
                validate_bounded_text("retention_reason", &value, 1, 500)?;
                if value.trim().is_empty() {
                    return Err(FoundationError::invalid(
                        "retention_reason",
                        "the reason must contain non-whitespace text",
                    ));
                }
                Ok(ExactText::new(value))
            })
            .transpose()?;
        if let Some(destination) = &destination {
            validate_bounded_text("retention_destination", destination.as_str(), 1, 500)?;
        }
        if required_use.evidence().is_empty() {
            return Err(FoundationError::invalid(
                "required_use_evidence",
                "the required-use assessment needs evidence",
            ));
        }
        Ok(Self {
            evidence,
            reason,
            destination,
            producer,
            required_use,
        })
    }

    pub fn retain(evidence: Vec<EvidenceReference>) -> Result<Self, FoundationError> {
        let required_use = RequiredUseAssessment::no_required_use(evidence.clone())?;
        Self::new(
            evidence,
            None,
            None,
            ProducerDiscovery::NotApplicable,
            required_use,
        )
    }

    pub fn remove(
        reason: impl Into<String>,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        let required_use = RequiredUseAssessment::no_required_use(evidence.clone())?;
        Self::new(
            evidence,
            Some(reason.into()),
            None,
            ProducerDiscovery::NotApplicable,
            required_use,
        )
    }

    pub fn move_to(
        destination: RepoRelativePath,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        let required_use = RequiredUseAssessment::no_required_use(evidence.clone())?;
        Self::new(
            evidence,
            None,
            Some(destination),
            ProducerDiscovery::NotApplicable,
            required_use,
        )
    }

    pub fn regenerate(
        producer: ProducerDiscovery,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        let required_use = RequiredUseAssessment::no_required_use(evidence.clone())?;
        Self::new(evidence, None, None, producer, required_use)
    }

    pub fn validate_for(
        &self,
        recommendation: RetentionRecommendation,
    ) -> Result<(), FoundationError> {
        if self.evidence.is_empty() {
            return Err(FoundationError::invalid(
                "retention_evidence",
                "every retention recommendation needs evidence",
            ));
        }
        if self.evidence != normalize_evidence(self.evidence.clone()) {
            return Err(FoundationError::invalid(
                "retention_evidence",
                "evidence must be sorted and duplicate-free",
            ));
        }
        match recommendation {
            RetentionRecommendation::Retain => Ok(()),
            RetentionRecommendation::Remove => {
                let Some(reason) = &self.reason else {
                    return Err(FoundationError::invalid(
                        "retention_reason",
                        "remove requires a bounded reason",
                    ));
                };
                validate_bounded_text("retention_reason", reason.as_str(), 1, 500)?;
                if reason.as_str().trim().is_empty() {
                    return Err(FoundationError::invalid(
                        "retention_reason",
                        "the reason must contain non-whitespace text",
                    ));
                }
                if !self.required_use.is_no_required_use() {
                    return Err(FoundationError::boundary(
                        "remove requires evidence that no required use exists",
                    ));
                }
                Ok(())
            }
            RetentionRecommendation::Move => {
                let Some(destination) = &self.destination else {
                    return Err(FoundationError::invalid(
                        "retention_destination",
                        "move requires a bounded non-empty destination",
                    ));
                };
                validate_bounded_text("retention_destination", destination.as_str(), 1, 500)
            }
            RetentionRecommendation::Regenerate => match &self.producer {
                ProducerDiscovery::Named { producers } if !producers.is_empty() => Ok(()),
                ProducerDiscovery::NotDiscoverable => Ok(()),
                _ => Err(FoundationError::invalid(
                    "retention_producer",
                    "regenerate needs a producer or explicit not-discoverable/none value",
                )),
            },
        }
    }

    pub fn evidence(&self) -> &[EvidenceReference] {
        &self.evidence
    }
}

impl<'de> Deserialize<'de> for RetentionDetail {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            evidence: Vec<EvidenceReference>,
            reason: Option<ExactText>,
            destination: Option<RepoRelativePath>,
            producer: ProducerDiscovery,
            required_use: RequiredUseAssessment,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(
            wire.evidence,
            wire.reason.map(ExactText::into_inner),
            wire.destination,
            wire.producer,
            wire.required_use,
        )
        .map_err(de::Error::custom)
    }
}

/// A validated, path-bound retention decision used by later report assembly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RetentionDecisionRecord {
    pub path: RepoRelativePath,
    pub recommendation: RetentionRecommendation,
    pub detail: RetentionDetail,
}

impl RetentionDecisionRecord {
    pub fn new(
        path: RepoRelativePath,
        recommendation: RetentionRecommendation,
        detail: RetentionDetail,
    ) -> Result<Self, FoundationError> {
        detail.validate_for(recommendation)?;
        Ok(Self {
            path,
            recommendation,
            detail,
        })
    }

    pub fn is_remove(&self) -> bool {
        self.recommendation.is_remove()
    }
}

impl<'de> Deserialize<'de> for RetentionDecisionRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            path: RepoRelativePath,
            recommendation: RetentionRecommendation,
            detail: RetentionDetail,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.path, wire.recommendation, wire.detail).map_err(de::Error::custom)
    }
}

/// Compatibility alias for callers that call one validated policy item a
/// retention record.
pub type RetentionRecord = RetentionDecisionRecord;
/// Compatibility alias for callers that use "kind" for the four recommendations.
pub type RetentionKind = RetentionRecommendation;
/// Classification and retention are intentionally different types, while this
/// alias gives ignore/report callers a stable category name.
pub type ArtifactCategory = PrimaryClassification;

/// A remote artifact state supplied by the caller.  This type is an injection
/// seam only; constructing it never contacts or mutates a remote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteArtifactSnapshot {
    pub revision: Availability<FullId>,
    pub paths: Availability<BTreeSet<RepoRelativePath>>,
}

impl RemoteArtifactSnapshot {
    pub fn new(
        revision: Availability<FullId>,
        paths: Availability<BTreeSet<RepoRelativePath>>,
    ) -> Self {
        Self { revision, paths }
    }

    pub fn present<I>(revision: FullId, paths: I) -> Result<Self, FoundationError>
    where
        I: IntoIterator<Item = RepoRelativePath>,
    {
        Ok(Self::new(
            Availability::Present(revision),
            Availability::Present(paths.into_iter().collect()),
        ))
    }

    pub const fn empty() -> Self {
        Self {
            revision: Availability::Empty,
            paths: Availability::Empty,
        }
    }

    pub const fn unavailable() -> Self {
        Self {
            revision: Availability::Unavailable,
            paths: Availability::Unavailable,
        }
    }
}

/// The independently available local and injected remote inputs to an audit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactInventoryInput {
    pub audited_revision: FullId,
    pub audited_at_utc: UtcSeconds,
    pub tracked_paths: Availability<BTreeSet<RepoRelativePath>>,
    pub untracked_paths: Availability<BTreeSet<RepoRelativePath>>,
    pub ignored_paths: Availability<BTreeSet<RepoRelativePath>>,
    pub filesystem_paths: Availability<BTreeSet<RepoRelativePath>>,
    pub remote: Availability<RemoteArtifactSnapshot>,
}

impl ArtifactInventoryInput {
    pub fn new(
        audited_revision: FullId,
        audited_at_utc: UtcSeconds,
        tracked_paths: Availability<BTreeSet<RepoRelativePath>>,
        filesystem_paths: Availability<BTreeSet<RepoRelativePath>>,
    ) -> Self {
        Self {
            audited_revision,
            audited_at_utc,
            tracked_paths,
            untracked_paths: Availability::Empty,
            ignored_paths: Availability::Empty,
            filesystem_paths,
            remote: Availability::Empty,
        }
    }

    pub fn from_sources(
        tracked_paths: Availability<BTreeSet<RepoRelativePath>>,
        filesystem_paths: Availability<BTreeSet<RepoRelativePath>>,
        audited_revision: FullId,
        audited_at_utc: UtcSeconds,
    ) -> Self {
        Self::new(
            audited_revision,
            audited_at_utc,
            tracked_paths,
            filesystem_paths,
        )
    }

    pub fn from_snapshot(snapshot: &StartSnapshot) -> Self {
        Self::from_start_snapshot(snapshot)
    }

    pub fn from_start_snapshot(snapshot: &StartSnapshot) -> Self {
        let filesystem_paths = snapshot
            .filesystem
            .entries
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        Self::new(
            snapshot.identity.head.clone(),
            snapshot.captured_at_utc,
            Availability::Unavailable,
            Availability::Present(filesystem_paths),
        )
    }

    pub fn from_snapshot_and_worktree(
        snapshot: &StartSnapshot,
        worktree: &WorktreeInventory,
        ignored_paths: Availability<BTreeSet<RepoRelativePath>>,
    ) -> Self {
        let mut input = Self::new(
            snapshot.identity.head.clone(),
            snapshot.captured_at_utc,
            Availability::Present(worktree.tracked.iter().cloned().collect()),
            Availability::Present(snapshot.filesystem.entries.keys().cloned().collect()),
        );
        input.untracked_paths = Availability::Present(
            worktree
                .entries
                .iter()
                .filter(|entry| entry.state == InventoryState::Untracked)
                .map(|entry| entry.path.clone())
                .collect(),
        );
        input.ignored_paths = ignored_paths;
        input
    }

    pub fn with_untracked_paths(mut self, paths: Availability<BTreeSet<RepoRelativePath>>) -> Self {
        self.untracked_paths = paths;
        self
    }

    pub fn with_ignored_paths(mut self, paths: Availability<BTreeSet<RepoRelativePath>>) -> Self {
        self.ignored_paths = paths;
        self
    }

    pub fn with_remote(mut self, remote: Availability<RemoteArtifactSnapshot>) -> Self {
        self.remote = remote;
        self
    }

    pub fn tracked(&self) -> &Availability<BTreeSet<RepoRelativePath>> {
        &self.tracked_paths
    }

    pub fn filesystem(&self) -> &Availability<BTreeSet<RepoRelativePath>> {
        &self.filesystem_paths
    }

    pub fn candidate_paths(&self) -> BTreeSet<RepoRelativePath> {
        union_artifact_paths(&self.tracked_paths, &self.filesystem_paths)
    }
}

/// One path-unique artifact candidate.  Every source status is independent;
/// `absent` is the explicit inverse of the filesystem observation rather than a
/// collapse of tracked, untracked, or ignored state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtifactCandidate {
    pub path: RepoRelativePath,
    pub tracked: ArtifactStatus,
    pub untracked: ArtifactStatus,
    pub ignored: ArtifactStatus,
    pub filesystem: ArtifactStatus,
    pub absent: ArtifactStatus,
    pub remote: ArtifactStatus,
    pub classification: PrimaryClassification,
    pub classification_evidence: EvidenceReference,
    pub purpose: PurposeEvidence,
    pub consumers: Vec<ConsumerResult>,
    pub producers: ProducerDiscovery,
    /// Legacy compatibility projection. The evidence-bearing policy record is
    /// in `retention_recommendation` and `retention_detail`.
    pub retention: RetentionDecision,
    pub retention_recommendation: RetentionRecommendation,
    pub retention_detail: RetentionDetail,
}

impl ArtifactCandidate {
    pub fn new(
        path: RepoRelativePath,
        tracked: ArtifactStatus,
        untracked: ArtifactStatus,
        ignored: ArtifactStatus,
        filesystem: ArtifactStatus,
        remote: ArtifactStatus,
        classification: PrimaryClassification,
        classification_evidence: EvidenceReference,
        purpose: PurposeEvidence,
        consumers: Vec<ConsumerResult>,
        producers: ProducerDiscovery,
        retention: RetentionDecision,
    ) -> Result<Self, FoundationError> {
        if consumers.is_empty() {
            return Err(FoundationError::invalid(
                "consumers",
                "an artifact candidate must record at least NoConsumer",
            ));
        }
        let has_no_consumer = consumers.iter().any(ConsumerResult::is_no_consumer);
        let has_named_consumer = consumers.iter().any(|value| !value.is_no_consumer());
        if has_no_consumer && has_named_consumer {
            return Err(FoundationError::invalid(
                "consumers",
                "NoConsumer cannot be combined with named consumers",
            ));
        }
        let protected =
            purpose.is_required_use() || has_named_consumer || !producers.records().is_empty();
        let mut policy_evidence = vec![classification_evidence.clone()];
        policy_evidence.extend(purpose.evidence.iter().cloned());
        for consumer in &consumers {
            if let ConsumerResult::Named { evidence, .. } = consumer {
                policy_evidence.extend(evidence.iter().cloned());
            }
        }
        for producer in producers.records() {
            policy_evidence.extend(producer.evidence.iter().cloned());
        }
        let policy_evidence = normalize_evidence(policy_evidence);
        let required_use = if protected {
            RequiredUseAssessment::required_use(policy_evidence.clone())?
        } else if [tracked, filesystem, remote]
            .into_iter()
            .any(ArtifactStatus::is_unverified)
        {
            RequiredUseAssessment::unverified(policy_evidence.clone())?
        } else {
            RequiredUseAssessment::no_required_use(policy_evidence.clone())?
        };
        let retention_detail = RetentionDetail::new(
            policy_evidence,
            None,
            None,
            ProducerDiscovery::NotApplicable,
            required_use,
        )?;
        let mut candidate = Self {
            path,
            tracked,
            untracked,
            ignored,
            filesystem,
            absent: filesystem.inverse(),
            remote,
            classification,
            classification_evidence,
            purpose,
            consumers: consumers
                .into_iter()
                .map(|consumer| match consumer {
                    ConsumerResult::Named { name, evidence } => ConsumerResult::Named {
                        name,
                        evidence: normalize_evidence(evidence),
                    },
                    ConsumerResult::NoConsumer => ConsumerResult::NoConsumer,
                })
                .collect(),
            producers,
            retention,
            retention_recommendation: RetentionRecommendation::Retain,
            retention_detail,
        };
        if retention.is_remove() {
            if candidate.protected_from_removal() {
                return Err(FoundationError::boundary(format!(
                    "required-use artifact `{}` cannot receive a remove decision",
                    candidate.path.as_str()
                )));
            }
            candidate.ensure_removal_inputs_verified()?;
            candidate.retention_recommendation = RetentionRecommendation::Remove;
            candidate.retention_detail =
                RetentionDetail::remove("legacy remove decision", candidate.policy_evidence())?;
        }
        Ok(candidate)
    }

    pub fn has_named_consumer(&self) -> bool {
        self.consumers
            .iter()
            .any(|consumer| !consumer.is_no_consumer())
    }

    pub fn required_use(&self) -> bool {
        self.purpose.is_required_use()
            || self.has_named_consumer()
            || !self.producers.records().is_empty()
    }

    pub fn protected_from_removal(&self) -> bool {
        self.required_use()
    }

    fn policy_evidence(&self) -> Vec<EvidenceReference> {
        let mut evidence = vec![self.classification_evidence.clone()];
        evidence.extend(self.purpose.evidence.iter().cloned());
        for consumer in &self.consumers {
            if let ConsumerResult::Named { evidence: refs, .. } = consumer {
                evidence.extend(refs.iter().cloned());
            }
        }
        for producer in self.producers.records() {
            evidence.extend(producer.evidence.iter().cloned());
        }
        normalize_evidence(evidence)
    }

    fn ensure_removal_inputs_verified(&self) -> Result<(), FoundationError> {
        if self.tracked.is_unverified()
            || self.filesystem.is_unverified()
            || self.remote.is_unverified()
        {
            return Err(FoundationError::boundary(format!(
                "remove for `{}` is withheld because a required artifact source is unavailable",
                self.path.as_str()
            )));
        }
        Ok(())
    }

    /// A later policy stage may only remove an unprotected, verified candidate.
    /// The inventory itself never infers a remove decision from an extension.
    pub fn removal_is_permitted(&self) -> bool {
        self.retention_recommendation == RetentionRecommendation::Remove
            && !self.protected_from_removal()
            && self.ensure_removal_inputs_verified().is_ok()
            && self
                .retention_detail
                .validate_for(RetentionRecommendation::Remove)
                .is_ok()
    }

    pub fn retention_recommendation(&self) -> RetentionRecommendation {
        self.retention_recommendation
    }

    pub fn retention_detail(&self) -> &RetentionDetail {
        &self.retention_detail
    }

    pub fn with_recommendation(
        mut self,
        recommendation: RetentionRecommendation,
        detail: RetentionDetail,
    ) -> Result<Self, FoundationError> {
        validate_candidate_recommendation(&self, recommendation, &detail)?;
        self.retention = match recommendation {
            RetentionRecommendation::Remove => RetentionDecision::Remove,
            RetentionRecommendation::Retain
            | RetentionRecommendation::Move
            | RetentionRecommendation::Regenerate => RetentionDecision::Keep,
        };
        self.retention_recommendation = recommendation;
        self.retention_detail = detail;
        Ok(self)
    }

    pub fn with_retention(mut self, retention: RetentionDecision) -> Result<Self, FoundationError> {
        if retention.is_remove() {
            if self.protected_from_removal() {
                return Err(FoundationError::boundary(format!(
                    "required-use artifact `{}` cannot receive a remove decision",
                    self.path.as_str()
                )));
            }
            self.ensure_removal_inputs_verified()?;
            self.retention_detail =
                RetentionDetail::remove("legacy remove decision", self.policy_evidence())?;
            self.retention_recommendation = RetentionRecommendation::Remove;
        } else {
            self.retention_recommendation = RetentionRecommendation::Retain;
            self.retention_detail = RetentionDetail::new(
                self.policy_evidence(),
                None,
                None,
                ProducerDiscovery::NotApplicable,
                if self.protected_from_removal() {
                    RequiredUseAssessment::required_use(self.policy_evidence())?
                } else {
                    RequiredUseAssessment::no_required_use(self.policy_evidence())?
                },
            )?;
        }
        self.retention = retention;
        Ok(self)
    }

    pub fn tracked_status(&self) -> ArtifactStatus {
        self.tracked
    }

    pub fn untracked_status(&self) -> ArtifactStatus {
        self.untracked
    }

    pub fn ignored_status(&self) -> ArtifactStatus {
        self.ignored
    }

    pub fn filesystem_status(&self) -> ArtifactStatus {
        self.filesystem
    }

    pub fn absent_status(&self) -> ArtifactStatus {
        self.absent
    }

    pub fn remote_status(&self) -> ArtifactStatus {
        self.remote
    }
}

fn validate_candidate_recommendation(
    candidate: &ArtifactCandidate,
    recommendation: RetentionRecommendation,
    detail: &RetentionDetail,
) -> Result<(), FoundationError> {
    detail.validate_for(recommendation)?;
    if recommendation.is_remove() {
        if candidate.protected_from_removal() {
            return Err(FoundationError::boundary(format!(
                "required-use artifact `{}` cannot receive a remove decision",
                candidate.path.as_str()
            )));
        }
        candidate.ensure_removal_inputs_verified()?;
        if !matches!(
            detail.required_use,
            RequiredUseAssessment::NoRequiredUse { .. }
        ) {
            return Err(FoundationError::boundary(
                "remove requires evidence that no required use exists",
            ));
        }
    }
    Ok(())
}

/// Validate a proposed recommendation without mutating the candidate.
pub fn decide_retention(
    candidate: &ArtifactCandidate,
    recommendation: RetentionRecommendation,
    detail: RetentionDetail,
) -> Result<RetentionDecisionRecord, FoundationError> {
    validate_candidate_recommendation(candidate, recommendation, &detail)?;
    RetentionDecisionRecord::new(candidate.path.clone(), recommendation, detail)
}

/// Compatibility spelling for callers that use a verb phrase for validation.
pub fn validate_retention_decision(
    candidate: &ArtifactCandidate,
    recommendation: RetentionRecommendation,
    detail: &RetentionDetail,
) -> Result<(), FoundationError> {
    validate_candidate_recommendation(candidate, recommendation, detail)
}

impl<'de> Deserialize<'de> for ArtifactCandidate {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            path: RepoRelativePath,
            tracked: ArtifactStatus,
            untracked: ArtifactStatus,
            ignored: ArtifactStatus,
            filesystem: ArtifactStatus,
            absent: ArtifactStatus,
            remote: ArtifactStatus,
            classification: PrimaryClassification,
            classification_evidence: EvidenceReference,
            purpose: PurposeEvidence,
            consumers: Vec<ConsumerResult>,
            producers: ProducerDiscovery,
            retention: RetentionDecision,
            retention_recommendation: Option<RetentionRecommendation>,
            retention_detail: Option<RetentionDetail>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.absent != wire.filesystem.inverse() {
            return Err(de::Error::custom(
                "artifact absent status must be the inverse of filesystem status",
            ));
        }
        let mut candidate = Self::new(
            wire.path,
            wire.tracked,
            wire.untracked,
            wire.ignored,
            wire.filesystem,
            wire.remote,
            wire.classification,
            wire.classification_evidence,
            wire.purpose,
            wire.consumers,
            wire.producers,
            wire.retention,
        )
        .map_err(de::Error::custom)?;
        match (wire.retention_recommendation, wire.retention_detail) {
            (None, None) => Ok(candidate),
            (Some(recommendation), Some(detail)) => {
                validate_candidate_recommendation(&candidate, recommendation, &detail)
                    .map_err(de::Error::custom)?;
                candidate.retention_recommendation = recommendation;
                candidate.retention_detail = detail;
                Ok(candidate)
            }
            _ => Err(de::Error::custom(
                "retention recommendation and detail must be supplied together",
            )),
        }
    }
}

/// Deterministic artifact inventory metadata and its one-record-per-path map.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactInventory {
    pub audited_revision: FullId,
    pub audited_at_utc: UtcSeconds,
    pub remote_revision: Availability<FullId>,
    pub remote_paths: Availability<BTreeSet<RepoRelativePath>>,
    pub candidates: BTreeMap<RepoRelativePath, ArtifactCandidate>,
}

impl ArtifactInventory {
    pub fn len(&self) -> usize {
        self.candidates.len()
    }

    pub fn is_empty(&self) -> bool {
        self.candidates.is_empty()
    }

    pub fn get(&self, path: &RepoRelativePath) -> Option<&ArtifactCandidate> {
        self.candidates.get(path)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&RepoRelativePath, &ArtifactCandidate)> {
        self.candidates.iter()
    }

    pub fn candidates(&self) -> &BTreeMap<RepoRelativePath, ArtifactCandidate> {
        &self.candidates
    }

    pub fn artifact_candidates(&self) -> &BTreeMap<RepoRelativePath, ArtifactCandidate> {
        &self.candidates
    }

    pub fn from_input(input: ArtifactInventoryInput) -> Result<Self, FoundationError> {
        build_inventory(input, None, None, None)
    }
}

/// One exact removal-register item. It is derived only from a validated Remove
/// recommendation; it is not a command and never mutates the repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemovalRecord {
    pub path: RepoRelativePath,
    pub reason: ExactText,
    pub evidence: Vec<EvidenceReference>,
}

impl RemovalRecord {
    pub fn new(
        path: RepoRelativePath,
        reason: impl Into<String>,
        evidence: Vec<EvidenceReference>,
    ) -> Result<Self, FoundationError> {
        let reason = reason.into();
        validate_bounded_text("removal_reason", &reason, 1, 500)?;
        if reason.trim().is_empty() {
            return Err(FoundationError::invalid(
                "removal_reason",
                "the reason must contain non-whitespace text",
            ));
        }
        let evidence = normalize_evidence(evidence);
        if evidence.is_empty() {
            return Err(FoundationError::invalid(
                "removal_evidence",
                "a removal record needs at least one evidence reference",
            ));
        }
        Ok(Self {
            path,
            reason: ExactText::new(reason),
            evidence,
        })
    }

    fn from_candidate(candidate: &ArtifactCandidate) -> Result<Self, FoundationError> {
        if candidate.retention_recommendation != RetentionRecommendation::Remove {
            return Err(FoundationError::boundary(format!(
                "candidate `{}` is not a Remove recommendation",
                candidate.path.as_str()
            )));
        }
        candidate
            .retention_detail
            .validate_for(RetentionRecommendation::Remove)?;
        let reason =
            candidate.retention_detail.reason.as_ref().ok_or_else(|| {
                FoundationError::invalid("removal_reason", "remove has no reason")
            })?;
        Self::new(
            candidate.path.clone(),
            reason.as_str(),
            candidate.retention_detail.evidence.clone(),
        )
    }
}

impl<'de> Deserialize<'de> for RemovalRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            path: RepoRelativePath,
            reason: ExactText,
            evidence: Vec<EvidenceReference>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.path, wire.reason.into_inner(), wire.evidence).map_err(de::Error::custom)
    }
}

/// Deterministic removal register. Its keys are exactly the candidate paths
/// whose validated recommendation is Remove.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemovalRegister {
    pub records: BTreeMap<RepoRelativePath, RemovalRecord>,
}

impl RemovalRegister {
    pub fn new(
        records: BTreeMap<RepoRelativePath, RemovalRecord>,
    ) -> Result<Self, FoundationError> {
        for (path, record) in &records {
            if path != &record.path {
                return Err(FoundationError::integrity(
                    "removal register key does not match its record path",
                ));
            }
        }
        Ok(Self { records })
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn get(&self, path: &RepoRelativePath) -> Option<&RemovalRecord> {
        self.records.get(path)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&RepoRelativePath, &RemovalRecord)> {
        self.records.iter()
    }
}

impl<'de> Deserialize<'de> for RemovalRegister {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            records: BTreeMap<RepoRelativePath, RemovalRecord>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.records).map_err(de::Error::custom)
    }
}

/// Build the exact Remove subset. Retain, Move, and Regenerate candidates are
/// deliberately absent, not represented by placeholder register entries.
pub fn build_removal_register(
    inventory: &ArtifactInventory,
) -> Result<RemovalRegister, FoundationError> {
    build_removal_register_from_candidates(&inventory.candidates)
}

pub fn build_removal_register_from_candidates(
    candidates: &BTreeMap<RepoRelativePath, ArtifactCandidate>,
) -> Result<RemovalRegister, FoundationError> {
    let mut records = BTreeMap::new();
    for (path, candidate) in candidates {
        if candidate.retention_recommendation != RetentionRecommendation::Remove {
            continue;
        }
        if path != &candidate.path {
            return Err(FoundationError::integrity(
                "artifact candidate map key does not match its path",
            ));
        }
        let record = RemovalRecord::from_candidate(candidate)?;
        records.insert(path.clone(), record);
    }
    RemovalRegister::new(records)
}

/// Form the path union without collapsing any source status.
pub fn union_artifact_paths(
    tracked_paths: &Availability<BTreeSet<RepoRelativePath>>,
    filesystem_paths: &Availability<BTreeSet<RepoRelativePath>>,
) -> BTreeSet<RepoRelativePath> {
    let mut paths = BTreeSet::new();
    if let Availability::Present(values) = tracked_paths {
        paths.extend(
            values
                .iter()
                .filter(|path| !is_excluded_path(path))
                .cloned(),
        );
    }
    if let Availability::Present(values) = filesystem_paths {
        paths.extend(
            values
                .iter()
                .filter(|path| !is_excluded_path(path))
                .cloned(),
        );
    }
    paths
}

/// Compatibility spelling for callers that describe the union as candidates.
pub fn artifact_candidate_paths(input: &ArtifactInventoryInput) -> BTreeSet<RepoRelativePath> {
    input.candidate_paths()
}

/// Build a path-only inventory from injected inputs.  No filesystem or command
/// is accessed by this function.
pub fn build_artifact_inventory(
    input: ArtifactInventoryInput,
) -> Result<ArtifactInventory, FoundationError> {
    ArtifactInventory::from_input(input)
}

/// Build a fully evidenced inventory from a completed start snapshot.  The
/// candidate union still comes from the injected input; the snapshot controls
/// which start-time files may be read for textual discovery, so later outputs
/// cannot become candidates or consumers.
pub fn build_artifact_inventory_from_snapshot(
    repository_root: impl AsRef<Path>,
    snapshot: &StartSnapshot,
    input: ArtifactInventoryInput,
) -> Result<ArtifactInventory, FoundationError> {
    let root = canonical_root(repository_root.as_ref())?;
    ensure_snapshot_root(&root, snapshot)?;
    build_inventory(
        input,
        Some(&root),
        Some(&snapshot.filesystem),
        Some(snapshot),
    )
}

/// Compatibility spelling for the snapshot-backed builder.
pub fn inventory_artifacts(
    repository_root: impl AsRef<Path>,
    snapshot: &StartSnapshot,
    input: ArtifactInventoryInput,
) -> Result<ArtifactInventory, FoundationError> {
    build_artifact_inventory_from_snapshot(repository_root, snapshot, input)
}

/// Collect a complete local artifact inventory.  Git is queried only through
/// existing read-only collectors for tracked/untracked/ignored statuses;
/// generation commands are never executed.
pub fn collect_artifact_inventory(
    repository_root: impl AsRef<Path>,
) -> Result<ArtifactInventory, FoundationError> {
    collect_artifact_inventory_with_remote_state(repository_root, Availability::Empty)
}

/// Collect a complete local inventory with one explicitly injected remote state.
pub fn collect_artifact_inventory_with_remote(
    repository_root: impl AsRef<Path>,
    remote: RemoteArtifactSnapshot,
) -> Result<ArtifactInventory, FoundationError> {
    collect_artifact_inventory_with_remote_state(repository_root, Availability::Present(remote))
}

/// The remote-aware root collector never contacts a remote.  `Unavailable` is
/// retained and becomes `Unverified` candidate status rather than an absent
/// result.
pub fn collect_artifact_inventory_with_remote_state(
    repository_root: impl AsRef<Path>,
    remote: Availability<RemoteArtifactSnapshot>,
) -> Result<ArtifactInventory, FoundationError> {
    let root = canonical_root(repository_root.as_ref())?;
    let snapshot = capture_start_snapshot(&root)?;
    let worktree = capture_worktree_inventory(&root)?;
    let evidence = collect_local_release_evidence(&root)?;
    let ignored = path_set_from_worktree_availability(&evidence.worktree.ignored);
    let input = ArtifactInventoryInput::from_snapshot_and_worktree(&snapshot, &worktree, ignored)
        .with_remote(remote);
    build_artifact_inventory_from_snapshot(&root, &snapshot, input)
}

/// Collect local artifacts against a caller-owned start snapshot.  The snapshot
/// is treated as immutable input; no report output is created by this function.
pub fn collect_artifact_inventory_from_start_snapshot(
    repository_root: impl AsRef<Path>,
    snapshot: &StartSnapshot,
) -> Result<ArtifactInventory, FoundationError> {
    let root = canonical_root(repository_root.as_ref())?;
    ensure_snapshot_root(&root, snapshot)?;
    let worktree = capture_worktree_inventory(&root)?;
    let evidence = collect_local_release_evidence(&root)?;
    let ignored = path_set_from_worktree_availability(&evidence.worktree.ignored);
    let input = ArtifactInventoryInput::from_snapshot_and_worktree(snapshot, &worktree, ignored);
    build_artifact_inventory_from_snapshot(&root, snapshot, input)
}

/// Compatibility spelling for callers that use "candidates" for the report.
pub fn collect_artifact_candidates(
    repository_root: impl AsRef<Path>,
) -> Result<ArtifactInventory, FoundationError> {
    collect_artifact_inventory(repository_root)
}

/// Build a path-only inventory from a borrowed input without accessing the
/// filesystem.  The owned builder remains the canonical implementation.
pub fn inventory_from_input(
    input: &ArtifactInventoryInput,
) -> Result<ArtifactInventory, FoundationError> {
    ArtifactInventory::from_input(input.clone())
}

fn build_inventory(
    input: ArtifactInventoryInput,
    root: Option<&Path>,
    filesystem: Option<&FilesystemSnapshot>,
    snapshot: Option<&StartSnapshot>,
) -> Result<ArtifactInventory, FoundationError> {
    let paths = input.candidate_paths();
    let text_sources = match (root, filesystem) {
        (Some(root), Some(filesystem)) => Some(read_text_sources(root, filesystem)?),
        _ => None,
    };

    let mut candidates = BTreeMap::new();
    for path in paths {
        let entry = filesystem.and_then(|value| value.entry(&path));
        let classification = classify_path(&path, text_sources.as_ref());
        let classification_evidence = evidence_for(&path, 1);
        let purpose = purpose_for(
            &path,
            &classification,
            &input,
            classification_evidence.clone(),
        )?;
        let consumers = match text_sources.as_ref() {
            Some(sources) => discover_consumers(&path, sources),
            None => vec![ConsumerResult::NoConsumer],
        };
        let producers = if classification == PrimaryClassification::GeneratedArtifact {
            match text_sources.as_ref() {
                Some(sources) => discover_producers(&path, sources),
                None => ProducerDiscovery::NotDiscoverable,
            }
        } else {
            ProducerDiscovery::NotApplicable
        };
        let filesystem_status = ArtifactStatus::from_membership(&input.filesystem_paths, &path);
        let candidate = ArtifactCandidate::new(
            path.clone(),
            ArtifactStatus::from_membership(&input.tracked_paths, &path),
            ArtifactStatus::from_membership(&input.untracked_paths, &path),
            ArtifactStatus::from_membership(&input.ignored_paths, &path),
            filesystem_status,
            remote_status(&input.remote, &path),
            classification,
            classification_evidence,
            purpose,
            consumers,
            producers,
            RetentionDecision::Unassessed,
        )?;
        if let Some(entry) = entry {
            validate_scanned_entry(path.as_str(), entry)?;
        }
        candidates.insert(path, candidate);
    }

    let (remote_revision, remote_paths) = remote_fields(&input.remote);
    let inventory = ArtifactInventory {
        audited_revision: input.audited_revision,
        audited_at_utc: input.audited_at_utc,
        remote_revision,
        remote_paths,
        candidates,
    };
    if let Some(snapshot) = snapshot {
        if inventory.audited_revision != snapshot.identity.head
            || inventory.audited_at_utc != snapshot.captured_at_utc
        {
            return Err(FoundationError::integrity(
                "artifact inventory metadata does not match its start snapshot",
            ));
        }
    }
    Ok(inventory)
}

fn validate_scanned_entry(
    path: &str,
    entry: &FilesystemEntrySnapshot,
) -> Result<(), FoundationError> {
    if entry.entry_type == FilesystemEntryType::BlockDevice
        || entry.entry_type == FilesystemEntryType::CharacterDevice
        || entry.entry_type == FilesystemEntryType::Fifo
        || entry.entry_type == FilesystemEntryType::Socket
        || entry.entry_type == FilesystemEntryType::Other
    {
        // The snapshot may describe a special entry, but the artifact scanner
        // never opens it.  Keeping the candidate is safer than silently
        // deleting its path from the union.
        let _ = path;
    }
    Ok(())
}

fn remote_status(
    remote: &Availability<RemoteArtifactSnapshot>,
    path: &RepoRelativePath,
) -> ArtifactStatus {
    match remote {
        Availability::Empty => ArtifactStatus::No,
        Availability::Unavailable => ArtifactStatus::Unverified,
        Availability::Present(snapshot) => {
            if snapshot.revision.is_unavailable() || snapshot.revision.is_empty() {
                return ArtifactStatus::Unverified;
            }
            ArtifactStatus::from_membership(&snapshot.paths, path)
        }
    }
}

fn remote_fields(
    remote: &Availability<RemoteArtifactSnapshot>,
) -> (
    Availability<FullId>,
    Availability<BTreeSet<RepoRelativePath>>,
) {
    match remote {
        Availability::Empty => (Availability::Empty, Availability::Empty),
        Availability::Unavailable => (Availability::Unavailable, Availability::Unavailable),
        Availability::Present(snapshot) => (snapshot.revision.clone(), snapshot.paths.clone()),
    }
}

fn purpose_for(
    path: &RepoRelativePath,
    classification: &PrimaryClassification,
    input: &ArtifactInventoryInput,
    evidence: EvidenceReference,
) -> Result<PurposeEvidence, FoundationError> {
    let lower = path.as_str().to_ascii_lowercase();
    let components = lower.split('/').collect::<Vec<_>>();
    let file_name = components.last().copied().unwrap_or(lower.as_str());
    let mut labels = BTreeSet::new();

    if components.iter().any(|component| {
        matches!(
            *component,
            "src" | "lib" | "bin" | "app" | "crates" | "packages"
        )
    }) || matches!(
        file_name.rsplit('.').next().unwrap_or(""),
        "rs" | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "go"
            | "py"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "toml"
            | "yaml"
            | "yml"
            | "json"
            | "sh"
            | "bash"
    ) || file_name == "makefile"
        || components.iter().any(|component| {
            matches!(
                *component,
                ".github" | ".gitlab" | ".circleci" | "workflow" | "workflows" | "scripts"
            )
        })
    {
        labels.insert(PurposeLabel::Source);
    }
    if components.iter().any(|component| {
        matches!(
            *component,
            "assets" | "asset" | "static" | "public" | "templates" | "template" | "fixtures"
        )
    }) || matches!(
        file_name.rsplit('.').next().unwrap_or(""),
        "css" | "scss" | "svg" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico" | "woff" | "woff2"
    ) {
        labels.insert(PurposeLabel::RuntimeAsset);
    }
    if components.iter().any(|component| {
        matches!(
            *component,
            "docs" | "doc" | "documentation" | "readme" | "manual" | "guides"
        )
    }) || matches!(file_name, "readme.md" | "readme.markdown" | "changelog.md")
        || matches!(
            file_name.rsplit('.').next().unwrap_or(""),
            "md" | "markdown" | "mdx" | "rst"
        )
    {
        labels.insert(PurposeLabel::Documentation);
    }
    if components.iter().any(|component| {
        matches!(
            *component,
            "test" | "tests" | "spec" | "specs" | "fixture" | "fixtures"
        )
    }) || file_name.contains("test")
        || file_name.contains("spec")
    {
        labels.insert(PurposeLabel::Test);
    }
    if components.iter().any(|component| {
        matches!(
            *component,
            "eval"
                | "evals"
                | "evaluation"
                | "evaluations"
                | "benchmark"
                | "benchmarks"
                | "ground_truth"
        )
    }) || lower.contains("published-evaluation")
    {
        labels.insert(PurposeLabel::PublishedEvaluation);
    }
    let ignored_status = ArtifactStatus::from_membership(&input.ignored_paths, path);
    let untracked_status = ArtifactStatus::from_membership(&input.untracked_paths, path);
    let tracked_status = ArtifactStatus::from_membership(&input.tracked_paths, path);
    if is_local_path(&components, file_name)
        || ((ignored_status == ArtifactStatus::Yes || untracked_status == ArtifactStatus::Yes)
            && tracked_status != ArtifactStatus::Yes)
    {
        labels.insert(PurposeLabel::Local);
    }
    if labels.is_empty() {
        labels.insert(PurposeLabel::Other);
    }
    let labels = PurposeLabelSet::new(labels)?;
    let description = PurposeDescription::new(truncate_chars(
        &format!(
            "Repository path `{}` is retained as {} and requires evidence-based policy review.",
            path.as_str(),
            classification.as_str()
        ),
        500,
    ))?;
    PurposeEvidence::new(labels, description, vec![evidence])
}

fn is_local_path(components: &[&str], file_name: &str) -> bool {
    file_name == ".env"
        || file_name.starts_with(".env.")
        || components.iter().any(|component| {
            matches!(
                *component,
                "local" | "scratch" | "tmp" | "temporary" | "private"
            )
        })
        || file_name.starts_with("local-")
        || file_name.starts_with("scratch-")
}

fn classify_path(
    path: &RepoRelativePath,
    sources: Option<&Vec<TextSource>>,
) -> PrimaryClassification {
    let lower = path.as_str().to_ascii_lowercase();
    let components = lower.split('/').collect::<Vec<_>>();
    let file_name = components.last().copied().unwrap_or(lower.as_str());
    let extension = file_name.rsplit('.').next().unwrap_or("");
    let content_signal = sources
        .and_then(|all| all.iter().find(|source| source.path == *path))
        .map(|source| {
            source.lines.iter().any(|(_, line)| {
                let line = line.to_ascii_lowercase();
                line.contains("@generated")
                    || line.contains("do not edit")
                    || line.contains("generated file")
                    || line.contains("generated by")
            })
        })
        .unwrap_or(false);

    if matches!(
        extension,
        "zip" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" | "jar" | "war"
    ) || file_name.ends_with(".tar.gz")
    {
        return PrimaryClassification::ArchiveArtifact;
    }
    if matches!(extension, "html" | "htm") {
        return PrimaryClassification::HtmlArtifact;
    }
    if content_signal
        || components.iter().any(|component| {
            matches!(
                *component,
                "generated" | "gen" | "codegen" | "autogen" | "autogenerated"
            )
        })
        || file_name.contains("generated")
        || file_name.contains("autogen")
        || file_name.contains("codegen")
    {
        return PrimaryClassification::GeneratedArtifact;
    }
    if components.iter().any(|component| {
        matches!(
            *component,
            "target" | "dist" | "build" | "out" | "release" | ".next" | ".nuxt"
        )
    }) {
        return PrimaryClassification::BuildOutput;
    }
    if components.iter().any(|component| {
        matches!(
            *component,
            "cache"
                | ".cache"
                | "caches"
                | "node_modules"
                | "__pycache__"
                | ".pytest_cache"
                | ".mypy_cache"
                | ".gradle"
                | ".venv"
        )
    }) || file_name.ends_with(".cache")
    {
        return PrimaryClassification::Cache;
    }
    if components.iter().any(|component| {
        matches!(
            *component,
            "report"
                | "reports"
                | "coverage"
                | "eval"
                | "evals"
                | "evaluation"
                | "evaluations"
                | "benchmark"
                | "benchmarks"
        )
    }) || file_name.contains("report")
        || file_name.contains("results")
        || file_name.contains("summary")
    {
        return PrimaryClassification::Report;
    }
    if is_local_path(&components, file_name) {
        return PrimaryClassification::LocalOnlyFile;
    }
    if components.iter().any(|component| {
        matches!(
            *component,
            "obsolete" | "deprecated" | "legacy" | "unused" | "old"
        )
    }) || file_name.starts_with("obsolete")
        || file_name.starts_with("deprecated")
        || file_name.starts_with("legacy")
        || file_name.starts_with("unused")
    {
        return PrimaryClassification::ObsoleteFile;
    }
    PrimaryClassification::custom("Other artifact")
        .unwrap_or_else(|_| PrimaryClassification::Custom(ExactText::new("Other artifact")))
}

#[derive(Debug, Clone)]
struct TextSource {
    path: RepoRelativePath,
    lines: Vec<(u32, String)>,
}

fn read_text_sources(
    root: &Path,
    filesystem: &FilesystemSnapshot,
) -> Result<Vec<TextSource>, FoundationError> {
    let mut sources = Vec::new();
    for (path, entry) in &filesystem.entries {
        if is_excluded_path(path) || entry.entry_type != FilesystemEntryType::RegularFile {
            continue;
        }
        let actual = root.join(path.as_path());
        let metadata = match fs::symlink_metadata(&actual) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(FoundationError::Io {
                    operation: "inspect artifact text source",
                    source,
                })
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        let bytes = fs::read(&actual).map_err(|source| FoundationError::Io {
            operation: "read artifact text source",
            source,
        })?;
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let lines = text
            .split('\n')
            .enumerate()
            .map(|(index, line)| ((index + 1) as u32, line.trim_end_matches('\r').to_owned()))
            .collect::<Vec<_>>();
        sources.push(TextSource {
            path: path.clone(),
            lines,
        });
    }
    sources.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(sources)
}

fn discover_consumers(path: &RepoRelativePath, sources: &[TextSource]) -> Vec<ConsumerResult> {
    let mut consumers = Vec::new();
    for source in sources {
        if source.path == *path {
            continue;
        }
        let evidence = matching_line_evidence(path, source);
        if evidence.is_empty() {
            continue;
        }
        if let Ok(consumer) = ConsumerResult::named(source.path.as_str(), evidence) {
            consumers.push(consumer);
        }
    }
    if consumers.is_empty() {
        vec![ConsumerResult::NoConsumer]
    } else {
        consumers
    }
}

fn discover_producers(path: &RepoRelativePath, sources: &[TextSource]) -> ProducerDiscovery {
    let mut records = Vec::new();
    for source in sources {
        if source.path == *path {
            continue;
        }
        let tokens = reference_tokens(path);
        let mut source_evidence = Vec::new();
        for (line_number, line) in &source.lines {
            if !tokens.iter().any(|token| contains_path_token(line, token))
                || !looks_like_generation_line(line)
            {
                continue;
            }
            source_evidence.push(evidence_for(&source.path, *line_number));
            let name = format!(
                "{}:{}: {}",
                source.path.as_str(),
                line_number,
                truncate_chars(line.trim(), 400)
            );
            if let Ok(record) =
                ProducerRecord::new(name, vec![evidence_for(&source.path, *line_number)])
            {
                records.push(record);
            }
        }
        source_evidence.sort();
        source_evidence.dedup();
    }
    records.sort_by(|left, right| left.name.cmp(&right.name));
    if records.is_empty() {
        ProducerDiscovery::NotDiscoverable
    } else {
        ProducerDiscovery::Named { producers: records }
    }
}

fn matching_line_evidence(path: &RepoRelativePath, source: &TextSource) -> Vec<EvidenceReference> {
    let tokens = reference_tokens(path);
    let mut evidence = Vec::new();
    for (line_number, line) in &source.lines {
        if tokens.iter().any(|token| contains_path_token(line, token)) {
            evidence.push(evidence_for(&source.path, *line_number));
        }
    }
    normalize_evidence(evidence)
}

fn reference_tokens(path: &RepoRelativePath) -> Vec<String> {
    let mut tokens = vec![path.as_str().to_owned()];
    if let Some(file_name) = path.as_str().rsplit('/').next() {
        if path.as_str().contains('/') && file_name.len() >= 3 {
            tokens.push(file_name.to_owned());
        }
    }
    tokens
}

fn contains_path_token(line: &str, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    let mut search_from = 0;
    while let Some(relative) = line[search_from..].find(token) {
        let start = search_from + relative;
        let end = start + token.len();
        let before = line[..start].chars().next_back();
        let after = line[end..].chars().next();
        let before_is_boundary = before
            .map(|value| !(value.is_ascii_alphanumeric() || matches!(value, '_' | '-' | '.')))
            .unwrap_or(true);
        let after_is_boundary = after
            .map(|value| !(value.is_ascii_alphanumeric() || matches!(value, '_' | '-' | '.')))
            .unwrap_or(true);
        if before_is_boundary && after_is_boundary {
            return true;
        }
        search_from = end;
        if search_from >= line.len() {
            break;
        }
    }
    false
}

fn looks_like_generation_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    [
        "generate",
        "generated",
        "codegen",
        "build",
        "compile",
        "render",
        "export",
        "bundle",
        "emit",
        "produce",
        "cargo ",
        "make ",
        "npm ",
        "pnpm ",
        "yarn ",
        "webpack",
        "vite",
        "rustc",
        "go build",
        "python ",
        "script",
    ]
    .iter()
    .any(|signal| lower.contains(signal))
        || line.contains('>')
        || line.contains("--output")
        || line.contains(" -o ")
}

fn evidence_for(path: &RepoRelativePath, line: u32) -> EvidenceReference {
    let span = InclusiveSpan::new(line.max(1), line.max(1)).expect("positive evidence line");
    let source = EvidenceSourceIdentity {
        kind: EvidenceSourceKind::Worktree,
        name: ExactText::new("artifact-inventory"),
    };
    EvidenceReference::new(
        source,
        EvidenceReferenceLocator::File(crate::EvidenceLocator::new(path.clone(), span)),
    )
}

fn normalize_evidence(mut evidence: Vec<EvidenceReference>) -> Vec<EvidenceReference> {
    evidence.sort();
    evidence.dedup();
    evidence
}

fn path_set_from_worktree_availability(
    source: &Availability<Vec<crate::WorktreePathObservation>>,
) -> Availability<BTreeSet<RepoRelativePath>> {
    match source {
        Availability::Empty => Availability::Empty,
        Availability::Unavailable => Availability::Unavailable,

        Availability::Present(entries) => {
            Availability::Present(entries.iter().map(|entry| entry.path.clone()).collect())
        }
    }
}

/// Compatibility name for consumers that call one candidate an artifact record.
pub type ArtifactRecord = ArtifactCandidate;
/// Compatibility name for the complete candidate report.
pub type ArtifactInventoryReport = ArtifactInventory;
/// Compatibility name for the later retention/ignore policy decision.
pub type RetentionPolicyDecision = RetentionDecision;

fn is_excluded_path(path: &RepoRelativePath) -> bool {
    let value = path.as_str();
    value == crate::ARTIFACT_DIRECTORY
        || value.starts_with(&format!("{}/", crate::ARTIFACT_DIRECTORY))
        || value.split('/').any(|component| component == ".git")
}

fn canonical_root(path: &Path) -> Result<PathBuf, FoundationError> {
    if !path.is_absolute() {
        return Err(FoundationError::boundary(
            "the repository root must be supplied as an absolute path",
        ));
    }
    let metadata = fs::symlink_metadata(path).map_err(|source| FoundationError::Io {
        operation: "inspect artifact repository root",
        source,
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(FoundationError::boundary(
            "the artifact repository root must be a non-symlink directory",
        ));
    }
    fs::canonicalize(path).map_err(|source| FoundationError::Io {
        operation: "canonicalize artifact repository root",
        source,
    })
}

fn ensure_snapshot_root(root: &Path, snapshot: &StartSnapshot) -> Result<(), FoundationError> {
    if snapshot.identity.repository_root.as_path() != root {
        return Err(FoundationError::boundary(
            "artifact snapshot belongs to a different repository root",
        ));
    }
    Ok(())
}

fn validate_bounded_text(
    field: &'static str,
    value: &str,
    minimum: usize,
    maximum: usize,
) -> Result<(), FoundationError> {
    let length = value.chars().count();
    if length < minimum || length > maximum {
        return Err(FoundationError::invalid(
            field,
            format!("text length must be between {minimum} and {maximum} characters"),
        ));
    }
    if value.contains('\0') {
        return Err(FoundationError::invalid(field, "NUL is not allowed"));
    }
    Ok(())
}

fn truncate_chars(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

// Keep this import used in builds that compile the module with stricter lint
// settings and make the intended serde boundary explicit.
#[allow(dead_code)]
fn deserialize_value<T: DeserializeOwned>(text: &str) -> Result<T, FoundationError> {
    serde_json::from_str(text).map_err(|error| FoundationError::Serialization(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(value: &str) -> RepoRelativePath {
        RepoRelativePath::new(value).expect("path")
    }

    #[test]
    fn union_excludes_git_and_protected_artifacts_but_keeps_distinct_sources() {
        let tracked = Availability::Present(BTreeSet::from([
            path("src/lib.rs"),
            path(".git/config"),
            path(".kiro/specs/release-checkpoint-research/research-report.json"),
        ]));
        let filesystem =
            Availability::Present(BTreeSet::from([path("src/lib.rs"), path("dist/page.html")]));
        let union = union_artifact_paths(&tracked, &filesystem);
        assert_eq!(
            union
                .into_iter()
                .map(|value| value.into_inner())
                .collect::<Vec<_>>(),
            vec!["dist/page.html", "src/lib.rs"]
        );
    }

    #[test]
    fn unavailable_source_is_unverified_not_empty() {
        let path = path("missing.txt");
        let status = ArtifactStatus::from_membership(
            &Availability::Unavailable::<BTreeSet<RepoRelativePath>>,
            &path,
        );
        assert_eq!(status, ArtifactStatus::Unverified);
    }

    #[test]
    fn bounded_fields_reject_out_of_range_values() {
        assert!(PrimaryClassification::custom("").is_err());
        assert!(PrimaryClassification::custom("x".repeat(51)).is_err());
        assert!(PurposeDescription::new("").is_err());
        assert!(PurposeDescription::new("x".repeat(501)).is_err());
        assert!(PurposeLabelSet::new([]).is_err());
        assert!(ConsumerResult::named("consumer", Vec::new()).is_err());
        assert!(ProducerRecord::new("producer", Vec::new()).is_err());
        assert!(ProducerDiscovery::discovered(Vec::new()).is_err());
    }
}
