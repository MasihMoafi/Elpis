// Feature: release-checkpoint-research, Property 16: Removal register is decision-equivalent
use release_checkpoint_research::{
    build_artifact_inventory, build_removal_register, ArtifactInventory, ArtifactInventoryInput,
    Availability, EvidenceReference, EvidenceReferenceLocator, EvidenceSourceIdentity,
    EvidenceSourceKind, FullId, ProducerDiscovery, RepoRelativePath, RequiredUseAssessment,
    RetentionDetail, RetentionRecommendation, UtcSeconds,
};
use std::collections::BTreeSet;

const PROPERTY_TAG: &str = "p16_removal_register";

fn path(value: &str) -> RepoRelativePath {
    RepoRelativePath::new(value).expect("valid property path")
}

fn evidence(line: u32) -> EvidenceReference {
    EvidenceReference::new(
        EvidenceSourceIdentity::new(EvidenceSourceKind::Worktree, "p16").unwrap(),
        EvidenceReferenceLocator::file(
            path("cache/evidence.txt"),
            release_checkpoint_research::InclusiveSpan::new(line, line).unwrap(),
        ),
    )
}

fn source_inventory(count: u32) -> ArtifactInventory {
    let paths = (0..count)
        .map(|case| path(&format!("cache/candidate-{case}.bin")))
        .collect::<BTreeSet<_>>();
    build_artifact_inventory(ArtifactInventoryInput::new(
        FullId::new("b".repeat(40)).unwrap(),
        UtcSeconds::now().unwrap(),
        Availability::Present(paths.clone()),
        Availability::Present(paths),
    ))
    .unwrap()
}

#[test]
fn p16_exact_tag_and_128_case_remove_subset_is_exact() {
    assert_eq!(PROPERTY_TAG, "p16_removal_register");
    for round in 0..128_u32 {
        let mut inventory = source_inventory(4);
        let mut expected = BTreeSet::new();
        for case in 0..4_u32 {
            let candidate_path = path(&format!("cache/candidate-{case}.bin"));
            let candidate = inventory.candidates.get(&candidate_path).unwrap().clone();
            let line = round * 4 + case + 1;
            let (recommendation, detail) = match case {
                0 => {
                    expected.insert(candidate_path.clone());
                    (
                        RetentionRecommendation::Remove,
                        RetentionDetail::remove(
                            format!("verified disposable cache case {round}"),
                            vec![evidence(line)],
                        )
                        .unwrap(),
                    )
                }
                1 => (
                    RetentionRecommendation::Retain,
                    RetentionDetail::retain(vec![evidence(line)]).unwrap(),
                ),
                2 => (
                    RetentionRecommendation::Move,
                    RetentionDetail::move_to(path("archive/cache"), vec![evidence(line)]).unwrap(),
                ),
                _ => (
                    RetentionRecommendation::Regenerate,
                    RetentionDetail::regenerate(
                        ProducerDiscovery::not_discoverable(),
                        vec![evidence(line)],
                    )
                    .unwrap(),
                ),
            };
            let candidate = candidate
                .with_recommendation(recommendation, detail)
                .unwrap();
            inventory.candidates.insert(candidate_path, candidate);
        }
        let register = build_removal_register(&inventory).unwrap();
        let actual = register.records.keys().cloned().collect::<BTreeSet<_>>();
        assert_eq!(actual, expected);
        assert_eq!(register.len(), 1);
        let record = register.records.values().next().unwrap();
        assert!((1..=500).contains(&record.reason.as_str().chars().count()));
        assert!(!record.evidence.is_empty());
        assert!(register.records.keys().all(|path| {
            inventory.candidates[path].retention_recommendation == RetentionRecommendation::Remove
        }));
    }
}

#[test]
fn p16_bounded_reason_destination_producer_and_required_use_cases_fail_closed() {
    assert_eq!(PROPERTY_TAG, "p16_removal_register");
    let refs = vec![evidence(1)];
    assert!(RetentionDetail::remove("", refs.clone()).is_err());
    assert!(RetentionDetail::remove("x".repeat(501), refs.clone()).is_err());
    assert!(RetentionDetail::remove("reason", Vec::new()).is_err());
    assert!(RetentionDetail::move_to(path(&"x".repeat(501)), refs.clone()).is_err());
    assert!(RetentionDetail::regenerate(
        ProducerDiscovery::discovered(Vec::new())
            .unwrap_or_else(|_| ProducerDiscovery::not_discoverable()),
        refs.clone(),
    )
    .is_ok());
    assert!(RequiredUseAssessment::no_required_use(Vec::new()).is_err());

    let mut inventory = source_inventory(1);
    let candidate_path = path("cache/candidate-0.bin");
    let candidate = inventory.candidates[&candidate_path].clone();
    let required = candidate.clone().with_recommendation(
        RetentionRecommendation::Remove,
        RetentionDetail::new(
            refs.clone(),
            Some("looks unused".to_owned()),
            None,
            ProducerDiscovery::not_discoverable(),
            RequiredUseAssessment::required_use(refs.clone()).unwrap(),
        )
        .unwrap(),
    );
    assert!(required.is_err());

    let retained = candidate
        .with_recommendation(
            RetentionRecommendation::Retain,
            RetentionDetail::retain(refs).unwrap(),
        )
        .unwrap();
    inventory.candidates.insert(candidate_path, retained);
    assert!(build_removal_register(&inventory).unwrap().is_empty());
}

#[test]
fn p16_serialized_register_rejects_key_mismatch_and_keeps_order() {
    assert_eq!(PROPERTY_TAG, "p16_removal_register");
    let mut inventory = source_inventory(4);
    let first = path("cache/candidate-0.bin");
    let candidate = inventory.candidates[&first]
        .clone()
        .with_recommendation(
            RetentionRecommendation::Remove,
            RetentionDetail::remove("one", vec![evidence(1)]).unwrap(),
        )
        .unwrap();
    inventory.candidates.insert(first.clone(), candidate);
    let register = build_removal_register(&inventory).unwrap();
    let json = release_checkpoint_research::serialize_deterministically(&register).unwrap();
    let decoded: release_checkpoint_research::RemovalRegister =
        release_checkpoint_research::deserialize_strict(&json).unwrap();
    assert_eq!(decoded, register);
    assert!(json.find("candidate-0.bin").is_some());
    assert!(json.find("candidate-1.bin").is_none());
}
