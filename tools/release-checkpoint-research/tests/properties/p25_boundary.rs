// Feature: release-checkpoint-research, Property 25: Audit boundary is write-safe and reproducible
const PROPERTY_TAG: &str = "p25_boundary";

use release_checkpoint_research::{
    is_visualization_path, render_validated_markdown, validate_research_report,
    write_research_reports_atomically, ActionArea, ActionRecommendation, AffectedPathsOrNone,
    AuditSession, Availability, CiInventoryAndCausality, DeltaSection, EvidenceCatalog,
    EvidenceCitation, EvidenceId, EvidenceLocator, EvidenceSet, ExactText,
    IgnoreResearchAndRemovalRegister, IntegrityAndValidation, LabelledConclusion,
    ReleaseEvidenceAndBaseline, RepoRelativePath, ReportOutput, ResearchConclusionLabel,
    ResearchReport, ResearchReportParts, RunIdentityAndScope, WorkingTreeState,
};
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
            "release-checkpoint-p25-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create disposable repository");
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "p25@example.invalid"]);
        git(&root, &["config", "user.name", "Property 25"]);
        fs::write(root.join("README.md"), "property fixture\n").expect("fixture");
        git(&root, &["add", "README.md"]);
        git(&root, &["commit", "-qm", "fixture"]);
        Self { root }
    }

    fn create_artifact_directory(&self) {
        fs::create_dir_all(self.root.join(".kiro/specs/release-checkpoint-research"))
            .expect("create report artifact directory");
    }

    fn session(&self) -> AuditSession {
        AuditSession::start(&self.root).expect("start audit session")
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
        .expect("run disposable git command");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn report(session: &AuditSession, case: usize) -> ResearchReport {
    let mut citations = Vec::new();
    let mut facts = Vec::new();
    for index in 0..4 {
        let evidence_id = EvidenceId::new(format!("p25-evidence-{case}-{index}")).unwrap();
        citations.push(EvidenceCitation::new(
            evidence_id.clone(),
            EvidenceLocator::new(
                RepoRelativePath::new("README.md").unwrap(),
                release_checkpoint_research::InclusiveSpan::new(index + 1, index + 1).unwrap(),
            ),
            Availability::Present(ExactText::new(format!("quote-{case}-{index}"))),
        ));
        facts.push(
            LabelledConclusion::fact(
                format!("p25-fact-{case}-{index}"),
                format!("fixture fact {case}-{index}"),
                vec![evidence_id],
            )
            .unwrap(),
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
                    format!("p25-recommendation-{case}-{index}"),
                    format!("fixture recommendation {case}-{index}"),
                    Vec::new(),
                )
                .unwrap(),
                vec![facts[index].id.clone()],
                if index % 2 == 0 {
                    AffectedPathsOrNone::NoneAffected
                } else {
                    AffectedPathsOrNone::paths(vec![RepoRelativePath::new(format!(
                        "reports/p25-{case}-{index}.txt"
                    ))
                    .unwrap()])
                    .unwrap()
                },
                format!("risk {case}-{index}"),
                format!("verify {case}-{index}"),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let parts = ResearchReportParts::new(
        RunIdentityAndScope::from_snapshot(session.snapshot().clone()),
        WorkingTreeState::empty(),
        EvidenceCatalog::new(
            Vec::new(),
            EvidenceSet::try_new(citations).unwrap(),
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
    ResearchReport::new(parts).expect("assemble valid p25 report")
}

#[test]
fn p25_tag_and_256_generated_positive_negative_publication_cases() {
    assert_eq!(PROPERTY_TAG, "p25_boundary");

    let positive_repo = TempRepo::new("positive");
    positive_repo.create_artifact_directory();
    let positive_session = positive_repo.session();
    for case in 0..128_usize {
        let candidate = report(&positive_session, case);
        let publication = write_research_reports_atomically(&positive_session, &candidate, true)
            .expect("verified report publishes atomically");
        assert_eq!(
            publication.markdown.output,
            ReportOutput::ResearchReportMarkdown
        );
        assert_eq!(
            publication.json.unwrap().output,
            ReportOutput::ResearchReportJson
        );
        let names = fs::read_dir(
            positive_repo
                .root
                .join(".kiro/specs/release-checkpoint-research"),
        )
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
        assert!(names
            .iter()
            .all(|name| { name == "research-report.md" || name == "research-report.json" }));
        assert_eq!(names.len(), 2);
    }

    let negative_repo = TempRepo::new("negative");
    let negative_session = negative_repo.session();
    for case in 0..128_usize {
        let mut candidate = report(&negative_session, case);
        candidate.action_recommendations[case % 4].priority = 0;
        assert!(validate_research_report(&candidate).is_err());
        assert!(
            write_research_reports_atomically(&negative_session, &candidate, case % 2 == 0)
                .is_err()
        );
        assert!(!negative_repo.root.join(".kiro").exists());
    }
}

#[test]
fn p25_invalid_boundary_claims_and_visualization_identifiers_never_open_output() {
    assert_eq!(PROPERTY_TAG, "p25_boundary");
    for case in 0..128_usize {
        let repo = TempRepo::new(&format!("invalid-{case}"));
        let session = repo.session();
        let mut unavailable = report(&session, case);
        unavailable.integrity_and_validation.completion = Availability::Unavailable;
        assert!(validate_research_report(&unavailable).is_err());
        assert!(write_research_reports_atomically(&session, &unavailable, false).is_err());
        assert!(!repo.root.join(".kiro").exists());
    }

    let repo = TempRepo::new("visualization");
    let session = repo.session();
    let mut visualization = report(&session, 0);
    visualization.run_identity_and_scope.run_id =
        ExactText::new("https://masihmoafi.com/projects/elpis");
    assert!(validate_research_report(&visualization).is_err());
    assert!(write_research_reports_atomically(&session, &visualization, true).is_err());
    assert!(!repo.root.join(".kiro").exists());
}

#[test]
fn p25_safe_paths_and_visualization_denylist_are_closed() {
    assert_eq!(PROPERTY_TAG, "p25_boundary");
    let repo = TempRepo::new("paths");
    let session = repo.session();
    assert!(session
        .boundary()
        .artifact_directory()
        .starts_with(session.boundary().repository_root()));
    assert_eq!(
        session.boundary().path_disposition(
            &RepoRelativePath::new(".kiro/specs/release-checkpoint-research").unwrap()
        ),
        release_checkpoint_research::PathDisposition::ProtectedArtifact
    );
    for case in 0..128_usize {
        let escaped = match case % 4 {
            0 => "../outside",
            1 => "/absolute/path",
            2 => "..\\outside",
            _ => "C:/outside",
        };
        assert!(RepoRelativePath::new(escaped).is_err());
        let visualization =
            format!("https://masihmoafi.com/projects/elpis/plot-{case}?source=report");
        assert!(is_visualization_path(&visualization));
        assert!(ReportOutput::parse("visualization.svg").is_err());
    }
}

#[cfg(unix)]
#[test]
fn p25_rejects_existing_final_symlink_and_hardlink() {
    use std::fs::hard_link;
    use std::os::unix::fs::symlink;

    let symlink_repo = TempRepo::new("symlink-output");
    let artifact = symlink_repo
        .root
        .join(".kiro/specs/release-checkpoint-research");
    fs::create_dir_all(&artifact).unwrap();
    let target = symlink_repo.root.join("outside-target.md");
    fs::write(&target, "must remain\n").unwrap();
    symlink(&target, artifact.join("research-report.md")).unwrap();
    let symlink_session = symlink_repo.session();
    let symlink_report = report(&symlink_session, 1);
    assert!(write_research_reports_atomically(&symlink_session, &symlink_report, false).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "must remain\n");

    let hardlink_repo = TempRepo::new("hardlink-output");
    let artifact = hardlink_repo
        .root
        .join(".kiro/specs/release-checkpoint-research");
    fs::create_dir_all(&artifact).unwrap();
    let target = hardlink_repo.root.join("outside-hardlink.md");
    fs::write(&target, "must remain\n").unwrap();
    hard_link(&target, artifact.join("research-report.md")).unwrap();
    let hardlink_session = hardlink_repo.session();
    let hardlink_report = report(&hardlink_session, 2);
    assert!(write_research_reports_atomically(&hardlink_session, &hardlink_report, false).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "must remain\n");
}

#[test]
fn p25_validated_renderer_requires_completion_integrity() {
    assert_eq!(PROPERTY_TAG, "p25_boundary");
    let repo = TempRepo::new("renderer");
    repo.create_artifact_directory();
    let session = repo.session();
    let mut incomplete = report(&session, 0);
    incomplete.integrity_and_validation.completion = Availability::Empty;
    assert!(render_validated_markdown(&incomplete).is_err());
    let mut complete = report(&session, 1);
    let mut completion = session.compare_completion();
    for _ in 0..4 {
        if completion.is_verified() {
            break;
        }
        completion = session.compare_completion();
    }
    complete.integrity_and_validation.completion = Availability::Present(completion);
    let markdown = render_validated_markdown(&complete).expect("complete report renders");
    assert_eq!(markdown.matches("\n## ").count(), 10);
    assert!(markdown.contains("No source, ignore-file, CI-workflow"));
    assert_eq!(
        complete.action_recommendations[0].statement.label,
        ResearchConclusionLabel::Recommendation
    );
}

#[test]
fn p25_outside_artifact_mutation_fails_closed() {
    assert_eq!(PROPERTY_TAG, "p25_boundary");
    let repo = TempRepo::new("outside-change");
    repo.create_artifact_directory();
    let artifact = repo.root.join(".kiro/specs/release-checkpoint-research");
    fs::write(artifact.join("keep.txt"), "preserve\n").expect("unrelated artifact");
    let session = repo.session();
    let candidate = report(&session, 0);
    fs::write(
        repo.root.join("outside-change.txt"),
        "changed after snapshot\n",
    )
    .expect("outside mutation");

    assert!(write_research_reports_atomically(&session, &candidate, true).is_err());
    assert!(!artifact.join("research-report.md").exists());
    assert!(!artifact.join("research-report.json").exists());
    assert_eq!(
        fs::read_to_string(artifact.join("keep.txt")).unwrap(),
        "preserve\n"
    );
}
