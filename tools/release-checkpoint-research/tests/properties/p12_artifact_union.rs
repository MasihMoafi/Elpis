// Feature: release-checkpoint-research, Property 12: Artifact candidate union is path-unique
// PROPERTY_TAG: P12_ARTIFACT_UNION
use release_checkpoint_research::{
    artifact_candidate_paths, union_artifact_paths, ArtifactInventoryInput, Availability, FullId,
    RepoRelativePath, UtcSeconds,
};
use std::collections::BTreeSet;

const PROPERTY_TAG: &str = "p12_artifact_union";

fn path(value: &str) -> RepoRelativePath {
    RepoRelativePath::new(value).expect("valid fixture path")
}

#[test]
fn p12_exact_feature_tag_and_path_union_have_128_positive_negative_cases() {
    assert_eq!(PROPERTY_TAG, "p12_artifact_union");

    let positive = (0..64)
        .map(|index| path(&format!("tracked/{index}.txt")))
        .collect::<BTreeSet<_>>();
    let filesystem = (0..64)
        .map(|index| path(&format!("filesystem/{index}.txt")))
        .chain((0..16).map(|index| path(&format!("tracked/{index}.txt"))))
        .collect::<BTreeSet<_>>();
    let union = union_artifact_paths(
        &Availability::Present(positive.clone()),
        &Availability::Present(filesystem.clone()),
    );

    for index in 0..64 {
        assert!(union.contains(&path(&format!("tracked/{index}.txt"))));
        assert!(union.contains(&path(&format!("filesystem/{index}.txt"))));
    }
    assert_eq!(union.len(), 128);

    let excluded = (0..64)
        .map(|index| path(&format!(".git/administrative-{index}")))
        .chain((0..64).map(|index| {
            path(&format!(
                ".kiro/specs/release-checkpoint-research/output-{index}.json"
            ))
        }))
        .collect::<BTreeSet<_>>();
    let excluded_union = union_artifact_paths(
        &Availability::Present(excluded.clone()),
        &Availability::Present(excluded),
    );
    for index in 0..64 {
        assert!(!excluded_union.contains(&path(&format!(".git/administrative-{index}"))));
        assert!(!excluded_union.contains(&path(&format!(
            ".kiro/specs/release-checkpoint-research/output-{index}.json"
        ))));
    }
}

#[test]
fn p12_input_keeps_status_sources_independent_and_deterministic() {
    let input = ArtifactInventoryInput::new(
        FullId::new("a".repeat(40)).unwrap(),
        UtcSeconds::now().unwrap(),
        Availability::Present(BTreeSet::from([path("same.txt"), path("tracked.txt")])),
        Availability::Present(BTreeSet::from([path("same.txt"), path("filesystem.txt")])),
    );
    let first = artifact_candidate_paths(&input);
    let second = artifact_candidate_paths(&input);
    assert_eq!(first, second);
    assert_eq!(
        first.into_iter().collect::<Vec<_>>(),
        vec![
            path("filesystem.txt"),
            path("same.txt"),
            path("tracked.txt")
        ]
    );
    assert!(union_artifact_paths(
        &Availability::Unavailable,
        &Availability::Present(BTreeSet::new())
    )
    .is_empty());
    assert!(union_artifact_paths(
        &Availability::Present(BTreeSet::new()),
        &Availability::Unavailable
    )
    .is_empty());
}
