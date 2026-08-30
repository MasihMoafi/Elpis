// Feature: release-checkpoint-research, Property 24: Four action recommendations are complete
const PROPERTY_TAG: &str = "p24_action_plan";

use release_checkpoint_research::{
    ActionArea, ActionRecommendation, AffectedPathsOrNone, Availability, CiInventoryAndCausality,
    DeltaSection, EvidenceCatalog, EvidenceCitation, EvidenceId, EvidenceLocator, EvidenceSet,
    ExactText, IgnoreResearchAndRemovalRegister, IntegrityAndValidation, LabelledConclusion,
    ReleaseEvidenceAndBaseline, RepoRelativePath, ResearchReport, ResearchReportParts,
    RunIdentityAndScope, StartSnapshot, WorkingTreeState,
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
            "release-checkpoint-report-p24-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create fixture");
        run_git(&root, &["init", "-q"]);
        run_git(&root, &["config", "user.email", "p24@example.invalid"]);
        run_git(&root, &["config", "user.name", "Property 24"]);
        fs::write(root.join("README.md"), "fixture\n").expect("write fixture");
        run_git(&root, &["add", "README.md"]);
        run_git(&root, &["commit", "-qm", "fixture"]);
        Self { root }
    }

    fn snapshot(&self) -> StartSnapshot {
        release_checkpoint_research::AuditSession::start(&self.root)
            .expect("capture fixture snapshot")
            .snapshot()
            .clone()
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn run_git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .expect("run fixture git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn report(case: usize, snapshot: &StartSnapshot) -> ResearchReport {
    let mut citations = Vec::new();
    let mut facts = Vec::new();
    for index in 0..4 {
        let evidence_id =
            EvidenceId::new(format!("evidence-{case}-{index}")).expect("generated evidence ID");
        let path = RepoRelativePath::new("README.md").expect("fixture path");
        let locator = EvidenceLocator::new(
            path,
            release_checkpoint_research::InclusiveSpan::new(index as u32 + 1, index as u32 + 1)
                .expect("fixture span"),
        );
        citations.push(EvidenceCitation::new(
            evidence_id.clone(),
            locator,
            Availability::Present(ExactText::new(format!("observed-{case}-{index}"))),
        ));
        facts.push(
            LabelledConclusion::fact(
                format!("fact-{case}-{index}"),
                format!("fact statement {case}-{index}"),
                vec![evidence_id],
            )
            .expect("fact conclusion"),
        );
    }
    let evidence = EvidenceSet::try_new(citations).expect("unique citations");
    let catalog = EvidenceCatalog::new(Vec::new(), evidence, Vec::new(), facts.clone());
    let areas = ActionArea::ORDER;
    let actions = areas
        .into_iter()
        .enumerate()
        .map(|(index, area)| {
            let affected = if index % 2 == 0 {
                AffectedPathsOrNone::NoneAffected
            } else {
                AffectedPathsOrNone::paths(vec![RepoRelativePath::new(format!(
                    "artifact-{case}-{index}.bin"
                ))
                .expect("generated affected path")])
                .expect("affected path list")
            };
            ActionRecommendation::new(
                index as u8 + 1,
                area,
                LabelledConclusion::recommendation(
                    format!("recommendation-{case}-{index}"),
                    format!("recommendation statement {case}-{index}"),
                    Vec::new(),
                )
                .expect("recommendation conclusion"),
                vec![facts[index].id.clone()],
                affected,
                format!("bounded risk {case}-{index}"),
                format!("inspect evidence {case}-{index}"),
            )
            .expect("action recommendation")
        })
        .collect();
    let parts = ResearchReportParts::new(
        RunIdentityAndScope::from_snapshot(snapshot.clone()),
        WorkingTreeState::empty(),
        catalog,
        ReleaseEvidenceAndBaseline::empty(),
        DeltaSection::empty(),
        release_checkpoint_research::ArtifactInventorySection::empty(),
        IgnoreResearchAndRemovalRegister::empty(),
        CiInventoryAndCausality::empty(),
        actions,
        IntegrityAndValidation::empty(),
    );
    ResearchReport::new(parts).expect("complete report model")
}

#[test]
fn p24_action_plan_covers_generated_positive_and_negative_cases() {
    assert_eq!(PROPERTY_TAG, "p24_action_plan");
    let fixture = TempRepo::new();
    let snapshot = fixture.snapshot();
    for case in 0..256_usize {
        let mut assembled = report(case, &snapshot);
        if case % 2 == 0 {
            assert_eq!(assembled.action_recommendations.len(), 4);
            assert_eq!(
                assembled
                    .action_recommendations
                    .iter()
                    .map(|action| action.action_area)
                    .collect::<Vec<_>>(),
                ActionArea::ORDER.to_vec()
            );
            assert_eq!(
                assembled
                    .action_recommendations
                    .iter()
                    .map(|action| action.priority)
                    .collect::<Vec<_>>(),
                vec![1, 2, 3, 4]
            );
            for action in &assembled.action_recommendations {
                assert!(!action.supporting_citations.is_empty());
                assert!(
                    action.affected_paths_or_none.is_none()
                        || !action.affected_paths_or_none.as_paths().unwrap().is_empty()
                );
                assert!(!action.risk.as_str().is_empty());
                assert!(!action.verification_method.as_str().is_empty());
                assert_eq!(
                    action.statement.label,
                    release_checkpoint_research::ResearchConclusionLabel::Recommendation
                );
                assert!(action.supporting_citations.iter().all(|id| assembled
                    .evidence_catalog
                    .conclusions
                    .iter()
                    .any(|conclusion| &conclusion.id == id)));
            }
            let markdown = assembled.render_markdown();
            let positions = release_checkpoint_research::RESEARCH_REPORT_SECTION_HEADINGS
                .iter()
                .map(|heading| markdown.find(&format!("## {heading}")))
                .collect::<Option<Vec<_>>>()
                .expect("all report headings");
            assert!(positions.windows(2).all(|window| window[0] < window[1]));
        } else {
            assembled.action_recommendations[0].priority = 4;
            assert!(assembled.validate().is_err());
        }
    }
}
