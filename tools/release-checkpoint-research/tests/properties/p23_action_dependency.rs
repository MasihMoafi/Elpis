// Feature: release-checkpoint-research, Property 23: CI action dependency is classified
const PROPERTY_TAG: &str = "p23_action_dependency";

use release_checkpoint_research::{
    build_policy, parse_workflow, ActionDependencyClassification, Availability, ExactText, FullId,
    ReadmeUpdateInput, WorkflowInventory,
};

fn commit(number: usize) -> FullId {
    FullId::new(format!("{number:040x}")).expect("generated commit")
}

fn inventory(case: usize) -> WorkflowInventory {
    let source = match case % 3 {
        0 => "name: Security\non:\n  workflow_dispatch:\njobs:\n  security:\n    steps:\n      - run: echo security\n",
        1 => "name: Scheduled Build\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  build:\n    steps:\n      - run: cargo test\n",
        _ => "name: Conditional Build\non:\n  workflow_dispatch:\njobs:\n  build:\n    if: github.repository == 'owner/unknown'\n    steps:\n      - run: cargo test\n",
    };
    let workflow = parse_workflow(format!(".github/workflows/action-{case}.yml"), source).unwrap();
    WorkflowInventory {
        directory: Availability::Empty,
        workflows: Availability::Present(vec![workflow]),
        gaps: Vec::new(),
    }
}

#[test]
fn p23_action_dependencies_have_one_classification_and_citation() {
    assert_eq!(PROPERTY_TAG, "p23_action_dependency");
    let mut saw_independent = false;
    let mut saw_build_dependent = false;
    let mut saw_undetermined = false;
    for case in 0..256_usize {
        let input = ReadmeUpdateInput::complete(
            commit(case + 1),
            Vec::new(),
            Vec::new(),
            ExactText::new(if case % 2 == 0 {
                "push"
            } else {
                "workflow_dispatch"
            }),
            ExactText::new("refs/heads/main"),
        );
        let inventory = inventory(case);
        let policy = build_policy(&inventory, &input);
        assert!(!policy.action_dependencies.is_empty());
        for action in policy.action_dependencies {
            assert!(!action.action.as_str().is_empty());
            assert!(!action.activation_condition.as_str().is_empty());
            assert_eq!(action.evidence.path, action.workflow_path);
            assert_eq!(action.evidence.span, action.source_span);
            assert!(action.source_span.start >= 1);
            assert!(action.source_span.end >= action.source_span.start);
            match action.classification {
                ActionDependencyClassification::Independent => saw_independent = true,
                ActionDependencyClassification::BuildDependent => saw_build_dependent = true,
                ActionDependencyClassification::Undetermined => {
                    saw_undetermined = true;
                    assert!(action.unavailable_condition.is_present());
                }
            }
        }
    }
    assert!(saw_independent);
    assert!(saw_build_dependent);
    assert!(saw_undetermined);
}
