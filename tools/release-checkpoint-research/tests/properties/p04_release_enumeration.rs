// PROPERTY_TAG: P04_RELEASE_ENUMERATION
// Feature: release-checkpoint-research, Property 4: Complete release-evidence enumeration
use release_checkpoint_research::{
    normalize_release_candidates, Availability, ExactText, FullId, InclusiveSpan,
    LocalRefObservation, LocalReleaseEvidence, PackageManifestVersionDeclaration,
    ReleaseDocumentDeclaration, RemoteReferenceObservation, RemoteSnapshotCollector,
    RepoRelativePath, WorktreeInventories,
};
use std::collections::BTreeSet;

#[test]
fn p04_empty_and_unavailable_are_distinct_and_all_release_sources_enumerate_once() {
    assert_eq!(PROPERTY_TAG, "p04_release_enumeration");
    let empty: Availability<String> = Availability::Empty;
    let unavailable: Availability<String> = Availability::Unavailable;
    assert_ne!(empty, unavailable);
    assert!(empty.is_empty());
    assert!(unavailable.is_unavailable());

    for case in 0..128_u32 {
        let local = LocalRefObservation::try_new(
            format!("refs/tags/v{case}.0.0"),
            Availability::Present(FullId::new(format!("{case:040x}")).unwrap()),
            Availability::Present(ExactText::new(format!(
                "2026-{:02}-01T00:00:00Z",
                (case % 12) + 1
            ))),
            Availability::Empty,
        )
        .unwrap();
        let remote_ref = RemoteReferenceObservation::try_new(
            format!("refs/releases/remote-{case}"),
            Availability::Present(FullId::new(format!("{:040x}", case + 1)).unwrap()),
            Availability::Present(ExactText::new(format!(
                "2026-{:02}-02T00:00:00Z",
                (case % 12) + 1
            ))),
            Availability::Empty,
        )
        .unwrap();
        let document = ReleaseDocumentDeclaration::try_new(
            RepoRelativePath::new(format!("release-notes-{case}.md")).unwrap(),
            InclusiveSpan::new(2, 2).unwrap(),
            format!("v{case}.0.0"),
            format!("Release v{case}.0.0"),
        )
        .unwrap();
        let manifest = PackageManifestVersionDeclaration::try_new(
            RepoRelativePath::new(format!("manifest-{case}.toml")).unwrap(),
            InclusiveSpan::new(3, 3).unwrap(),
            format!("{case}.0.0"),
            format!("version = \"{case}.0.0\""),
        )
        .unwrap();
        let remote =
            RemoteSnapshotCollector::new(format!("remote-snapshot-{case}"), vec![remote_ref]);
        let evidence = LocalReleaseEvidence::without_remote(
            Availability::Present(vec![local]),
            WorktreeInventories::empty(),
            Availability::Present(vec![document]),
            Availability::Present(vec![manifest]),
            Vec::new(),
        )
        .attach_remote(&remote);
        let candidates = normalize_release_candidates(&evidence);
        assert_eq!(candidates.len(), 4);
        let ids = candidates
            .iter()
            .map(|candidate| candidate.candidate_id.as_str().to_owned())
            .collect::<BTreeSet<_>>();
        assert_eq!(ids.len(), 4);
        assert!(candidates.iter().any(|candidate| {
            candidate.reference.as_ref().is_present()
                && candidate
                    .candidate_id
                    .as_str()
                    .starts_with("local-git:refs/tags/")
        }));
        assert!(candidates.iter().any(|candidate| {
            candidate.candidate_id.as_str().starts_with("remote:")
                && candidate.source_evidence.len() >= 2
        }));
        assert!(candidates.iter().any(|candidate| {
            candidate.exact_declaration.is_present()
                && candidate.candidate_id.as_str().starts_with("document:")
        }));
        assert!(candidates.iter().any(|candidate| {
            candidate.exact_declaration.is_present()
                && candidate.candidate_id.as_str().starts_with("manifest:")
        }));
    }
}

const PROPERTY_TAG: &str = "p04_release_enumeration";
