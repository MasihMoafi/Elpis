// Feature: release-checkpoint-research, Property 20: Trigger evaluation is three-valued and cited
const PROPERTY_TAG: &str = "p20_trigger_evaluation";

use release_checkpoint_research::{
    evaluate_trigger_conditions, parse_workflow, Availability, ExactText, FullId, InclusiveSpan,
    ReadmeUpdateInput, RepoRelativePath, TriggerResult, WorkflowInventory,
};

fn commit(number: usize) -> FullId {
    FullId::new(format!("{number:040x}")).expect("generated commit")
}

fn workflow_inventory() -> WorkflowInventory {
    let source = "name: README CI\non:\n  push:\n    branches:\n      - main\n    paths:\n      - README.md\njobs:\n  build:\n    if: github.ref == 'refs/heads/main'\n    steps:\n      - run: cargo test\n";
    let workflow = parse_workflow(".github/workflows/readme.yml", source).unwrap();
    WorkflowInventory {
        directory: Availability::Present(release_checkpoint_research::WorkflowDirectory {
            path: RepoRelativePath::new(".github/workflows").unwrap(),
            file_count: 1,
        }),
        workflows: Availability::Present(vec![workflow]),
        gaps: Vec::new(),
    }
}

#[test]
fn p20_each_configured_condition_is_cited_and_three_valued() {
    assert_eq!(PROPERTY_TAG, "p20_trigger_evaluation");
    let mut saw_eligible = false;
    let mut saw_ineligible = false;
    let mut saw_undetermined = false;
    for case in 0..256_usize {
        let input = match case % 3 {
            0 => ReadmeUpdateInput::complete(
                commit(case + 1),
                Vec::new(),
                vec![RepoRelativePath::new("README.md").unwrap()],
                ExactText::new("push"),
                ExactText::new("refs/heads/main"),
            ),
            1 => ReadmeUpdateInput::complete(
                commit(case + 1),
                Vec::new(),
                vec![RepoRelativePath::new("README.md").unwrap()],
                ExactText::new("push"),
                ExactText::new("refs/heads/feature"),
            ),
            _ => ReadmeUpdateInput::new(
                Availability::Present(commit(case + 1)),
                Availability::Present(Vec::new()),
                Availability::Unavailable,
                Availability::Present(ExactText::new("push")),
                Availability::Present(ExactText::new("refs/heads/main")),
            ),
        };
        let evaluations = evaluate_trigger_conditions(&workflow_inventory(), &input);
        assert_eq!(evaluations.len(), 1);
        let evaluation = &evaluations[0];
        assert_eq!(
            evaluation.workflow_path.as_str(),
            ".github/workflows/readme.yml"
        );
        assert!(evaluation.is_cited());
        assert!(evaluation.conditions.iter().all(|condition| {
            condition.workflow_path.as_str() == ".github/workflows/readme.yml"
                && condition.source_span == condition.evidence.span
                && condition.source_span.start >= 1
                && condition.source_span.end >= condition.source_span.start
        }));
        match evaluation.result {
            TriggerResult::Eligible => saw_eligible = true,
            TriggerResult::Ineligible => saw_ineligible = true,
            TriggerResult::Undetermined => saw_undetermined = true,
        }
    }
    assert!(saw_eligible && saw_ineligible && saw_undetermined);
    let span = InclusiveSpan::new(1, 1).unwrap();
    assert!(span.start > 0);
}
