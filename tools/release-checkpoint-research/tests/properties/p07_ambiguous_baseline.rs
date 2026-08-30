// PROPERTY_TAG: P07_AMBIGUOUS_BASELINE
// Feature: release-checkpoint-research, Property 7: Ambiguous baseline fails closed
use release_checkpoint_research::{
    select_release_baseline, Availability, BaselineDecision, ExactText, FullId, InclusiveSpan,
    LocalRefObservation, LocalReleaseEvidence, ReleaseDocumentDeclaration, RepoRelativePath,
    WorktreeInventories, NO_UNAMBIGUOUS_RELEASE_BASELINE,
};

#[test]
fn p07_spans_are_inclusive_and_ambiguous_baselines_fail_closed() {
    assert_eq!(PROPERTY_TAG, "p07_ambiguous_baseline");
    let span = InclusiveSpan::new(2, 4).unwrap();
    assert!(span.contains(2));
    assert!(span.contains(4));
    assert!(!span.contains(1));
    assert!(InclusiveSpan::new(0, 1).is_err());
    assert!(InclusiveSpan::new(4, 2).is_err());
    let start = release_checkpoint_research::SourcePosition::new(1, 1).unwrap();
    let end = release_checkpoint_research::SourcePosition::new(1, 2).unwrap();
    assert!(release_checkpoint_research::SourceSpan::new(start, end).is_ok());
    assert!(
        release_checkpoint_research::deserialize_strict::<InclusiveSpan>(r#"{"start":4,"end":2}"#)
            .is_err()
    );
    assert!(release_checkpoint_research::deserialize_strict::<
        release_checkpoint_research::SourcePosition,
    >(r#"{"line":0,"column":1}"#)
    .is_err());

    for case in 0..128_u32 {
        let date = ExactText::new("2026-08-30T00:00:00Z");
        let first = LocalRefObservation::try_new(
            format!("refs/tags/tie-a-{case}"),
            Availability::Present(FullId::new(format!("{:040x}", case + 1)).unwrap()),
            Availability::Present(date.clone()),
            Availability::Empty,
        )
        .unwrap();
        let second = LocalRefObservation::try_new(
            format!("refs/tags/tie-b-{case}"),
            Availability::Present(FullId::new(format!("{:040x}", case + 2)).unwrap()),
            Availability::Present(date),
            Availability::Empty,
        )
        .unwrap();
        let readme = ReleaseDocumentDeclaration::try_new(
            RepoRelativePath::new("README.md").unwrap(),
            InclusiveSpan::new(1, 1).unwrap(),
            format!("v{case}.0.0"),
            format!("Version v{case}.0.0"),
        )
        .unwrap();
        let evidence = LocalReleaseEvidence::without_remote(
            Availability::Present(vec![first, second]),
            WorktreeInventories::empty(),
            Availability::Present(vec![readme]),
            Availability::Empty,
            Vec::new(),
        );
        match select_release_baseline(&evidence) {
            BaselineDecision::NoUnambiguous {
                reason,
                candidate_comparisons,
                blockers,
                gaps,
            } => {
                assert_eq!(reason.as_str(), NO_UNAMBIGUOUS_RELEASE_BASELINE);
                assert_eq!(candidate_comparisons.len(), 3);
                assert_eq!(
                    candidate_comparisons
                        .iter()
                        .filter(|row| row.selected)
                        .count(),
                    0
                );
                assert!(blockers.iter().any(|blocker| {
                    blocker
                        .as_str()
                        .contains("tied newest validated release date")
                }));
                assert!(gaps
                    .iter()
                    .any(|gap| { gap.reason.as_str() == NO_UNAMBIGUOUS_RELEASE_BASELINE }));
                let readme = candidate_comparisons
                    .iter()
                    .find(|row| row.candidate_id.as_str().starts_with("document:README.md"))
                    .unwrap();
                assert!(readme
                    .blockers
                    .iter()
                    .any(|blocker| blocker.as_str() == "unresolved reference evidence"));
            }
            other => panic!("expected tied candidates to fail closed, got {other:?}"),
        }
    }
}

const PROPERTY_TAG: &str = "p07_ambiguous_baseline";
