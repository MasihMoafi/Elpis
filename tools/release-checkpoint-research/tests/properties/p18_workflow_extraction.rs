// Feature: release-checkpoint-research, Property 18: Workflow inventory and command extraction are lossless
// Feature: release-checkpoint-research, Property 18: Workflow inventory and command extraction are lossless
const PROPERTY_TAG: &str = "p18_workflow_extraction";

use release_checkpoint_research::{
    collect_workflow_inventory, parse_workflow, Availability, BuildExtraction, NonBuildCategory,
    WorkflowClassification, WorkflowParseStatus,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(case: usize) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "release-checkpoint-p18-{}-{case}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create property fixture");
        Self { path }
    }

    fn write(&self, relative: &str, source: &str) {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create fixture parent");
        }
        fs::write(path, source).expect("write property fixture");
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
fn p18_exact_tag_and_128_generated_workflow_cases_are_lossless() {
    assert_eq!(PROPERTY_TAG, "p18_workflow_extraction");

    for case in 0..128_usize {
        let branch = format!("release-{case}");
        let path = format!(".github/workflows/generated-{case}.yml");
        let has_build = case % 2 == 0;
        let command = if has_build {
            format!("cargo test --workspace --features case-{case}")
        } else {
            "echo build".to_owned()
        };
        let source = format!(
            "name: generated-{case}\non:\n  push:\n    branches: [{branch}]\njobs:\n  audit:\n    runs-on: ubuntu-latest\n    steps:\n      - name: generated step {case}\n        run: {command}\n"
        );

        let parsed = parse_workflow(&path, &source).expect("parse generated workflow");
        assert_eq!(parsed.path.as_str(), path);
        assert_eq!(
            parsed.raw_source,
            Availability::Present(source.clone().into())
        );
        assert_eq!(
            parsed.source_text,
            Availability::Present(source.clone().into())
        );
        assert_eq!(parsed.source_span.start, 1);
        assert_eq!(
            parsed.source_span.end as usize,
            source.split_terminator('\n').count().max(1)
        );
        assert!(matches!(
            parsed.parse_status,
            WorkflowParseStatus::Parsed | WorkflowParseStatus::ParseGap
        ));
        let events = match &parsed.triggers.events {
            Availability::Present(events) => events,
            other => panic!("expected event inventory, got {other:?}"),
        };
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].name.as_str(), "push");
        let branches = match &events[0].branches {
            Availability::Present(values) => values,
            other => panic!("expected exact branch value, got {other:?}"),
        };
        assert_eq!(branches[0].value.as_str(), branch);
        assert_eq!(branches[0].span.start, 4);
        assert_eq!(branches[0].span.end, 4);
        assert!(!parsed.triggers.none_configured.is_empty());

        if has_build {
            assert_eq!(parsed.classification, WorkflowClassification::BuildWorkflow);
            let commands = match &parsed.build {
                BuildExtraction::Commands(commands) => commands,
                other => panic!("expected build command, got {other:?}"),
            };
            assert_eq!(commands.len(), 1);
            assert_eq!(commands[0].text.as_str(), command);
            assert_eq!(commands[0].job.as_str(), "audit");
            assert_eq!(commands[0].step.as_str(), format!("generated step {case}"));
            assert!(commands[0].span.start > branches[0].span.end);
        } else {
            assert_eq!(
                parsed.classification,
                WorkflowClassification::NonBuildWorkflow
            );
            assert!(parsed.no_build_command().is_some());
            assert!(!parsed.categories.is_empty());
            assert!(parsed.categories.iter().all(|category| matches!(
                category,
                NonBuildCategory::Security
                    | NonBuildCategory::Audit
                    | NonBuildCategory::Diagnostic
                    | NonBuildCategory::Other
            )));
        }

        let fixture = TempDir::new(case);
        fixture.write(&path, &source);
        fixture.write(".github/workflows/audit.txt", "note: audit\n");
        fixture.write(
            ".github/workflows/nested/diagnostic.txt",
            "note: diagnostic\n",
        );
        let inventory =
            collect_workflow_inventory(fixture.root()).expect("collect workflow inventory");
        let records = match &inventory.workflows {
            Availability::Present(records) => records,
            other => panic!("expected three workflow-directory records, got {other:?}"),
        };
        assert_eq!(records.len(), 3);
        let paths = records
            .iter()
            .map(|record| record.path.as_str().to_owned())
            .collect::<Vec<_>>();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
        let unique = paths.iter().collect::<std::collections::BTreeSet<_>>();
        assert_eq!(unique.len(), paths.len());
        let generated = records
            .iter()
            .find(|record| record.path.as_str() == path)
            .expect("generated record");
        assert_eq!(generated.raw_source, Availability::Present(source.into()));
        assert_eq!(generated.source_span.start, 1);
        assert!(records
            .iter()
            .find(|record| record.path.as_str().ends_with("audit.txt"))
            .is_some_and(|record| !record.is_workflow()));
    }
}
