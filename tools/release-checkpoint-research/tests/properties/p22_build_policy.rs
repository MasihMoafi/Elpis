// Feature: release-checkpoint-research, Property 22: Build classification and README-only policy are explicit
const PROPERTY_TAG: &str = "p22_build_policy";

use release_checkpoint_research::{
    build_policy, parse_workflow, Availability, BuildExtraction, ExactText, ExpectedBuildResult,
    FullId, ReadmeUpdateInput, RepoRelativePath, WorkflowClassification, WorkflowInventory,
};

fn commit(number: usize) -> FullId {
    FullId::new(format!("{number:040x}")).expect("generated commit")
}

fn inventory(case: usize, build: bool) -> WorkflowInventory {
    let command = if build {
        "cargo test"
    } else {
        "echo diagnostic"
    };
    let source = format!(
        "name: Policy {case}\non:\n  push:\n    branches:\n      - main\n    paths:\n      - README.md\n  workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  build:\n    steps:\n      - run: {command}\n"
    );
    let workflow = parse_workflow(".github/workflows/policy.yml", source).unwrap();
    WorkflowInventory {
        directory: Availability::Empty,
        workflows: Availability::Present(vec![workflow]),
        gaps: Vec::new(),
    }
}

#[test]
fn p22_build_policy_covers_workflow_event_pairs_explicitly() {
    assert_eq!(PROPERTY_TAG, "p22_build_policy");
    let mut saw_automatic = false;
    let mut saw_does_not_run = false;
    let mut saw_manual = false;
    let mut saw_undetermined = false;
    for case in 0..256_usize {
        let is_build = case % 2 == 0;
        let input = if is_build {
            match case % 8 {
                0 => ReadmeUpdateInput::complete(
                    commit(case + 1),
                    Vec::new(),
                    vec![RepoRelativePath::new("README.md").unwrap()],
                    ExactText::new("push"),
                    ExactText::new("refs/heads/main"),
                ),
                2 => ReadmeUpdateInput::complete(
                    commit(case + 1),
                    Vec::new(),
                    vec![RepoRelativePath::new("README.md").unwrap()],
                    ExactText::new("push"),
                    ExactText::new("refs/heads/feature"),
                ),
                4 => ReadmeUpdateInput::new(
                    Availability::Present(commit(case + 1)),
                    Availability::Present(Vec::new()),
                    Availability::Unavailable,
                    Availability::Present(ExactText::new("push")),
                    Availability::Present(ExactText::new("refs/heads/main")),
                ),
                _ => ReadmeUpdateInput::complete(
                    commit(case + 1),
                    Vec::new(),
                    vec![RepoRelativePath::new("README.md").unwrap()],
                    ExactText::new("pull_request"),
                    ExactText::new("refs/heads/main"),
                ),
            }
        } else {
            ReadmeUpdateInput::complete(
                commit(case + 1),
                Vec::new(),
                vec![RepoRelativePath::new("README.md").unwrap()],
                ExactText::new("push"),
                ExactText::new("refs/heads/main"),
            )
        };
        let inventory = inventory(case, is_build);
        let record = inventory.workflows.present_value()[0].clone();
        if is_build {
            assert_eq!(record.classification, WorkflowClassification::BuildWorkflow);
            assert!(record.build_commands.is_present());
            let policy = build_policy(&inventory, &input);
            assert_eq!(policy.predicates.len(), 3);
            assert_eq!(policy.expected_results.len(), 3);
            assert!(policy
                .expected_results
                .iter()
                .all(|outcome| outcome.source_span.start >= 1
                    && outcome.source_span.end >= outcome.source_span.start));
            for outcome in policy.expected_results {
                match outcome.result {
                    ExpectedBuildResult::BuildRunsAutomatically => saw_automatic = true,
                    ExpectedBuildResult::BuildDoesNotRun => saw_does_not_run = true,
                    ExpectedBuildResult::BuildRunsOnlyAfterManualActivation => saw_manual = true,
                    ExpectedBuildResult::ResultCannotBeDetermined {
                        unavailable_condition,
                    } => {
                        saw_undetermined = true;
                        assert!(!unavailable_condition.as_str().is_empty());
                    }
                }
            }
        } else {
            assert_eq!(
                record.classification,
                WorkflowClassification::NonBuildWorkflow
            );
            assert!(!record.categories.is_empty());
            assert!(matches!(record.build, BuildExtraction::NoBuildCommand(_)));
            let policy = build_policy(&inventory, &input);
            assert!(policy.expected_results.is_empty());
            assert!(policy.predicates.is_empty());
        }
    }
    assert!(saw_automatic);
    assert!(saw_does_not_run);
    assert!(saw_manual);
    assert!(saw_undetermined);
}

trait PresentValue<T> {
    fn present_value(&self) -> &T;
}

impl<T: std::fmt::Debug> PresentValue<T> for Availability<T> {
    fn present_value(&self) -> &T {
        match self {
            Availability::Present(value) => value,
            other => panic!("expected present value, got {other:?}"),
        }
    }
}
