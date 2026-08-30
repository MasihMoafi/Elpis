// PROPERTY_TAG: P05_UNAVAILABLE_RELEASE
// Feature: release-checkpoint-research, Property 5: Unavailable source becomes a named gap
use release_checkpoint_research::{
    release_selection_report, Availability, FullId, LocalReleaseEvidence, UnavailableSourceGap,
    WorktreeInventories, NO_UNAMBIGUOUS_RELEASE_BASELINE,
};

#[test]
fn p05_unavailable_releases_reject_abbreviations_and_unavailable_sources_become_named_gaps() {
    assert_eq!(PROPERTY_TAG, "p05_unavailable_release");
    assert!(FullId::new("a".repeat(40)).is_ok());
    assert!(FullId::new("a".repeat(64)).is_ok());
    assert!(FullId::new("a".repeat(39)).is_err());
    assert!(FullId::new(format!("{}g", "a".repeat(39))).is_err());

    for case in 0..128_u32 {
        let evidence = LocalReleaseEvidence::without_remote(
            Availability::Unavailable,
            WorktreeInventories::empty(),
            Availability::Unavailable,
            Availability::Unavailable,
            vec![UnavailableSourceGap::new(
                release_checkpoint_research::EvidenceSourceIdentity::local_git(format!(
                    "attempt-{case}"
                ))
                .unwrap(),
                format!("attempted read {case}"),
            )],
        );
        let report = release_selection_report(&evidence);
        assert!(report.candidates.is_empty());
        assert!(report.gaps.iter().any(|gap| {
            gap.reason.as_str() == "local tag references unavailable"
                || gap.reason.as_str() == "release document source unavailable"
                || gap.reason.as_str() == "package manifest source unavailable"
        }));
        assert!(report
            .gaps
            .iter()
            .any(|gap| { gap.reason.as_str() == NO_UNAMBIGUOUS_RELEASE_BASELINE }));
        assert!(matches!(
            report.decision,
            release_checkpoint_research::BaselineDecision::NoUnambiguous { .. }
        ));
    }
}

const PROPERTY_TAG: &str = "p05_unavailable_release";
