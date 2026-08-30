use release_checkpoint_research::{
    render_validated_markdown, validate_research_report, validate_research_report_for_publication,
    ActionArea, ActionRecommendation, AffectedPathsOrNone, ArtifactInventory, Availability,
    CiInventoryAndCausality, CompletionComparison, CompletionStatus, DeltaSection, EvidenceCatalog,
    EvidenceCitation, EvidenceId, EvidenceLocator, EvidenceReference, EvidenceReferenceLocator,
    EvidenceSet, EvidenceSourceIdentity, EvidenceSourceKind, ExactText, Fingerprint, FullId,
    IgnoreResearchAndRemovalRegister, IntegrityAndValidation, LabelledConclusion,
    ReleaseEvidenceAndBaseline, RemovalRecord, RemovalRegister, RepoRelativePath,
    ResearchConclusionLabel, ResearchReport, ResearchReportParts, RunIdentityAndScope,
    StartSnapshot, UtcSeconds, WorkingTreeState,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempRepo {
    root: PathBuf,
}

impl TempRepo {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "release-checkpoint-report-unit-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create fixture");
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "report@example.invalid"]);
        git(&root, &["config", "user.name", "Report Unit"]);
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

fn report() -> ResearchReport {
    let fixture = TempRepo::new("complete");
    let snapshot = fixture.snapshot();
    let mut citations = Vec::new();
    let mut facts = Vec::new();
    for index in 0..4 {
        let evidence_id = EvidenceId::new(format!("unit-evidence-{index}")).expect("evidence ID");
        citations.push(EvidenceCitation::new(
            evidence_id.clone(),
            EvidenceLocator::new(
                RepoRelativePath::new("README.md").expect("path"),
                release_checkpoint_research::InclusiveSpan::new(index as u32 + 1, index as u32 + 1)
                    .expect("span"),
            ),
            Availability::Present(ExactText::new(format!("quoted-{index}"))),
        ));
        facts.push(
            LabelledConclusion::fact(
                format!("unit-fact-{index}"),
                format!("unit fact {index}"),
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
                    format!("unit-recommendation-{index}"),
                    format!("unit recommendation {index}"),
                    Vec::new(),
                )
                .expect("recommendation"),
                vec![facts[index].id.clone()],
                AffectedPathsOrNone::NoneAffected,
                format!("risk {index}"),
                format!("verification {index}"),
            )
            .expect("action")
        })
        .collect();
    let parts = ResearchReportParts::new(
        RunIdentityAndScope::from_snapshot(snapshot),
        WorkingTreeState::empty(),
        EvidenceCatalog::new(
            Vec::new(),
            EvidenceSet::try_new(citations).expect("citations"),
            Vec::new(),
            facts,
        ),
        ReleaseEvidenceAndBaseline::empty(),
        DeltaSection::empty(),
        release_checkpoint_research::ArtifactInventorySection::empty(),
        IgnoreResearchAndRemovalRegister::empty(),
        CiInventoryAndCausality::empty(),
        actions,
        IntegrityAndValidation::empty(),
    );
    ResearchReport::new(parts).expect("valid report")
}

#[test]
fn report_has_exact_fixed_heading_order() {
    let report = report();
    let markdown = report.render_markdown();
    let headings = markdown
        .lines()
        .filter(|line| line.starts_with("## "))
        .collect::<Vec<_>>();
    assert_eq!(headings.len(), 10);
    assert_eq!(
        headings,
        release_checkpoint_research::RESEARCH_REPORT_SECTION_HEADINGS
            .iter()
            .map(|heading| format!("## {heading}"))
            .collect::<Vec<_>>()
    );
}

#[test]
fn empty_and_unavailable_states_are_explicit() {
    let report = report();
    let empty_json = serde_json::to_string(&ReleaseEvidenceAndBaseline::empty()).unwrap();
    let unavailable_json = serde_json::to_string(&CiInventoryAndCausality::unavailable()).unwrap();
    assert!(empty_json.contains("Empty"));
    assert!(unavailable_json.contains("Unavailable"));
    let markdown = report.render_markdown();
    assert!(markdown.contains("staged: Empty"));
    assert!(markdown.contains("selection report: Empty"));
}

#[test]
fn json_round_trip_and_markdown_use_the_same_typed_model() {
    let report = report();
    let json = report.render_json().expect("render JSON");
    let decoded: ResearchReport = serde_json::from_str(&json).expect("decode report JSON");
    assert_eq!(decoded, report);
    let markdown = report.render_markdown();
    assert!(markdown.contains("unit recommendation 0"));
    assert!(markdown.contains("unit-evidence-0"));
    assert!(json.contains("unit recommendation 0"));
    assert!(json.contains("ArtifactRetention"));
}

#[test]
fn validation_rejects_unresolved_or_wrongly_labelled_actions() {
    let mut invalid_support = report();
    invalid_support.action_recommendations[0].supporting_citations =
        vec![EvidenceId::new("does-not-exist").expect("ID")];
    assert!(invalid_support.validate().is_err());

    let mut invalid_label = report();
    invalid_label.action_recommendations[0].statement.label = ResearchConclusionLabel::Fact;
    assert!(invalid_label.validate().is_err());
}

#[test]
fn exact_conclusion_text_is_not_trimmed() {
    let conclusion = LabelledConclusion::fact(
        "exact-text",
        ExactText::new("  source text with boundary spaces  "),
        vec![EvidenceId::new("evidence").expect("ID")],
    )
    .expect("exact conclusion");
    assert_eq!(
        conclusion.statement.as_str(),
        "  source text with boundary spaces  "
    );
}

#[test]
fn strict_validator_rejects_schema_identity_and_uncited_fact_or_gap() {
    let mut schema = report();
    schema.schema_version = ExactText::new("research-report-invalid");
    let error = validate_research_report(&schema).expect_err("invalid schema must fail");
    assert!(error.contains("schema_version"));

    let mut identity = report();
    identity.run_identity_and_scope.run_id = ExactText::new("   ");
    let error = validate_research_report(&identity).expect_err("blank identity must fail");
    assert!(error.contains("run_identity_and_scope.run_id"));

    let mut uncited_fact = report();
    uncited_fact.evidence_catalog.conclusions[0]
        .evidence_ids
        .clear();
    let error = validate_research_report(&uncited_fact).expect_err("uncited FACT must fail");
    assert!(error.contains("FACT and GAP conclusions require evidence"));
}

#[test]
fn strict_validator_rejects_unresolved_actions_and_wrong_cardinality() {
    let mut unresolved = report();
    unresolved.action_recommendations[0].supporting_citations =
        vec![EvidenceId::new("missing-action-fact").expect("valid missing ID")];
    let error = validate_research_report(&unresolved).expect_err("unresolved citation must fail");
    assert!(error.contains("unresolved recommendation citation"));

    let mut missing_area = report();
    missing_area.action_recommendations.pop();
    let error = validate_research_report(&missing_area).expect_err("three actions must fail");
    assert!(error.contains("exactly four ordered action recommendations"));

    let mut wrong_order = report();
    wrong_order.action_recommendations.swap(0, 1);
    let error = validate_research_report(&wrong_order).expect_err("wrong action order must fail");
    assert!(error.contains("action areas must follow the required order"));

    let mut invalid_priority = report();
    invalid_priority.action_recommendations[2].priority = 0;
    let error =
        validate_research_report(&invalid_priority).expect_err("invalid priority must fail");
    assert!(error.contains("priorities must be exactly 1, 2, 3, 4 in order"));
}

#[test]
fn strict_validator_rejects_removal_subset_and_workflow_outcome_errors() {
    let mut removal = report();
    let removal_path = RepoRelativePath::new("cache/extra.bin").expect("path");
    let evidence = EvidenceReference::new(
        EvidenceSourceIdentity::new(EvidenceSourceKind::Worktree, "unit-removal").expect("source"),
        EvidenceReferenceLocator::file(
            RepoRelativePath::new("README.md").expect("evidence path"),
            release_checkpoint_research::InclusiveSpan::new(1, 1).expect("span"),
        ),
    );
    let removal_record = RemovalRecord::new(
        removal_path.clone(),
        "extra register record",
        vec![evidence],
    )
    .expect("removal record");
    let register = RemovalRegister::new(BTreeMap::from([(removal_path, removal_record)]))
        .expect("removal register");
    removal.artifact_inventory.inventory = Availability::Present(ArtifactInventory {
        audited_revision: FullId::new("a".repeat(40)).expect("revision"),
        audited_at_utc: UtcSeconds::now().expect("clock"),
        remote_revision: Availability::Empty,
        remote_paths: Availability::Empty,
        candidates: BTreeMap::new(),
    });
    removal
        .ignore_research_and_removal_register
        .removal_register = Availability::Present(register);
    let error = validate_research_report(&removal).expect_err("subset mismatch must fail");
    assert!(error.contains("records must equal the Remove subset"));

    let mut workflow_outcome = report();
    workflow_outcome.ci_inventory_and_causality.observed_ci_runs =
        Availability::Present(vec![release_checkpoint_research::ObservedCiRun::complete(
            ExactText::new("run-1"),
            ExactText::new(".github/workflows/build.yml"),
            ExactText::new("push"),
            ExactText::new("refs/heads/main"),
            FullId::new("b".repeat(40)).expect("commit"),
            ExactText::new(""),
        )]);
    let error =
        validate_research_report(&workflow_outcome).expect_err("empty workflow outcome must fail");
    assert!(error.contains("observed_ci_runs[0].outcome"));
}

#[test]
fn validated_renderer_requires_verified_completion_integrity() {
    let mut incomplete = report();
    let error = render_validated_markdown(&incomplete)
        .expect_err("empty completion must not render as final output");
    assert!(error.contains("final renderer requires VerifiedNoChanges"));

    let fingerprint = Fingerprint::new("c".repeat(16)).expect("fingerprint");
    incomplete.integrity_and_validation.completion = Availability::Present(CompletionComparison {
        checked_at_utc: UtcSeconds::now().expect("clock"),
        status: CompletionStatus::VerifiedNoChanges,
        start_fingerprint: fingerprint.clone(),
        current_fingerprint: Availability::Present(fingerprint.clone()),
        start_filesystem_fingerprint: fingerprint.clone(),
        current_filesystem_fingerprint: Availability::Present(fingerprint),
        failure_reason: Availability::Empty,
    });
    validate_research_report_for_publication(&incomplete).expect("verified report is publishable");
    assert!(render_validated_markdown(&incomplete)
        .expect("verified report renders")
        .contains("## Integrity and validation"));

    let mut unavailable = report();
    unavailable.integrity_and_validation.completion = Availability::Unavailable;
    let error = validate_research_report(&unavailable)
        .expect_err("unavailable integrity claim must fail closed");
    assert!(error.contains("unavailable completion boundary"));

    let mut failed = report();
    let fingerprint = Fingerprint::new("d".repeat(16)).expect("fingerprint");
    failed.integrity_and_validation.completion = Availability::Present(CompletionComparison {
        checked_at_utc: UtcSeconds::now().expect("clock"),
        status: CompletionStatus::Failed,
        start_fingerprint: fingerprint.clone(),
        current_fingerprint: Availability::Present(fingerprint.clone()),
        start_filesystem_fingerprint: fingerprint.clone(),
        current_filesystem_fingerprint: Availability::Present(fingerprint),
        failure_reason: Availability::Present(ExactText::new("outside change")),
    });
    let error =
        validate_research_report(&failed).expect_err("failed integrity claim must fail closed");
    assert!(error.contains("integrity claims require VerifiedNoChanges"));
}
