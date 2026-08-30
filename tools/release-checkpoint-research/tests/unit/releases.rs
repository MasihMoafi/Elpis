use release_checkpoint_research::{
    collect_local_release_evidence, normalize_release_candidates, select_release_baseline,
    serialize_deterministically, Availability, BaselineDecision, ExactText, FullId, InclusiveSpan,
    LocalRefObservation, LocalReleaseEvidence, PackageManifestVersionDeclaration,
    ReleaseDocumentDeclaration, RemoteReferenceObservation, RemoteSnapshotCollector,
    RepoRelativePath, WorktreeInventories, NO_UNAMBIGUOUS_RELEASE_BASELINE,
    RELEASE_DATE_EVIDENCE_UNAVAILABLE,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn id(hex: char) -> FullId {
    FullId::new(hex.to_string().repeat(40)).expect("full object ID")
}

fn local_tag(name: &str, commit: char, date: Availability<ExactText>) -> LocalRefObservation {
    LocalRefObservation::try_new(
        format!("refs/tags/{name}"),
        Availability::Present(id(commit)),
        date,
        Availability::Present(ExactText::new(format!("release {name}"))),
    )
    .expect("local tag observation")
}

fn document(path: &str, line: u32, version: &str, text: &str) -> ReleaseDocumentDeclaration {
    ReleaseDocumentDeclaration::try_new(
        RepoRelativePath::new(path).expect("document path"),
        InclusiveSpan::new(line, line).expect("document span"),
        version,
        text,
    )
    .expect("document declaration")
}

fn manifest(path: &str, line: u32, version: &str, text: &str) -> PackageManifestVersionDeclaration {
    PackageManifestVersionDeclaration::try_new(
        RepoRelativePath::new(path).expect("manifest path"),
        InclusiveSpan::new(line, line).expect("manifest span"),
        version,
        text,
    )
    .expect("manifest declaration")
}

fn evidence(
    refs: Vec<LocalRefObservation>,
    documents: Vec<ReleaseDocumentDeclaration>,
    manifests: Vec<PackageManifestVersionDeclaration>,
) -> LocalReleaseEvidence {
    LocalReleaseEvidence::without_remote(
        if refs.is_empty() {
            Availability::Empty
        } else {
            Availability::Present(refs)
        },
        WorktreeInventories::empty(),
        if documents.is_empty() {
            Availability::Empty
        } else {
            Availability::Present(documents)
        },
        if manifests.is_empty() {
            Availability::Empty
        } else {
            Availability::Present(manifests)
        },
        Vec::new(),
    )
}

#[test]
fn lightweight_and_annotated_tag_observations_are_candidates_and_date_ordered() {
    let value = evidence(
        vec![
            local_tag(
                "v1.0.0",
                'a',
                Availability::Present(ExactText::new("2026-01-01T00:00:00Z")),
            ),
            local_tag(
                "v1.1.0",
                'b',
                Availability::Present(ExactText::new("2026-02-01T00:00:00Z")),
            ),
        ],
        Vec::new(),
        Vec::new(),
    );
    let candidates = normalize_release_candidates(&value);
    assert_eq!(candidates.len(), 2);
    assert!(candidates
        .iter()
        .all(|candidate| candidate.reference.is_present()));
    match select_release_baseline(&value) {
        BaselineDecision::Selected(baseline) => {
            assert_eq!(baseline.reference.as_str(), "refs/tags/v1.1.0");
            assert_eq!(baseline.commit.as_str(), "b".repeat(40));
            assert_eq!(baseline.version.as_str(), "v1.1.0");
            let dates = match &baseline.release_date_observations {
                Availability::Present(dates) => dates,
                other => panic!("expected release dates, got {other:?}"),
            };
            assert_eq!(dates.len(), 1);
            assert!(baseline.rationale.as_str().contains("2026-02-01T00:00:00Z"));
        }
        other => panic!("expected selected baseline, got {other:?}"),
    }
}

#[test]
fn remote_tag_and_release_refs_are_candidates_but_remote_branches_are_not() {
    let remote_tag = RemoteReferenceObservation::try_new(
        "refs/tags/v3.0.0",
        Availability::Present(id('c')),
        Availability::Present(ExactText::new("2026-03-01T00:00:00Z")),
        Availability::Empty,
    )
    .expect("remote tag");
    let remote_release = RemoteReferenceObservation::try_new(
        "refs/releases/v2.0.0",
        Availability::Present(id('d')),
        Availability::Present(ExactText::new("2026-02-01T00:00:00Z")),
        Availability::Empty,
    )
    .expect("remote release");
    let remote_branch = RemoteReferenceObservation::try_new(
        "refs/heads/main",
        Availability::Present(id('e')),
        Availability::Present(ExactText::new("2026-04-01T00:00:00Z")),
        Availability::Empty,
    )
    .expect("remote branch");
    let remote = RemoteSnapshotCollector::new(
        "remote-snapshot-01",
        vec![remote_branch, remote_release, remote_tag],
    );
    let value = evidence(Vec::new(), Vec::new(), Vec::new()).attach_remote(&remote);
    let candidates = normalize_release_candidates(&value);
    assert_eq!(candidates.len(), 2);
    assert!(candidates
        .iter()
        .all(|candidate| !candidate.candidate_id.as_str().contains("refs/heads/main")));
    match select_release_baseline(&value) {
        BaselineDecision::Selected(baseline) => {
            assert_eq!(baseline.reference.as_str(), "refs/tags/v3.0.0");
            assert_eq!(baseline.version.as_str(), "v3.0.0");
        }
        other => panic!("expected remote tag baseline, got {other:?}"),
    }
}

#[test]
fn readme_only_and_manifest_only_declarations_remain_unresolved() {
    let value = evidence(
        Vec::new(),
        vec![document("README.md", 4, "v0.1.2", "Version: v0.1.2")],
        vec![manifest("Cargo.toml", 3, "0.1.2", "version = \"0.1.2\"")],
    );
    let candidates = normalize_release_candidates(&value);
    assert_eq!(candidates.len(), 2);
    assert!(candidates.iter().all(|candidate| {
        candidate.reference.is_empty()
            && candidate.resolved_commit.is_empty()
            && candidate.version.is_present()
    }));
    match select_release_baseline(&value) {
        BaselineDecision::NoUnambiguous {
            candidate_comparisons,
            blockers,
            reason,
            ..
        } => {
            assert_eq!(reason.as_str(), NO_UNAMBIGUOUS_RELEASE_BASELINE);
            assert!(blockers
                .iter()
                .any(|blocker| blocker.as_str() == NO_UNAMBIGUOUS_RELEASE_BASELINE));
            let readme = candidate_comparisons
                .iter()
                .find(|row| row.candidate_id.as_str().starts_with("document:README.md"))
                .expect("README row");
            assert!(readme
                .blockers
                .iter()
                .any(|blocker| blocker.as_str() == "unresolved reference evidence"));
            assert!(readme
                .candidate
                .source_evidence
                .iter()
                .any(|reference| reference.locator_is_file("README.md", 4)));
        }
        other => panic!("expected no baseline, got {other:?}"),
    }
}

#[test]
fn tag_only_without_date_can_select_one_unique_fully_linked_candidate() {
    let value = evidence(
        vec![local_tag("v4.0.0", 'f', Availability::Empty)],
        Vec::new(),
        Vec::new(),
    );
    match select_release_baseline(&value) {
        BaselineDecision::Selected(baseline) => {
            assert!(baseline.release_date_observations.is_unavailable());
            assert!(baseline
                .gaps
                .iter()
                .any(|gap| gap.reason.as_str() == RELEASE_DATE_EVIDENCE_UNAVAILABLE));
            assert!(baseline
                .rationale
                .as_str()
                .contains(RELEASE_DATE_EVIDENCE_UNAVAILABLE));
        }
        other => panic!("expected unique undated tag baseline, got {other:?}"),
    }
}

#[test]
fn multiple_undated_tied_and_conflicting_candidates_fail_closed() {
    let undated = evidence(
        vec![
            local_tag("v5.0.0", 'a', Availability::Empty),
            local_tag("v6.0.0", 'b', Availability::Empty),
        ],
        Vec::new(),
        Vec::new(),
    );
    assert!(matches!(
        select_release_baseline(&undated),
        BaselineDecision::NoUnambiguous { .. }
    ));

    let tied = evidence(
        vec![
            local_tag(
                "v7.0.0",
                'a',
                Availability::Present(ExactText::new("2026-07-01T00:00:00Z")),
            ),
            local_tag(
                "v8.0.0",
                'b',
                Availability::Present(ExactText::new("2026-07-01T00:00:00Z")),
            ),
        ],
        Vec::new(),
        Vec::new(),
    );
    assert!(matches!(
        select_release_baseline(&tied),
        BaselineDecision::NoUnambiguous { .. }
    ));

    let first = LocalRefObservation::try_new(
        "refs/tags/conflict",
        Availability::Present(id('1')),
        Availability::Present(ExactText::new("2026-09-01T00:00:00Z")),
        Availability::Empty,
    )
    .unwrap();
    let second = LocalRefObservation::try_new(
        "refs/tags/conflict",
        Availability::Present(id('2')),
        Availability::Present(ExactText::new("2026-10-01T00:00:00Z")),
        Availability::Empty,
    )
    .unwrap();
    let conflict = evidence(vec![first, second], Vec::new(), Vec::new());
    match select_release_baseline(&conflict) {
        BaselineDecision::NoUnambiguous { blockers, .. } => {
            assert!(blockers.iter().any(|blocker| {
                blocker
                    .as_str()
                    .contains("conflicting or duplicate exact reference observations")
            }))
        }
        other => panic!("expected conflicting references to fail closed, got {other:?}"),
    }
}

#[test]
fn candidate_order_and_serialized_decision_are_deterministic() {
    let first = evidence(
        vec![
            local_tag(
                "v1.0.0",
                'a',
                Availability::Present(ExactText::new("2026-01-01T00:00:00Z")),
            ),
            local_tag(
                "v2.0.0",
                'b',
                Availability::Present(ExactText::new("2026-02-01T00:00:00Z")),
            ),
        ],
        vec![document("release-notes.md", 2, "v0.9.0", "Release v0.9.0")],
        vec![manifest("Cargo.toml", 3, "0.9.0", "version = \"0.9.0\"")],
    );
    let second = evidence(
        vec![
            local_tag(
                "v2.0.0",
                'b',
                Availability::Present(ExactText::new("2026-02-01T00:00:00Z")),
            ),
            local_tag(
                "v1.0.0",
                'a',
                Availability::Present(ExactText::new("2026-01-01T00:00:00Z")),
            ),
        ],
        vec![document("release-notes.md", 2, "v0.9.0", "Release v0.9.0")],
        vec![manifest("Cargo.toml", 3, "0.9.0", "version = \"0.9.0\"")],
    );
    assert_eq!(
        normalize_release_candidates(&first),
        normalize_release_candidates(&second)
    );
    assert_eq!(
        serialize_deterministically(&select_release_baseline(&first)).unwrap(),
        serialize_deterministically(&select_release_baseline(&second)).unwrap()
    );
}

#[test]
fn local_and_remote_identical_tag_evidence_is_one_corroborated_candidate() {
    let date = "2026-08-30T00:00:00.123+02:00";
    let local = local_tag("v10.0.0", 'a', Availability::Present(ExactText::new(date)));
    let remote_ref = RemoteReferenceObservation::try_new(
        "refs/tags/v10.0.0",
        Availability::Present(id('a')),
        Availability::Present(ExactText::new(date)),
        Availability::Empty,
    )
    .expect("remote tag");
    let remote = RemoteSnapshotCollector::new("remote-snapshot-corroboration", vec![remote_ref]);
    let value = evidence(vec![local], Vec::new(), Vec::new()).attach_remote(&remote);

    let candidates = normalize_release_candidates(&value);
    assert_eq!(candidates.len(), 1);
    let candidate = &candidates[0];
    let reference = match &candidate.reference {
        Availability::Present(reference) => reference,
        other => panic!("expected reference, got {other:?}"),
    };
    let commit = match &candidate.resolved_commit {
        Availability::Present(commit) => commit,
        other => panic!("expected commit, got {other:?}"),
    };
    let version = match &candidate.version {
        Availability::Present(version) => version,
        other => panic!("expected version, got {other:?}"),
    };
    assert_eq!(reference.as_str(), "refs/tags/v10.0.0");
    assert_eq!(commit.as_str(), id('a').as_str());
    assert_eq!(version.as_str(), "v10.0.0");
    assert_eq!(candidate.release_dates.len(), 2);
    assert!(candidate
        .source_evidence
        .iter()
        .any(|evidence| evidence.source.kind
            == release_checkpoint_research::EvidenceSourceKind::LocalGit));
    assert!(candidate
        .source_evidence
        .iter()
        .any(|evidence| evidence.source.kind
            == release_checkpoint_research::EvidenceSourceKind::RemoteSnapshot));
    assert!(candidate
        .source_evidence
        .iter()
        .any(|evidence| evidence.source.kind
            == release_checkpoint_research::EvidenceSourceKind::RemoteReference));

    match select_release_baseline(&value) {
        BaselineDecision::Selected(baseline) => {
            assert_eq!(baseline.candidate_comparisons.len(), 1);
            let baseline_dates = match &baseline.release_date_observations {
                Availability::Present(dates) => dates,
                other => panic!("expected corroborated release dates, got {other:?}"),
            };
            assert_eq!(baseline_dates.len(), 2);
            assert!(baseline.rationale.as_str().contains(date));
        }
        other => panic!("expected corroborated tag baseline, got {other:?}"),
    }
}

#[test]
fn conflicting_local_and_remote_same_ref_fails_closed_with_field_blockers() {
    let local = local_tag(
        "v11.0.0",
        'a',
        Availability::Present(ExactText::new("2026-08-30T00:00:00Z")),
    );
    let remote_ref = RemoteReferenceObservation::try_new(
        "refs/tags/v11.0.0",
        Availability::Present(id('b')),
        Availability::Present(ExactText::new("2026-08-31T00:00:00Z")),
        Availability::Empty,
    )
    .expect("remote tag");
    let remote = RemoteSnapshotCollector::new("remote-snapshot-conflict", vec![remote_ref]);
    let value = evidence(vec![local], Vec::new(), Vec::new()).attach_remote(&remote);

    match select_release_baseline(&value) {
        BaselineDecision::NoUnambiguous {
            candidate_comparisons,
            blockers,
            ..
        } => {
            assert_eq!(candidate_comparisons.len(), 2);
            assert!(blockers
                .iter()
                .any(|blocker| blocker.as_str().contains("conflicting commit evidence")));
            assert!(blockers.iter().any(|blocker| {
                blocker
                    .as_str()
                    .contains("conflicting release-date evidence")
            }));
        }
        other => panic!("expected conflicting same-ref evidence to fail closed, got {other:?}"),
    }
}

#[test]
fn release_dates_are_compared_by_instant_not_lexical_text() {
    let earlier_lexical = local_tag(
        "v12.0.0",
        'a',
        Availability::Present(ExactText::new("2026-08-30T00:00:00+02:00")),
    );
    let later_instant = local_tag(
        "v13.0.0",
        'b',
        Availability::Present(ExactText::new("2026-08-29T23:30:00Z")),
    );
    let value = evidence(vec![earlier_lexical, later_instant], Vec::new(), Vec::new());

    match select_release_baseline(&value) {
        BaselineDecision::Selected(baseline) => {
            assert_eq!(baseline.reference.as_str(), "refs/tags/v13.0.0");
            let dates = match &baseline.release_date_observations {
                Availability::Present(dates) => dates,
                other => panic!("expected selected release date, got {other:?}"),
            };
            assert_eq!(dates[0].date.as_str(), "2026-08-29T23:30:00Z");
            assert!(baseline
                .rationale
                .as_str()
                .contains("validated release instant in date evidence"));
            assert!(baseline.rationale.as_str().contains("2026-08-29T23:30:00Z"));
        }
        other => panic!("expected offset-aware newest baseline, got {other:?}"),
    }
}

#[test]
fn root_readme_version_lines_are_discovered_as_document_evidence() {
    let repo = TempRepo::new("root-readme");
    fs::write(
        repo.path().join("readme.md"),
        b"# Fixture\n\nVersion: v9.9.9\n",
    )
    .expect("write README");
    let collected = collect_local_release_evidence(repo.path()).expect("collect evidence");
    let declarations = match collected.release_documents {
        Availability::Present(declarations) => declarations,
        other => panic!("expected root README declaration, got {other:?}"),
    };
    let declaration = declarations
        .iter()
        .find(|declaration| declaration.path.as_str().eq_ignore_ascii_case("readme.md"))
        .expect("root README declaration");
    assert_eq!(declaration.version.as_str(), "v9.9.9");
    assert_eq!(declaration.span.start, 3);
    assert_eq!(declaration.text.as_str(), "Version: v9.9.9");
}

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
            "release-selector-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create temp repo");
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "selector@example.invalid"]);
        git(&root, &["config", "user.name", "Release Selector"]);
        fs::write(root.join("seed.txt"), b"seed\n").expect("seed");
        git(&root, &["add", "seed.txt"]);
        git(&root, &["commit", "-qm", "seed"]);
        Self { root }
    }

    fn path(&self) -> &Path {
        &self.root
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
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

trait ReferenceLocatorExt {
    fn locator_is_file(&self, path: &str, line: u32) -> bool;
}

impl ReferenceLocatorExt for release_checkpoint_research::EvidenceReference {
    fn locator_is_file(&self, path: &str, line: u32) -> bool {
        match &self.locator {
            release_checkpoint_research::EvidenceReferenceLocator::File(locator) => {
                locator.path.as_str() == path
                    && locator.span.start == line
                    && locator.span.end == line
            }
            _ => false,
        }
    }
}
