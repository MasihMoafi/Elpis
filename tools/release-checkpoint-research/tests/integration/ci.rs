use release_checkpoint_research::{
    build_policy, collect_workflow_inventory, evaluate_trigger_conditions, observe_ci_execution,
    parse_workflow, ActionDependencyClassification, Availability, BuildExtraction, BuildOperation,
    ExactText, FullId, NonBuildCategory, ObservedCiRun, ReadmeUpdateInput, RepoRelativePath,
    TriggerCategory, TriggerResult, WorkflowClassification, WorkflowParseStatus,
    WorkflowRecordKind,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "release-checkpoint-ci-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create CI fixture");
        Self { path }
    }

    fn write(&self, relative: &str, source: &str) {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create CI fixture parent");
        }
        fs::write(path, source).expect("write CI fixture");
    }

    fn root(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn valid_workflow_preserves_events_filters_schedule_inputs_conditions_and_commands() {
    let source = "name: Release\non:\n  push:\n    branches:\n      - main\n    tags-ignore: [v*]\n    paths:\n      - src/**\n  pull_request:\n    paths-ignore:\n      - docs/**\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:\n    inputs:\n      environment:\n        description: Deploy target\n        required: true\n        default: staging\n        type: choice\n        options: [staging, production]\njobs:\n  build:\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    steps:\n      - name: Build\n        run: cargo build --release\n      - name: Upload\n        uses: actions/upload-artifact@v4\n  docs:\n    steps:\n      - run: echo build\n";
    let record = parse_workflow(".github/workflows/release.yml", source).unwrap();

    assert_eq!(record.kind, WorkflowRecordKind::Workflow);
    assert_eq!(record.parse_status, WorkflowParseStatus::Parsed);
    assert_eq!(record.raw_source, Availability::Present(source.into()));
    assert_eq!(record.classification, WorkflowClassification::BuildWorkflow);
    assert!(record.parse_gaps.is_empty());

    let events = match &record.triggers.events {
        Availability::Present(events) => events,
        other => panic!("expected events, got {other:?}"),
    };
    assert_eq!(
        events
            .iter()
            .map(|event| event.name.as_str())
            .collect::<Vec<_>>(),
        vec!["push", "pull_request", "schedule", "workflow_dispatch",]
    );
    let push = &events[0];
    assert_eq!(
        push.branches.as_ref().present_value()[0].value.as_str(),
        "main"
    );
    assert_eq!(
        push.tags_ignore.as_ref().present_value()[0].raw.as_str(),
        "v*"
    );
    assert_eq!(
        push.paths.as_ref().present_value()[0].value.as_str(),
        "src/**"
    );
    assert_eq!(
        events[2].schedules.as_ref().present_value()[0]
            .cron
            .value
            .as_str(),
        "0 0 * * *"
    );
    let inputs = events[3].manual_inputs.present_value();
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0].name.value.as_str(), "environment");
    assert_eq!(
        inputs[0].default.as_ref().present_value().value.as_str(),
        "staging"
    );
    assert_eq!(
        inputs[0].required.as_ref().present_value().value.as_str(),
        "true"
    );
    assert_eq!(inputs[0].options.as_ref().present_value().len(), 2);

    let conditions = record.job_conditions.present_value();
    assert_eq!(conditions.len(), 1);
    assert_eq!(conditions[0].job.as_str(), "build");
    assert!(conditions[0]
        .condition
        .value
        .as_str()
        .contains("github.ref"));

    let commands = match &record.build {
        BuildExtraction::Commands(commands) => commands,
        other => panic!("expected build commands, got {other:?}"),
    };
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0].operation, BuildOperation::Compile);
    assert_eq!(
        commands[0].command.as_ref().present_value().as_str(),
        "cargo build --release"
    );
    assert_eq!(commands[0].job.as_str(), "build");
    assert_eq!(commands[0].step.as_str(), "Build");
    assert_eq!(commands[1].operation, BuildOperation::Upload);
    assert_eq!(
        commands[1].action.as_ref().present_value().as_str(),
        "actions/upload-artifact@v4"
    );
    assert_eq!(commands[1].span.start, 30);
    assert!(record
        .triggers
        .none_configured
        .iter()
        .any(|record| record.category == TriggerCategory::BranchesIgnore));
}

#[test]
fn malformed_yaml_is_retained_with_exact_source_and_named_gap() {
    let source = "name: Broken\non:\n  push:\n    branches: [main\njobs:\n  build:\n    steps:\n      - run: cargo test\n";
    let record = parse_workflow(".github/workflows/broken.yml", source).unwrap();
    assert_eq!(record.raw_source, Availability::Present(source.into()));
    assert_eq!(record.kind, WorkflowRecordKind::ParseGap);
    assert_eq!(record.parse_status, WorkflowParseStatus::ParseGap);
    assert!(!record.parse_gaps.is_empty());
    assert!(record
        .parse_gaps
        .iter()
        .all(|gap| gap.path.as_str() == ".github/workflows/broken.yml"));
    assert!(record.parse_gaps.iter().any(|gap| gap.span.start == 4));
    assert_eq!(record.source_span.end, 8);
}

#[test]
fn empty_missing_and_non_workflow_sources_are_explicit() {
    let missing = TempDir::new("missing");
    let missing_inventory = collect_workflow_inventory(missing.root()).unwrap();
    assert!(missing_inventory.directory.is_empty());
    assert!(missing_inventory.workflows.is_empty());

    let empty = TempDir::new("empty");
    fs::create_dir_all(empty.root().join(".github/workflows")).unwrap();
    let empty_inventory = collect_workflow_inventory(empty.root()).unwrap();
    assert!(empty_inventory.directory.is_present());
    assert!(empty_inventory.workflows.is_empty());

    let fixture = TempDir::new("non-workflow");
    fixture.write(
        ".github/workflows/notes.txt",
        "note: this is an audit note\n",
    );
    fixture.write(
        ".github/workflows/ordinary.yml",
        "name: ordinary\npurpose: documentation\n",
    );
    let inventory = collect_workflow_inventory(fixture.root()).unwrap();
    let records = inventory.workflows.present_value();
    assert_eq!(records.len(), 2);
    assert!(records
        .iter()
        .all(|record| record.kind == WorkflowRecordKind::NonWorkflow));
    assert!(records
        .iter()
        .all(|record| record.classification == WorkflowClassification::NonBuildWorkflow));
    assert!(records.iter().all(
        |record| record.categories.contains(&NonBuildCategory::Other)
            || !record.categories.is_empty()
    ));
    assert!(records
        .iter()
        .all(|record| record.no_build_command().is_some()));
}

#[cfg(unix)]
#[test]
fn collector_rejects_symlinked_github_parent_without_following_it() {
    use std::os::unix::fs::symlink;

    let fixture = TempDir::new("github-parent-symlink");
    fixture.write(
        "external/.github/workflows/hidden.yml",
        "name: hidden\non: push\n",
    );
    symlink(
        fixture.root().join("external/.github"),
        fixture.root().join(".github"),
    )
    .unwrap();
    let inventory = collect_workflow_inventory(fixture.root()).unwrap();
    assert!(inventory.directory.is_unavailable());
    assert!(inventory.workflows.is_unavailable());
    assert!(inventory
        .gaps
        .iter()
        .any(|gap| gap.path.as_str() == ".github"));
}

#[test]
fn inline_events_steps_and_false_positive_echo_are_handled_conservatively() {
    let source = "on: [push, workflow_dispatch]\njobs:\n  test:\n    steps:\n      - run: echo build\n      - run: npm test\n      - uses: actions/setup-node@v4\n      - uses: actions/checkout@v4\n";
    let record = parse_workflow(".github/workflows/inline.yml", source).unwrap();
    assert_eq!(record.classification, WorkflowClassification::BuildWorkflow);
    let commands = match &record.build {
        BuildExtraction::Commands(commands) => commands,
        other => panic!("expected npm/setup commands, got {other:?}"),
    };
    assert_eq!(commands.len(), 2);
    assert!(commands
        .iter()
        .any(|command| command.operation == BuildOperation::Test));
    assert!(commands
        .iter()
        .any(|command| command.operation == BuildOperation::Setup));
    assert!(!commands
        .iter()
        .any(|command| command.text.as_str() == "echo build"));

    let no_build = parse_workflow(
        ".github/workflows/diagnostic.yml",
        "name: Diagnostic\non: push\njobs:\n  check:\n    steps:\n      - run: echo build\n      - uses: actions/checkout@v4\n",
    )
    .unwrap();
    assert_eq!(
        no_build.classification,
        WorkflowClassification::NonBuildWorkflow
    );
    assert!(matches!(no_build.build, BuildExtraction::NoBuildCommand(_)));
    assert!(!no_build.categories.is_empty());

    let inline_map = parse_workflow(
        ".github/workflows/inline-map.yml",
        "on: {push: {branches: [main]}, schedule: {cron: '0 1 * * *'}, workflow_call: {inputs: {version: {type: string, required: true}}}}\njobs:\n  check:\n    steps:\n      - run: echo build\n",
    )
    .unwrap();
    let inline_events = inline_map.triggers.events.present_value();
    assert_eq!(inline_events.len(), 3);
    assert_eq!(
        inline_events[0].branches.present_value()[0].value.as_str(),
        "main"
    );
    assert_eq!(
        inline_events[1].schedules.present_value()[0]
            .cron
            .value
            .as_str(),
        "0 1 * * *"
    );
    assert_eq!(
        inline_events[2].manual_inputs.present_value()[0]
            .input_type
            .present_value()
            .value
            .as_str(),
        "string"
    );
}

#[cfg(unix)]
#[test]
fn collector_retains_symlink_as_unavailable_without_following_it() {
    use std::os::unix::fs::symlink;

    let fixture = TempDir::new("symlink");
    fixture.write("outside.yml", "name: outside\non: push\n");
    fs::create_dir_all(fixture.root().join(".github/workflows")).unwrap();
    symlink(
        fixture.root().join("outside.yml"),
        fixture.root().join(".github/workflows/outside.yml"),
    )
    .unwrap();
    let inventory = collect_workflow_inventory(fixture.root()).unwrap();
    let record = inventory
        .workflows
        .present_value()
        .first()
        .expect("symlink record");
    assert_eq!(record.kind, WorkflowRecordKind::Unavailable);
    assert!(record.raw_source.is_unavailable());
    assert!(record
        .parse_gaps
        .iter()
        .any(|gap| gap.reason.as_str().contains("symlink")));
}

trait AvailabilityExt<T> {
    fn present_value(&self) -> &T;
}

impl<T: std::fmt::Debug> AvailabilityExt<T> for Availability<T> {
    fn present_value(&self) -> &T {
        match self {
            Availability::Present(value) => value,
            other => panic!("expected present value, got {other:?}"),
        }
    }
}

#[test]
fn ci_pipeline_separates_readme_eligibility_from_execution_and_policy() {
    let fixture = TempDir::new("causality-pipeline");
    fixture.write(
        ".github/workflows/readme.yml",
        "name: README CI\non:\n  push:\n    branches:\n      - main\n    paths:\n      - README.md\n  workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  build:\n    steps:\n      - run: cargo test\n",
    );
    fixture.write(
        ".github/workflows/security.yml",
        "name: Security\non:\n  workflow_dispatch:\njobs:\n  security:\n    steps:\n      - run: echo audit\n",
    );
    let inventory = collect_workflow_inventory(fixture.root()).unwrap();
    let update_commit = FullId::new("0123456789abcdef0123456789abcdef01234567").unwrap();
    let input = ReadmeUpdateInput::complete(
        update_commit.clone(),
        Vec::new(),
        vec![RepoRelativePath::new("README.md").unwrap()],
        ExactText::new("push"),
        ExactText::new("refs/heads/main"),
    );
    let evaluations = evaluate_trigger_conditions(&inventory, &input);
    let readme = evaluations
        .iter()
        .find(|evaluation| evaluation.workflow_path.as_str().ends_with("readme.yml"))
        .expect("README workflow evaluation");
    assert_eq!(readme.result, TriggerResult::Eligible);
    assert!(readme.is_cited());

    let no_run = observe_ci_execution(&input, &[]);
    assert!(no_run.matching_runs.is_empty());
    assert!(matches!(
        no_run.no_matching_run_gap,
        Availability::Present(_)
    ));

    let run = ObservedCiRun::new(
        Availability::Unavailable,
        Availability::Present(ExactText::new(".github/workflows/readme.yml")),
        Availability::Present(ExactText::new("push")),
        Availability::Present(ExactText::new("refs/heads/main")),
        Availability::Present(update_commit),
        Availability::Unavailable,
    );
    let observed = observe_ci_execution(&input, &[run]);
    assert_eq!(observed.matching_runs.len(), 1);
    assert!(observed.no_matching_run_gap.is_empty());
    assert!(observed.matching_runs[0].run_id.is_unavailable());
    assert!(observed.matching_runs[0].outcome.is_unavailable());

    let policy = build_policy(&inventory, &input);
    assert_eq!(policy.expected_results.len(), 3);
    assert_eq!(policy.predicates.len(), 3);
    assert!(policy
        .expected_results
        .iter()
        .all(|outcome| outcome.source_span.start >= 1));
    assert!(policy.action_dependencies.iter().any(|action| {
        action.kind == release_checkpoint_research::ActionKind::Manual
            && action.classification == ActionDependencyClassification::Independent
    }));
}

#[test]
fn ci_filters_distinguish_branch_tag_and_unavailable_path_inputs() {
    let source = "name: Filtered\non:\n  push:\n    branches:\n      - main\n    tags:\n      - v*\n    paths-ignore:\n      - docs/**\njobs:\n  build:\n    steps:\n      - run: npm test\n";
    let workflow = parse_workflow(".github/workflows/filtered.yml", source).unwrap();
    let inventory = release_checkpoint_research::WorkflowInventory {
        directory: Availability::Empty,
        workflows: Availability::Present(vec![workflow]),
        gaps: Vec::new(),
    };
    let base = |reference: &str, paths| {
        ReadmeUpdateInput::complete(
            FullId::new("fedcba9876543210fedcba9876543210fedcba98").unwrap(),
            Vec::new(),
            paths,
            ExactText::new("push"),
            ExactText::new(reference),
        )
    };
    let branch = evaluate_trigger_conditions(
        &inventory,
        &base(
            "refs/heads/main",
            vec![RepoRelativePath::new("src/lib.rs").unwrap()],
        ),
    );
    assert_eq!(branch[0].result, TriggerResult::Eligible);

    let tag = evaluate_trigger_conditions(
        &inventory,
        &base(
            "refs/tags/v1.0.0",
            vec![RepoRelativePath::new("src/lib.rs").unwrap()],
        ),
    );
    assert_eq!(tag[0].result, TriggerResult::Eligible);

    let unavailable_paths = ReadmeUpdateInput::new(
        Availability::Present(FullId::new("fedcba9876543210fedcba9876543210fedcba98").unwrap()),
        Availability::Present(Vec::new()),
        Availability::Unavailable,
        Availability::Present(ExactText::new("push")),
        Availability::Present(ExactText::new("refs/heads/main")),
    );
    let unknown = evaluate_trigger_conditions(&inventory, &unavailable_paths);
    assert_eq!(unknown[0].result, TriggerResult::Undetermined);
    assert!(unknown[0]
        .conditions
        .iter()
        .any(|condition| condition.result == TriggerResult::Undetermined));
}
