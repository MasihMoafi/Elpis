// PROPERTY_TAG: P06_SELECTED_BASELINE
// Feature: release-checkpoint-research, Property 6: Selected baseline is fully evidenced
use release_checkpoint_research::{
    normalize_release_candidates, select_release_baseline, Availability, BaselineDecision,
    ExactText, FullId, LocalRefObservation, LocalReleaseEvidence, ReleaseDocumentDeclaration,
    RepoRelativePath, WorktreeInventories,
};

#[test]
fn p06_paths_are_relative_and_selected_baselines_are_fully_evidenced() {
    assert_eq!(PROPERTY_TAG, "p06_selected_baseline");
    assert!(RepoRelativePath::new("src/main.rs").is_ok());
    for bad in ["", "/tmp/x", "../x", "a/../x", "a//x", "a\\x", "C:/x"] {
        assert!(RepoRelativePath::new(bad).is_err(), "accepted {bad}");
    }

    for case in 0..128_u32 {
        let month = (case % 12) + 1;
        let day = (case % 28) + 1;
        let reference = format!("refs/tags/v{case}.0.0");
        let commit = FullId::new(format!("{case:040x}")).unwrap();
        let date = format!("2026-{month:02}-{day:02}T00:00:00Z");
        let local = LocalRefObservation::try_new(
            reference.clone(),
            Availability::Present(commit.clone()),
            Availability::Present(ExactText::new(date.clone())),
            Availability::Empty,
        )
        .unwrap();
        let readme = ReleaseDocumentDeclaration::try_new(
            RepoRelativePath::new("README.md").unwrap(),
            release_checkpoint_research::InclusiveSpan::new(1, 1).unwrap(),
            format!("v{case}.0.0"),
            format!("Version v{case}.0.0"),
        )
        .unwrap();
        let evidence = LocalReleaseEvidence::without_remote(
            Availability::Present(vec![local]),
            WorktreeInventories::empty(),
            Availability::Present(vec![readme]),
            Availability::Empty,
            Vec::new(),
        );
        match select_release_baseline(&evidence) {
            BaselineDecision::Selected(baseline) => {
                assert_eq!(baseline.reference.as_str(), reference);
                assert_eq!(baseline.commit, commit);
                assert_eq!(baseline.resolved_commit, commit);
                assert_eq!(baseline.version.as_str(), format!("v{case}.0.0"));
                assert!(baseline.release_date_observations.as_ref().is_present());
                assert_eq!(baseline.candidate_comparisons.len(), 2);
                assert_eq!(
                    baseline
                        .candidate_comparisons
                        .iter()
                        .filter(|row| row.selected)
                        .count(),
                    1
                );
                assert!(baseline.rationale.as_str().contains(&date));
                assert!(baseline
                    .evidence
                    .iter()
                    .any(|evidence| evidence.locator_is_git_ref(&reference)));
            }
            other => panic!("expected fully evidenced baseline, got {other:?}"),
        }
        assert_eq!(normalize_release_candidates(&evidence).len(), 2);
    }
}

const PROPERTY_TAG: &str = "p06_selected_baseline";

trait LocatorExt {
    fn locator_is_git_ref(&self, reference: &str) -> bool;
}

impl LocatorExt for release_checkpoint_research::EvidenceReference {
    fn locator_is_git_ref(&self, reference: &str) -> bool {
        matches!(
            &self.locator,
            release_checkpoint_research::EvidenceReferenceLocator::GitRef(value)
                if value.as_str() == reference
        )
    }
}
