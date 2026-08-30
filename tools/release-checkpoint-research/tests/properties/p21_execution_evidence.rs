// Feature: release-checkpoint-research, Property 21: Eligibility never becomes execution evidence
const PROPERTY_TAG: &str = "p21_execution_evidence";

use release_checkpoint_research::{
    observe_ci_execution, Availability, ExactText, FullId, ObservedCiRun, ReadmeUpdateInput,
};

fn commit(number: usize) -> FullId {
    FullId::new(format!("{number:040x}")).expect("generated commit")
}

#[test]
fn p21_execution_requires_an_exact_matching_full_commit() {
    assert_eq!(PROPERTY_TAG, "p21_execution_evidence");
    let mut matching_cases = 0;
    let mut gap_cases = 0;
    for case in 0..256_usize {
        let update_commit = commit(case + 1);
        let input = ReadmeUpdateInput::complete(
            update_commit.clone(),
            Vec::new(),
            Vec::new(),
            ExactText::new("push"),
            ExactText::new("refs/heads/main"),
        );
        let unrelated = ObservedCiRun::complete(
            ExactText::new(format!("unrelated-{case}")),
            ExactText::new("other.yml"),
            ExactText::new("push"),
            ExactText::new("refs/heads/main"),
            commit(case + 10_000),
            ExactText::new("success"),
        );
        let incomplete = ObservedCiRun::new(
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Unavailable,
        );
        let mut runs = vec![unrelated, incomplete];
        if case % 2 == 0 {
            runs.push(ObservedCiRun::new(
                Availability::Unavailable,
                Availability::Unavailable,
                Availability::Present(ExactText::new("push")),
                Availability::Unavailable,
                Availability::Present(update_commit.clone()),
                Availability::Unavailable,
            ));
        }
        let evidence = observe_ci_execution(&input, &runs);
        if case % 2 == 0 {
            matching_cases += 1;
            assert_eq!(evidence.matching_runs.len(), 1);
            assert!(evidence.no_matching_run_gap.is_empty());
            let matching = &evidence.matching_runs[0];
            assert_eq!(matching.commit, Availability::Present(update_commit));
            assert!(matching.run_id.is_unavailable());
            assert!(matching.outcome.is_unavailable());
        } else {
            gap_cases += 1;
            assert!(evidence.matching_runs.is_empty());
            match &evidence.no_matching_run_gap {
                Availability::Present(gap) => {
                    assert!(gap.as_str().contains(
                        "trigger eligibility does not prove an observed CI run for the README update commit"
                    ));
                }
                other => panic!("expected no-run gap, got {other:?}"),
            }
        }
    }
    assert!(matching_cases >= 128);
    assert!(gap_cases >= 128);
}
