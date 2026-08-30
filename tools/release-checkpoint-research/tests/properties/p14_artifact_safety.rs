// Feature: release-checkpoint-research, Property 14: Artifact decisions protect required use
// PROPERTY_TAG: P14_ARTIFACT_SAFETY
use release_checkpoint_research::{
    build_artifact_inventory, ArtifactInventoryInput, ArtifactStatus, Availability, FullId,
    PrimaryClassification, RemoteArtifactSnapshot, RepoRelativePath, RetentionDecision, UtcSeconds,
};
use std::collections::BTreeSet;

const PROPERTY_TAG: &str = "p14_artifact_safety";

fn path(value: &str) -> RepoRelativePath {
    RepoRelativePath::new(value).expect("valid fixture path")
}

fn input_for(path_value: &str) -> ArtifactInventoryInput {
    let path = path(path_value);
    ArtifactInventoryInput::new(
        FullId::new("c".repeat(40)).unwrap(),
        UtcSeconds::now().unwrap(),
        Availability::Present(BTreeSet::from([path.clone()])),
        Availability::Present(BTreeSet::from([path])),
    )
}

#[test]
fn p14_exact_feature_tag_and_required_use_cannot_be_removed() {
    assert_eq!(PROPERTY_TAG, "p14_artifact_safety");
    let inventory = build_artifact_inventory(input_for("src/required.rs")).unwrap();
    let candidate = inventory.candidates.get(&path("src/required.rs")).unwrap();
    assert!(candidate.purpose.is_required_use());
    assert!(candidate.protected_from_removal());
    assert!(!candidate.removal_is_permitted());
    assert!(candidate
        .clone()
        .with_retention(RetentionDecision::Remove)
        .is_err());
    assert_eq!(candidate.retention, RetentionDecision::Unassessed);
}

#[test]
fn p14_extensions_never_create_an_automatic_remove_decision() {
    let names = [
        "archive.zip",
        "archive.tar",
        "archive.gz",
        "archive.7z",
        "page.html",
        "page.htm",
        "generated.rs",
        "generated.js",
        "target/debug.bin",
        "dist/app.js",
        "build/app",
        "out/app",
        "cache/value",
        ".cache/value",
        "node_modules/pkg",
        "reports/result.json",
        "report.md",
        "coverage/summary.txt",
        ".env",
        "local/data",
        "scratch/data",
        "obsolete/file.txt",
        "legacy/file.txt",
        "unused.txt",
        "ordinary.txt",
        "ordinary.bin",
        "ordinary.json",
        "asset.svg",
        "docs/notes.md",
        "tests/fixture.txt",
        "src/main.rs",
        "lib/mod.rs",
        "app.ts",
        "public/index.html",
        "static/style.css",
        "benchmark/results.csv",
        "evaluation/data.json",
        "tmp/file",
        "private/file",
        "README.md",
        "CHANGELOG.md",
        "Cargo.toml",
        "Makefile",
        "scripts/generate.sh",
        "scripts/build.sh",
        "fixtures/input.dat",
        "specs/contract.md",
        "old/report.json",
        "deprecated/api.rs",
        "autogen/output.rs",
        "codegen/generated.rs",
        "release/package.tar",
        "dist/report.html",
        "target/cache.bin",
        "build/generated.js",
        "output.log",
        "summary.txt",
        "results.json",
        "data.csv",
        "picture.png",
        "font.woff2",
        "unknown.one",
        "unknown.two",
        "unknown.three",
        "unknown.four",
        "unknown.five",
    ];
    assert!(names.len() >= 64);
    let paths = names.iter().map(|name| path(name)).collect::<BTreeSet<_>>();
    let inventory = build_artifact_inventory(ArtifactInventoryInput::new(
        FullId::new("d".repeat(40)).unwrap(),
        UtcSeconds::now().unwrap(),
        Availability::Present(paths.clone()),
        Availability::Present(paths),
    ))
    .unwrap();
    for name in names {
        let candidate = inventory.candidates.get(&path(name)).unwrap();
        assert_eq!(candidate.retention, RetentionDecision::Unassessed);
        assert!(
            !candidate.removal_is_permitted(),
            "extension inferred removal for {name}"
        );
    }
}

#[test]
fn p14_unavailable_remote_state_is_unverified_not_absent() {
    let published_path = path("published-evaluation/result.json");
    let input = ArtifactInventoryInput::new(
        FullId::new("e".repeat(40)).unwrap(),
        UtcSeconds::now().unwrap(),
        Availability::Present(BTreeSet::from([published_path.clone()])),
        Availability::Present(BTreeSet::from([published_path.clone()])),
    )
    .with_remote(Availability::Present(RemoteArtifactSnapshot::unavailable()));
    let inventory = build_artifact_inventory(input).unwrap();
    let candidate = inventory.candidates.get(&published_path).unwrap();
    assert_eq!(candidate.remote, ArtifactStatus::Unverified);
    assert_eq!(inventory.remote_revision, Availability::Unavailable);
    assert_eq!(inventory.remote_paths, Availability::Unavailable);

    let input = input_for("archive.zip").with_remote(Availability::Unavailable);
    let inventory = build_artifact_inventory(input).unwrap();
    assert_eq!(
        inventory.candidates[&path("archive.zip")].remote,
        ArtifactStatus::Unverified
    );
}

#[test]
fn p14_classification_is_exactly_one_bounded_value() {
    let inventory = build_artifact_inventory(input_for("reports/result.json")).unwrap();
    let candidate = inventory
        .candidates
        .get(&path("reports/result.json"))
        .unwrap();
    assert_eq!(candidate.classification, PrimaryClassification::Report);
    assert!(!candidate
        .classification_evidence
        .locator_is_empty_for_test());
    assert_eq!(candidate.purpose.evidence.len(), 1);
}

trait LocatorPresence {
    fn locator_is_empty_for_test(&self) -> bool;
}

impl LocatorPresence for release_checkpoint_research::EvidenceReference {
    fn locator_is_empty_for_test(&self) -> bool {
        false
    }
}

#[test]
fn p14_required_use_and_extension_safety_cover_128_generated_cases() {
    assert_eq!(PROPERTY_TAG, "p14_artifact_safety");
    for case in 0..128_u32 {
        let candidate_path = if case % 2 == 0 {
            path(&format!("src/required-case-{case}.rs"))
        } else {
            path(&format!("cache/disposable-case-{case}.bin"))
        };
        let input = ArtifactInventoryInput::new(
            FullId::new(format!("{:0>40x}", case + 11)).unwrap(),
            UtcSeconds::now().unwrap(),
            Availability::Present(BTreeSet::from([candidate_path.clone()])),
            Availability::Present(BTreeSet::from([candidate_path.clone()])),
        );
        let inventory = build_artifact_inventory(input).unwrap();
        let candidate = inventory.candidates.get(&candidate_path).unwrap().clone();
        assert_eq!(candidate.retention, RetentionDecision::Unassessed);
        assert_eq!(candidate.filesystem, ArtifactStatus::Yes);
        if case % 2 == 0 {
            assert!(candidate.protected_from_removal());
            assert!(candidate.with_retention(RetentionDecision::Remove).is_err());
        } else {
            assert!(!candidate.protected_from_removal());
            assert!(candidate.with_retention(RetentionDecision::Remove).is_ok());
        }
    }
}
