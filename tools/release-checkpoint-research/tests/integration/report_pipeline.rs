use release_checkpoint_research::{
    build_policy, evaluate_trigger_conditions, observe_ci_execution, parse_workflow,
    write_research_reports_atomically, ActionArea, ActionRecommendation, AffectedPathsOrNone,
    Availability, BaselineDecision, CiInventoryAndCausality, ComparisonRange, CurrentRevision,
    DeltaComparison, DeltaReport, DeltaSection, EvidenceCatalog, EvidenceCitation, EvidenceId,
    EvidenceLocator, EvidenceReference, EvidenceReferenceLocator, EvidenceSet,
    EvidenceSourceIdentity, ExactText, IgnoreResearchAndRemovalRegister, IntegrityAndValidation,
    LabelledConclusion, LocalReleaseEvidence, ReadmeUpdateInput, ReleaseBaseline,
    ReleaseEvidenceAndBaseline, ReleaseSelectionReport, RepoRelativePath, ResearchReport,
    ResearchReportParts, RunIdentityAndScope, StartSnapshot, TriggerEvaluation, WorkflowDirectory,
    WorkflowInventory, WorkflowRecord, WorkingTreeState,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempRepo {
    root: PathBuf,
}

impl TempRepo {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "release-checkpoint-report-integration-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create fixture");
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "report@example.invalid"]);
        git(&root, &["config", "user.name", "Report Integration"]);
        fs::write(root.join("README.md"), "fixture\n").expect("write fixture");
        git(&root, &["add", "README.md"]);
        git(&root, &["commit", "-qm", "fixture"]);
        Self { root }
    }

    fn snapshot(&self) -> StartSnapshot {
        release_checkpoint_research::AuditSession::start(&self.root)
            .expect("capture snapshot")
            .snapshot()
            .clone()
    }

    fn create_artifact_directory(&self) -> PathBuf {
        let artifact = self.root.join(".kiro/specs/release-checkpoint-research");
        fs::create_dir_all(&artifact).expect("create artifact directory");
        artifact
    }

    fn session(&self) -> release_checkpoint_research::AuditSession {
        release_checkpoint_research::AuditSession::start(&self.root).expect("start session")
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .expect("run fixture git");
    assert!(output.status.success(), "git {args:?} failed");
}

fn action_plan(case: &str) -> EvidenceCatalogAndActions {
    let mut citations = Vec::new();
    let mut conclusions = Vec::new();
    for index in 0..4 {
        let evidence_id = EvidenceId::new(format!("{case}-evidence-{index}")).expect("evidence ID");
        citations.push(EvidenceCitation::new(
            evidence_id.clone(),
            EvidenceLocator::new(
                RepoRelativePath::new("README.md").expect("path"),
                release_checkpoint_research::InclusiveSpan::new(index as u32 + 1, index as u32 + 1)
                    .expect("span"),
            ),
            Availability::Present(ExactText::new(format!("{case}-quote-{index}"))),
        ));
        conclusions.push(
            LabelledConclusion::fact(
                format!("{case}-fact-{index}"),
                format!("{case} fact {index}"),
                vec![evidence_id],
            )
            .expect("fact"),
        );
    }
    let actions = ActionArea::ORDER
        .into_iter()
        .enumerate()
        .map(|(index, area)| {
            ActionRecommendation::new(
                index as u8 + 1,
                area,
                LabelledConclusion::recommendation(
                    format!("{case}-recommendation-{index}"),
                    format!("{case} recommendation {index}"),
                    Vec::new(),
                )
                .expect("recommendation"),
                vec![conclusions[index].id.clone()],
                AffectedPathsOrNone::NoneAffected,
                format!("{case} risk {index}"),
                format!("{case} verification {index}"),
            )
            .expect("action")
        })
        .collect();
    EvidenceCatalogAndActions {
        catalog: EvidenceCatalog::new(
            Vec::new(),
            EvidenceSet::try_new(citations).expect("citations"),
            Vec::new(),
            conclusions,
        ),
        actions,
    }
}

struct EvidenceCatalogAndActions {
    catalog: EvidenceCatalog,
    actions: Vec<ActionRecommendation>,
}

fn report(
    snapshot: StartSnapshot,
    release: ReleaseEvidenceAndBaseline,
    delta: DeltaSection,
    ci: CiInventoryAndCausality,
) -> ResearchReport {
    let plan = action_plan("pipeline");
    ResearchReport::new(ResearchReportParts::new(
        RunIdentityAndScope::from_snapshot(snapshot),
        WorkingTreeState::empty(),
        plan.catalog,
        release,
        delta,
        release_checkpoint_research::ArtifactInventorySection::empty(),
        IgnoreResearchAndRemovalRegister::empty(),
        ci,
        plan.actions,
        IntegrityAndValidation::empty(),
    ))
    .expect("assemble pipeline report")
}

fn no_baseline() -> ReleaseEvidenceAndBaseline {
    let evidence = LocalReleaseEvidence::without_remote(
        Availability::Empty,
        release_checkpoint_research::WorktreeInventories::empty(),
        Availability::Empty,
        Availability::Empty,
        Vec::new(),
    );
    let selection = release_checkpoint_research::release_selection_report(&evidence);
    assert!(selection.decision.is_no_unambiguous());
    ReleaseEvidenceAndBaseline::new(
        Availability::Present(evidence),
        Availability::Present(selection.clone()),
        Availability::Present(selection.decision),
    )
}

fn selected_baseline(commit: &release_checkpoint_research::FullId) -> ReleaseEvidenceAndBaseline {
    let reference = ExactText::new("refs/tags/v1.0.0");
    let evidence = EvidenceReference::new(
        EvidenceSourceIdentity::local_git("integration-release").expect("source"),
        EvidenceReferenceLocator::git_ref(reference.as_str()),
    );
    let baseline = ReleaseBaseline {
        reference,
        commit: commit.clone(),
        resolved_commit: commit.clone(),
        version: ExactText::new("v1.0.0"),
        release_date_observations: Availability::Empty,
        candidate_comparisons: Vec::new(),
        rationale: ExactText::new("one fully linked release candidate was selected"),
        evidence: vec![evidence],
        gaps: Vec::new(),
    };
    let decision = BaselineDecision::Selected(baseline);
    let selection = ReleaseSelectionReport {
        candidates: Vec::new(),
        candidate_comparisons: Vec::new(),
        decision: decision.clone(),
        gaps: Vec::new(),
    };
    ReleaseEvidenceAndBaseline::new(
        Availability::Unavailable,
        Availability::Present(selection),
        Availability::Present(decision),
    )
}

#[test]
fn report_pipeline_preserves_baseline_and_no_baseline_models() {
    let fixture = TempRepo::new();
    let snapshot = fixture.snapshot();
    let current_id = snapshot.identity.head.clone();
    let current = CurrentRevision::new(
        current_id.clone(),
        "2026-08-30T10:00:00+03:30",
        "current fixture subject",
    );
    let fallback = DeltaReport::CurrentFallback(release_checkpoint_research::CurrentFallback::new(
        current.clone(),
    ));
    let no_baseline_report = report(
        snapshot.clone(),
        no_baseline(),
        DeltaSection::new(Availability::Present(fallback)),
        CiInventoryAndCausality::unavailable(),
    );
    assert!(matches!(
        no_baseline_report
            .release_evidence_and_baseline
            .baseline_decision,
        Availability::Present(BaselineDecision::NoUnambiguous { .. })
    ));
    assert!(matches!(
        no_baseline_report.delta.report,
        Availability::Present(DeltaReport::CurrentFallback(_))
    ));
    let no_baseline_json = no_baseline_report.render_json().expect("JSON");
    assert!(no_baseline_json.contains("CurrentFallback"));
    assert!(no_baseline_json.contains("NoUnambiguous"));

    let baseline_id = release_checkpoint_research::FullId::new("a".repeat(40)).unwrap();
    let compared = DeltaReport::Compared(DeltaComparison {
        current: CurrentRevision::new(
            baseline_id.clone(),
            "2026-08-30T10:00:00+03:30",
            "compared fixture subject",
        ),
        range: ComparisonRange::new(baseline_id.clone(), current_id),
        commits: Vec::new(),
        changed_paths: Vec::new(),
    });
    let selected_report = report(
        snapshot,
        selected_baseline(&baseline_id),
        DeltaSection::new(Availability::Present(compared)),
        CiInventoryAndCausality::empty(),
    );
    assert!(matches!(
        selected_report
            .release_evidence_and_baseline
            .baseline_decision,
        Availability::Present(BaselineDecision::Selected(_))
    ));
    assert!(selected_report.delta.report.as_ref().is_present());
    let selected_json = selected_report.render_json().expect("JSON");
    assert!(selected_json.contains("Selected"));
    assert!(selected_json.contains("Compared"));
}

#[test]
fn report_pipeline_keeps_workflow_and_ci_stage_records_typed() {
    let fixture = TempRepo::new();
    let snapshot = fixture.snapshot();
    let source = "name: Build\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    steps:\n      - run: cargo test\n";
    let workflow: WorkflowRecord =
        parse_workflow(".github/workflows/build.yml", source).expect("parse workflow");
    let inventory = WorkflowInventory {
        directory: Availability::Present(WorkflowDirectory {
            path: RepoRelativePath::new(".github/workflows").unwrap(),
            file_count: 1,
        }),
        workflows: Availability::Present(vec![workflow]),
        gaps: Vec::new(),
    };
    let input = ReadmeUpdateInput::complete(
        snapshot.identity.head.clone(),
        Vec::new(),
        vec![RepoRelativePath::new("README.md").unwrap()],
        ExactText::new("push"),
        ExactText::new("refs/heads/main"),
    );
    let evaluations: Vec<TriggerEvaluation> = evaluate_trigger_conditions(&inventory, &input);
    let execution = observe_ci_execution(&input, &[]);
    let policy = build_policy(&inventory, &input);
    let ci = CiInventoryAndCausality::new(
        Availability::Present(inventory),
        Availability::Present(input),
        Availability::Present(evaluations),
        Availability::Present(Vec::new()),
        Availability::Present(execution),
        Availability::Present(policy),
    );
    let report = report(snapshot, no_baseline(), DeltaSection::empty(), ci);
    let json = report.render_json().expect("JSON");
    assert!(json.contains("cargo test"));
    assert!(json.contains("trigger eligibility") || json.contains("no_matching_run_gap"));
    assert!(json.contains("Build"));
}

#[test]
fn invalid_report_is_rejected_before_artifact_directory_creation() {
    let fixture = TempRepo::new();
    let snapshot = fixture.snapshot();
    let mut invalid = report(
        snapshot,
        no_baseline(),
        DeltaSection::empty(),
        CiInventoryAndCausality::empty(),
    );
    invalid.action_recommendations[0].priority = 0;

    assert!(release_checkpoint_research::validate_research_report(&invalid).is_err());
    assert!(write_research_reports_atomically(&fixture.session(), &invalid, true).is_err());
    assert!(!fixture.root.join(".kiro").exists());
}

#[test]
fn valid_report_publishes_only_fixed_outputs_and_preserves_unrelated_artifacts() {
    let fixture = TempRepo::new();
    let artifact = fixture.create_artifact_directory();
    fs::write(artifact.join("keep.txt"), "unrelated artifact\n").expect("write unrelated file");
    let session = fixture.session();
    let candidate = report(
        session.snapshot().clone(),
        no_baseline(),
        DeltaSection::empty(),
        CiInventoryAndCausality::empty(),
    );

    let publication = write_research_reports_atomically(&session, &candidate, true)
        .expect("valid no-change report publishes");
    assert_eq!(
        publication.markdown.output,
        release_checkpoint_research::ReportOutput::ResearchReportMarkdown
    );
    assert_eq!(
        publication.json.expect("JSON companion").output,
        release_checkpoint_research::ReportOutput::ResearchReportJson
    );
    assert!(publication.completion.is_verified());

    let mut names = fs::read_dir(&artifact)
        .expect("read artifact directory")
        .map(|entry| {
            entry
                .expect("artifact entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(
        names,
        vec![
            "keep.txt".to_owned(),
            "research-report.json".to_owned(),
            "research-report.md".to_owned(),
        ]
    );
    assert_eq!(
        fs::read_to_string(artifact.join("keep.txt")).unwrap(),
        "unrelated artifact\n"
    );
    assert!(!names.iter().any(|name| name.contains("tmp")));
}

#[test]
fn markdown_only_publication_does_not_create_json_or_temporary_files() {
    let fixture = TempRepo::new();
    let artifact = fixture.create_artifact_directory();
    let session = fixture.session();
    let candidate = report(
        session.snapshot().clone(),
        no_baseline(),
        DeltaSection::empty(),
        CiInventoryAndCausality::empty(),
    );

    let publication = write_research_reports_atomically(&session, &candidate, false)
        .expect("Markdown-only report publishes");
    assert!(publication.json.is_none());
    assert!(artifact.join("research-report.md").is_file());
    assert!(!artifact.join("research-report.json").exists());
    let names = fs::read_dir(&artifact)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["research-report.md".to_owned()]);
}

#[test]
fn outside_mutation_fails_closed_without_report_or_temporary_outputs() {
    let fixture = TempRepo::new();
    let artifact = fixture.create_artifact_directory();
    fs::write(artifact.join("keep.txt"), "preserve\n").expect("write unrelated artifact");
    let session = fixture.session();
    let candidate = report(
        session.snapshot().clone(),
        no_baseline(),
        DeltaSection::empty(),
        CiInventoryAndCausality::empty(),
    );
    fs::write(
        fixture.root.join("outside-change.txt"),
        "changed after snapshot\n",
    )
    .expect("mutate outside artifact");

    let result = write_research_reports_atomically(&session, &candidate, true);
    assert!(matches!(
        result,
        Err(release_checkpoint_research::ReportPublicationError::Integrity(_))
    ));
    let names = fs::read_dir(&artifact)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["keep.txt".to_owned()]);
}

#[test]
fn atomic_publication_creates_missing_artifact_chain_after_snapshot() {
    let fixture = TempRepo::new();
    let session = fixture.session();
    let candidate = report(
        session.snapshot().clone(),
        no_baseline(),
        DeltaSection::empty(),
        CiInventoryAndCausality::empty(),
    );

    assert!(!fixture.root.join(".kiro").exists());
    let publication = write_research_reports_atomically(&session, &candidate, false)
        .expect("atomic publication creates the fixed artifact chain");
    assert!(publication.markdown.path.as_path().is_file());
    assert!(fixture
        .root
        .join(".kiro/specs/release-checkpoint-research/research-report.md")
        .is_file());
}

#[test]
fn strict_validation_accepts_collector_retain_projection() {
    let fixture = TempRepo::new();
    let session = fixture.session();
    let paths = [RepoRelativePath::new("README.md").expect("path")]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    let inventory = release_checkpoint_research::build_artifact_inventory(
        release_checkpoint_research::ArtifactInventoryInput::new(
            session.snapshot().identity.head.clone(),
            session.snapshot().captured_at_utc,
            Availability::Present(paths.clone()),
            Availability::Present(paths),
        ),
    )
    .expect("build artifact inventory");
    let mut candidate = report(
        session.snapshot().clone(),
        no_baseline(),
        DeltaSection::empty(),
        CiInventoryAndCausality::empty(),
    );
    candidate.artifact_inventory.inventory = Availability::Present(inventory);

    release_checkpoint_research::validate_research_report(&candidate)
        .expect("collector Retain projection remains valid");
}
