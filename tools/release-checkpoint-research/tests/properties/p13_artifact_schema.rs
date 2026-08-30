// Feature: release-checkpoint-research, Property 13: Artifact record schema is complete
// PROPERTY_TAG: P13_ARTIFACT_SCHEMA
use release_checkpoint_research::{
    build_artifact_inventory, deserialize_strict, serialize_deterministically,
    ArtifactInventoryInput, ArtifactStatus, Availability, ConsumerResult, EvidenceReference,
    EvidenceSourceIdentity, ExactText, FullId, InclusiveSpan, PrimaryClassification,
    ProducerDiscovery, ProducerRecord, PurposeDescription, PurposeEvidence, PurposeLabel,
    PurposeLabelSet, RepoRelativePath, RetentionDecision, UtcSeconds,
};
use std::collections::BTreeSet;

const PROPERTY_TAG: &str = "p13_artifact_schema";

fn path(value: &str) -> RepoRelativePath {
    RepoRelativePath::new(value).expect("valid fixture path")
}

fn evidence(relative: &str, line: u32) -> EvidenceReference {
    EvidenceReference::file(
        EvidenceSourceIdentity::worktree("p13-fixture").unwrap(),
        path(relative),
        InclusiveSpan::new(line, line).unwrap(),
    )
}

#[test]
fn p13_exact_feature_tag_and_closed_status_schema_round_trip() {
    assert_eq!(PROPERTY_TAG, "p13_artifact_schema");
    for status in [
        ArtifactStatus::Yes,
        ArtifactStatus::No,
        ArtifactStatus::Unverified,
    ] {
        let json = serialize_deterministically(&status).unwrap();
        assert_eq!(deserialize_strict::<ArtifactStatus>(&json).unwrap(), status);
    }
    for invalid in ["\"Maybe\"", "null", "{}"] {
        assert!(deserialize_strict::<ArtifactStatus>(invalid).is_err());
    }
}

#[test]
fn p13_primary_classification_and_purpose_bounds_cover_positive_negative_cases() {
    let classifications = [
        PrimaryClassification::ArchiveArtifact,
        PrimaryClassification::HtmlArtifact,
        PrimaryClassification::GeneratedArtifact,
        PrimaryClassification::BuildOutput,
        PrimaryClassification::Cache,
        PrimaryClassification::Report,
        PrimaryClassification::LocalOnlyFile,
        PrimaryClassification::ObsoleteFile,
        PrimaryClassification::custom("custom classification").unwrap(),
        PrimaryClassification::custom("x").unwrap(),
        PrimaryClassification::custom("x".repeat(50)).unwrap(),
    ];
    for classification in classifications {
        let json = serialize_deterministically(&classification).unwrap();
        let decoded: PrimaryClassification = deserialize_strict(&json).unwrap();
        assert_eq!(decoded, classification);
        assert!(!classification.as_str().is_empty());
        assert!(classification.as_str().chars().count() <= 50 || !classification.is_custom());
    }
    for invalid in ["".to_owned(), "x".repeat(51)] {
        assert!(PrimaryClassification::custom(invalid).is_err());
    }
    for description in ["x".to_owned(), "x".repeat(500)] {
        let value = PurposeDescription::new(description).unwrap();
        assert!(value.as_str().chars().count() <= 500);
        let json = serialize_deterministically(&value).unwrap();
        assert_eq!(
            deserialize_strict::<PurposeDescription>(&json).unwrap(),
            value
        );
    }
    for invalid in ["".to_owned(), "x".repeat(501), "   ".to_owned()] {
        assert!(PurposeDescription::new(invalid).is_err());
    }
}

#[test]
fn p13_purpose_consumer_producer_and_retention_contracts_are_cited() {
    let labels = PurposeLabelSet::new(PurposeLabel::ALL).unwrap();
    assert_eq!(labels.len(), 7);
    for label in PurposeLabel::ALL {
        assert!(PurposeLabelSet::singleton(label).contains(label));
    }
    assert!(PurposeLabelSet::new(Vec::<PurposeLabel>::new()).is_err());

    let purpose = PurposeEvidence::new(
        labels,
        PurposeDescription::new("A cited test purpose.").unwrap(),
        vec![evidence("tests/fixture.txt", 3)],
    )
    .unwrap();
    assert!(!purpose.evidence.is_empty());
    assert!(purpose.is_required_use());
    assert!(ConsumerResult::named("docs/README.md", vec![evidence("docs/README.md", 4)]).is_ok());
    assert!(ConsumerResult::named("docs/README.md", Vec::new()).is_err());
    assert!(ConsumerResult::no_consumer().is_no_consumer());

    let producer = ProducerRecord::new(
        "scripts/generate.sh:7: generate artifact",
        vec![evidence("scripts/generate.sh", 7)],
    )
    .unwrap();
    let producers = ProducerDiscovery::discovered(vec![producer]).unwrap();
    assert!(!producers.records().is_empty());
    assert!(ProducerDiscovery::not_discoverable().is_not_discoverable());
    assert!(ProducerRecord::new("", vec![evidence("x", 1)]).is_err());
    assert!(ProducerRecord::new("producer", Vec::new()).is_err());

    let input = ArtifactInventoryInput::new(
        FullId::new("b".repeat(40)).unwrap(),
        UtcSeconds::now().unwrap(),
        Availability::Present(BTreeSet::from([path("src/lib.rs")])),
        Availability::Present(BTreeSet::from([path("src/lib.rs")])),
    );
    let inventory = build_artifact_inventory(input).unwrap();
    let json = serialize_deterministically(&inventory).unwrap();
    let decoded =
        deserialize_strict::<release_checkpoint_research::ArtifactInventory>(&json).unwrap();
    assert_eq!(decoded, inventory);
    assert_eq!(RetentionDecision::default(), RetentionDecision::Unassessed);
    assert_eq!(ExactText::new("schema").as_str(), "schema");
    assert_eq!(evidence("a", 1).evidence_line_for_test(), Some(1));
}

trait EvidenceLineForTest {
    fn evidence_line_for_test(&self) -> Option<u32>;
}

impl EvidenceLineForTest for EvidenceReference {
    fn evidence_line_for_test(&self) -> Option<u32> {
        match &self.locator {
            release_checkpoint_research::EvidenceReferenceLocator::File(locator) => {
                Some(locator.span.start)
            }
            _ => None,
        }
    }
}

#[test]
fn p13_schema_and_consumer_contracts_cover_128_generated_cases() {
    assert_eq!(PROPERTY_TAG, "p13_artifact_schema");
    for case in 0..128_u32 {
        let candidate_path = path(&format!("src/schema-case-{case}.rs"));
        let input = ArtifactInventoryInput::new(
            FullId::new(format!("{:0>40x}", case + 1)).unwrap(),
            UtcSeconds::now().unwrap(),
            Availability::Present(BTreeSet::from([candidate_path.clone()])),
            Availability::Present(BTreeSet::from([candidate_path.clone()])),
        );
        let inventory = build_artifact_inventory(input).unwrap();
        let candidate = inventory.candidates.get(&candidate_path).unwrap();
        assert_eq!(
            candidate.classification,
            PrimaryClassification::custom("Other artifact").unwrap()
        );
        assert_eq!(candidate.consumers.len(), 1);
        assert!(candidate.consumers[0].is_no_consumer());
        assert!(!candidate.purpose.evidence.is_empty());
        let json = serialize_deterministically(candidate).unwrap();
        let decoded: release_checkpoint_research::ArtifactCandidate =
            deserialize_strict(&json).unwrap();
        assert_eq!(&decoded, candidate);
        if case % 2 == 0 {
            assert!(PrimaryClassification::custom(String::new()).is_err());
            assert!(PurposeDescription::new(" ".repeat(1)).is_err());
        } else {
            assert!(PrimaryClassification::custom("x".repeat(50)).is_ok());
            assert!(PurposeDescription::new("purpose").is_ok());
        }
    }
}
