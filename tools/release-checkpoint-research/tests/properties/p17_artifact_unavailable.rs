// Feature: release-checkpoint-research, Property 17: Unavailable artifact sources fail closed
use release_checkpoint_research::{
    build_artifact_inventory, build_removal_register, build_untracking_follow_ups,
    ArtifactInventoryInput, ArtifactStatus, Availability, EvidenceReference,
    EvidenceReferenceLocator, EvidenceSourceIdentity, EvidenceSourceKind, FullId,
    IgnoreFileSnapshot, RepoRelativePath, RetentionDecision, RetentionDetail,
    RetentionRecommendation, UtcSeconds,
};
use std::collections::BTreeSet;

const PROPERTY_TAG: &str = "p17_artifact_unavailable";

fn path(value: &str) -> RepoRelativePath {
    RepoRelativePath::new(value).expect("valid property path")
}

fn evidence(line: u32) -> EvidenceReference {
    EvidenceReference::new(
        EvidenceSourceIdentity::new(EvidenceSourceKind::Worktree, "p17").unwrap(),
        EvidenceReferenceLocator::file(
            path("evidence.txt"),
            release_checkpoint_research::InclusiveSpan::new(line, line).unwrap(),
        ),
    )
}

#[test]
fn p17_exact_tag_and_128_unavailable_remote_cases_withhold_remove() {
    assert_eq!(PROPERTY_TAG, "p17_artifact_unavailable");
    for case in 0..128_u32 {
        let artifact = path(&format!("published-evaluation/result-{case}.bin"));
        let input = ArtifactInventoryInput::new(
            FullId::new("c".repeat(40)).unwrap(),
            UtcSeconds::now().unwrap(),
            Availability::Present(BTreeSet::from([artifact.clone()])),
            Availability::Present(BTreeSet::from([artifact.clone()])),
        )
        .with_remote(Availability::Unavailable);
        let inventory = build_artifact_inventory(input).unwrap();
        let candidate = &inventory.candidates[&artifact];
        assert_eq!(candidate.remote, ArtifactStatus::Unverified);
        assert_ne!(
            candidate.retention_recommendation(),
            RetentionRecommendation::Remove
        );
        let detail =
            RetentionDetail::remove("remote not observed", vec![evidence(case + 1)]).unwrap();
        assert!(candidate
            .clone()
            .with_recommendation(RetentionRecommendation::Remove, detail)
            .is_err());
        assert!(build_removal_register(&inventory).unwrap().is_empty());
    }
}

#[test]
fn p17_exact_tag_and_128_unavailable_filesystem_cases_withhold_remove() {
    assert_eq!(PROPERTY_TAG, "p17_artifact_unavailable");
    for case in 0..128_u32 {
        let artifact = path(&format!("cache/unread-{case}.bin"));
        let input = ArtifactInventoryInput::new(
            FullId::new("d".repeat(40)).unwrap(),
            UtcSeconds::now().unwrap(),
            Availability::Present(BTreeSet::from([artifact.clone()])),
            Availability::Unavailable,
        );
        let inventory = build_artifact_inventory(input).unwrap();
        let candidate = &inventory.candidates[&artifact];
        assert_eq!(candidate.filesystem, ArtifactStatus::Unverified);
        assert_eq!(candidate.absent, ArtifactStatus::Unverified);
        let detail =
            RetentionDetail::remove("filesystem not observed", vec![evidence(case + 1)]).unwrap();
        assert!(candidate
            .clone()
            .with_recommendation(RetentionRecommendation::Remove, detail)
            .is_err());
        assert!(build_removal_register(&inventory).unwrap().is_empty());
    }
}

#[test]
fn p17_exact_tag_and_128_unavailable_ignore_cases_withhold_untracking() {
    assert_eq!(PROPERTY_TAG, "p17_artifact_unavailable");
    for case in 0..128_u32 {
        let artifact = path(&format!("cache/tracked-{case}.bin"));
        let input = ArtifactInventoryInput::new(
            FullId::new("e".repeat(40)).unwrap(),
            UtcSeconds::now().unwrap(),
            Availability::Present(BTreeSet::from([artifact.clone()])),
            Availability::Present(BTreeSet::from([artifact.clone()])),
        );
        let inventory = build_artifact_inventory(input).unwrap();
        let follow_ups = build_untracking_follow_ups(
            &inventory.candidates,
            &IgnoreFileSnapshot::unavailable(),
            &Availability::Present(BTreeSet::from([artifact.clone()])),
        );
        assert!(follow_ups.is_unavailable());
        assert!(build_untracking_follow_ups(
            &inventory.candidates,
            &IgnoreFileSnapshot::empty(),
            &Availability::Unavailable,
        )
        .is_unavailable());
        assert_eq!(inventory.candidates[&artifact].ignored, ArtifactStatus::No);
        assert_eq!(
            inventory.candidates[&artifact].retention,
            RetentionDecision::Unassessed
        );
    }
}

#[test]
fn p17_empty_sources_are_not_mislabeled_unavailable() {
    assert_eq!(PROPERTY_TAG, "p17_artifact_unavailable");
    let artifact = path("cache/empty-source.bin");
    let inventory = build_artifact_inventory(ArtifactInventoryInput::new(
        FullId::new("f".repeat(40)).unwrap(),
        UtcSeconds::now().unwrap(),
        Availability::Present(BTreeSet::from([artifact.clone()])),
        Availability::Present(BTreeSet::from([artifact.clone()])),
    ))
    .unwrap();
    let follow_ups = build_untracking_follow_ups(
        &inventory.candidates,
        &IgnoreFileSnapshot::empty(),
        &Availability::Present(BTreeSet::new()),
    );
    assert!(matches!(follow_ups, Availability::Present(ref map) if map.is_empty()));
}
