use release_checkpoint_research::{
    build_artifact_inventory_from_snapshot, build_existing_ignore_proposals_with_categories,
    build_removal_register, build_untracking_follow_ups, capture_start_snapshot,
    capture_worktree_inventory, collect_artifact_inventory, collect_local_release_evidence,
    read_ignore_file, serialize_deterministically, ArtifactCategory, ArtifactInventoryInput,
    ArtifactStatus, Availability, ConsumerResult, ExactText, FullId, PrimaryClassification,
    ProducerDiscovery, RemoteArtifactSnapshot, RepoRelativePath, RetentionDecision,
    RetentionRecommendation,
};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Write;
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
            "release-checkpoint-artifacts-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create fixture repository");
        let repository = Self { root };
        repository.git(&["init", "-q"]);
        repository.git(&["config", "user.email", "artifacts@example.invalid"]);
        repository.git(&["config", "user.name", "Artifact Tests"]);
        repository.write("README.md", "# Fixture\n");
        repository.git(&["add", "."]);
        repository.git(&["commit", "-qm", "initial"]);
        repository
    }

    fn path(&self) -> &Path {
        &self.root
    }

    fn write(&self, relative: &str, contents: impl AsRef<[u8]>) {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create fixture parent");
        }
        let mut file = File::create(path).expect("create fixture file");
        file.write_all(contents.as_ref())
            .expect("write fixture file");
    }

    fn git(&self, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .output()
            .expect("run fixture git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn path(value: &str) -> RepoRelativePath {
    RepoRelativePath::new(value).expect("valid fixture path")
}

#[test]
fn artifact_inventory_is_path_unique_and_keeps_all_independent_statuses() {
    let tracked = path("tracked.txt");
    let filesystem_only = path("filesystem-only.txt");
    let ignored = path("ignored.txt");
    let input = ArtifactInventoryInput::new(
        FullId::new("a".repeat(40)).unwrap(),
        release_checkpoint_research::UtcSeconds::now().unwrap(),
        Availability::Present(BTreeSet::from([tracked.clone(), ignored.clone()])),
        Availability::Present(BTreeSet::from([tracked.clone(), filesystem_only.clone()])),
    )
    .with_untracked_paths(Availability::Present(BTreeSet::from([
        filesystem_only.clone()
    ])))
    .with_ignored_paths(Availability::Present(BTreeSet::from([ignored.clone()])));
    let inventory = release_checkpoint_research::build_artifact_inventory(input).unwrap();
    assert_eq!(inventory.len(), 3);
    assert_eq!(inventory.candidates[&tracked].tracked, ArtifactStatus::Yes);
    assert_eq!(inventory.candidates[&tracked].untracked, ArtifactStatus::No);
    assert_eq!(inventory.candidates[&tracked].ignored, ArtifactStatus::No);
    assert_eq!(
        inventory.candidates[&tracked].filesystem,
        ArtifactStatus::Yes
    );
    assert_eq!(
        inventory.candidates[&filesystem_only].tracked,
        ArtifactStatus::No
    );
    assert_eq!(
        inventory.candidates[&filesystem_only].untracked,
        ArtifactStatus::Yes
    );
    assert_eq!(inventory.candidates[&ignored].tracked, ArtifactStatus::Yes);
    assert_eq!(inventory.candidates[&ignored].ignored, ArtifactStatus::Yes);
    assert_eq!(
        inventory.candidates.keys().cloned().collect::<Vec<_>>(),
        vec![filesystem_only, ignored, tracked]
    );
    assert!(serialize_deterministically(&inventory).is_ok());
}

#[test]
fn root_collection_classifies_and_discovers_consumers_and_producers_without_running_them() {
    let repository = TempRepo::new("discovery");
    repository.write(".gitignore", "cache/\n.env.local\n");
    repository.write("src/main.rs", "fn main() {}\n");
    repository.write(
        "docs/USAGE.md",
        "The generated output is dist/generated.js and the page is assets/page.html.\n",
    );
    repository.write(
        ".github/workflows/build.yml",
        "      run: cargo run --bin generate > dist/generated.js\n",
    );
    repository.write("dist/generated.js", "// generated output\n");
    repository.write("assets/page.html", "<html><body>fixture</body></html>\n");
    repository.write("archives/release.zip", b"not a real archive\n");
    repository.write("target/debug/app", "build output\n");
    repository.write("cache/value", "cached\n");
    repository.write("reports/summary.json", "{\"result\": true}\n");
    repository.write(".env.local", "LOCAL_ONLY=1\n");
    repository.write("obsolete/old.txt", "obsolete\n");
    repository.write(
        ".kiro/specs/release-checkpoint-research/old-output.json",
        "protected\n",
    );
    repository.git(&[
        "add",
        ".gitignore",
        "src",
        "docs",
        ".github",
        "dist",
        "assets",
        "archives",
        "target",
        "reports",
        "obsolete",
    ]);
    repository.git(&["commit", "-qm", "fixture artifacts"]);
    repository.write("cache/value", "cached\n");
    repository.write(".env.local", "LOCAL_ONLY=1\n");

    let inventory =
        collect_artifact_inventory(repository.path()).expect("collect artifact inventory");
    let generated = &inventory.candidates[&path("dist/generated.js")];
    assert_eq!(
        generated.classification,
        PrimaryClassification::GeneratedArtifact
    );
    assert!(generated
        .consumers
        .iter()
        .any(|consumer| matches!(consumer, ConsumerResult::Named { name, evidence, .. } if name.as_str() == "docs/USAGE.md" && !evidence.is_empty())));
    assert!(generated
        .consumers
        .iter()
        .any(|consumer| matches!(consumer, ConsumerResult::Named { name, evidence, .. } if name.as_str() == ".github/workflows/build.yml" && !evidence.is_empty())));
    assert!(
        matches!(generated.producers, ProducerDiscovery::Named { ref producers } if producers.iter().any(|producer| producer.name.as_str().contains("cargo run")))
    );
    assert!(generated.protected_from_removal());
    assert_eq!(
        inventory.candidates[&path("assets/page.html")].classification,
        PrimaryClassification::HtmlArtifact
    );
    assert_eq!(
        inventory.candidates[&path("archives/release.zip")].classification,
        PrimaryClassification::ArchiveArtifact
    );
    assert_eq!(
        inventory.candidates[&path("target/debug/app")].classification,
        PrimaryClassification::BuildOutput
    );
    assert_eq!(
        inventory.candidates[&path("cache/value")].classification,
        PrimaryClassification::Cache
    );
    assert_eq!(
        inventory.candidates[&path("reports/summary.json")].classification,
        PrimaryClassification::Report
    );
    assert_eq!(
        inventory.candidates[&path(".env.local")].classification,
        PrimaryClassification::LocalOnlyFile
    );
    assert_eq!(
        inventory.candidates[&path("obsolete/old.txt")].classification,
        PrimaryClassification::ObsoleteFile
    );
    assert_eq!(
        inventory.candidates[&path(".env.local")].ignored,
        ArtifactStatus::Yes
    );
    assert!(!inventory.candidates.keys().any(|candidate| candidate
        .as_str()
        .starts_with(".kiro/specs/release-checkpoint-research/")));
}

#[test]
fn start_snapshot_excludes_protected_and_post_start_outputs() {
    let repository = TempRepo::new("snapshot");
    repository.write("tracked.txt", "tracked\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-qm", "tracked fixture"]);
    repository.write(
        ".kiro/specs/release-checkpoint-research/before.json",
        "protected\n",
    );
    let snapshot = capture_start_snapshot(repository.path()).unwrap();
    repository.write("post-start.json", "must not enter the audit\n");
    let worktree = capture_worktree_inventory(repository.path()).unwrap();
    let evidence = collect_local_release_evidence(repository.path()).unwrap();
    let ignored = match &evidence.worktree.ignored {
        Availability::Empty => Availability::Empty,
        Availability::Unavailable => Availability::Unavailable,
        Availability::Present(entries) => {
            Availability::Present(entries.iter().map(|entry| entry.path.clone()).collect())
        }
    };
    let input = ArtifactInventoryInput::from_snapshot_and_worktree(&snapshot, &worktree, ignored);
    let inventory =
        build_artifact_inventory_from_snapshot(repository.path(), &snapshot, input).unwrap();
    assert!(inventory.candidates.contains_key(&path("tracked.txt")));
    assert!(!inventory.candidates.contains_key(&path("post-start.json")));
    assert!(!inventory.candidates.keys().any(|candidate| {
        candidate.as_str() == release_checkpoint_research::ARTIFACT_DIRECTORY
            || candidate.as_str().starts_with(&format!(
                "{}/",
                release_checkpoint_research::ARTIFACT_DIRECTORY
            ))
    }));
    assert_eq!(inventory.audited_revision, snapshot.identity.head);
    assert_eq!(inventory.audited_at_utc, snapshot.captured_at_utc);
}

#[test]
fn unavailable_sources_and_remote_injection_fail_closed() {
    let local_path = path("known.txt");
    let input = ArtifactInventoryInput::new(
        FullId::new("b".repeat(40)).unwrap(),
        release_checkpoint_research::UtcSeconds::now().unwrap(),
        Availability::Unavailable,
        Availability::Present(BTreeSet::from([local_path.clone()])),
    )
    .with_remote(Availability::Present(RemoteArtifactSnapshot::unavailable()));
    let inventory = release_checkpoint_research::build_artifact_inventory(input).unwrap();
    let candidate = &inventory.candidates[&local_path];
    assert_eq!(candidate.tracked, ArtifactStatus::Unverified);
    assert_eq!(candidate.filesystem, ArtifactStatus::Yes);
    assert_eq!(candidate.absent, ArtifactStatus::No);
    assert_eq!(candidate.remote, ArtifactStatus::Unverified);

    let remote_path = path("remote-only.txt");
    let remote = RemoteArtifactSnapshot::present(
        FullId::new("c".repeat(40)).unwrap(),
        [remote_path.clone()],
    )
    .unwrap();
    let input = ArtifactInventoryInput::new(
        FullId::new("d".repeat(40)).unwrap(),
        release_checkpoint_research::UtcSeconds::now().unwrap(),
        Availability::Present(BTreeSet::from([remote_path.clone()])),
        Availability::Present(BTreeSet::new()),
    )
    .with_remote(Availability::Present(remote));
    let inventory = release_checkpoint_research::build_artifact_inventory(input).unwrap();
    assert_eq!(
        inventory.candidates[&remote_path].remote,
        ArtifactStatus::Yes
    );
}

#[cfg(unix)]
#[test]
fn symlink_is_not_followed_and_hardlink_is_read_only() {
    use std::os::unix::fs::symlink;

    let repository = TempRepo::new("links");
    let outside = std::env::temp_dir().join(format!(
        "release-checkpoint-artifacts-outside-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::write(&outside, b"outside secret\n").unwrap();
    symlink(&outside, repository.path().join("outside-link.txt")).unwrap();
    fs::hard_link(&outside, repository.path().join("inside-hardlink.txt")).unwrap();
    let snapshot = capture_start_snapshot(repository.path()).unwrap();
    let worktree = capture_worktree_inventory(repository.path()).unwrap();
    let input = ArtifactInventoryInput::from_snapshot_and_worktree(
        &snapshot,
        &worktree,
        Availability::Empty,
    );
    let inventory =
        build_artifact_inventory_from_snapshot(repository.path(), &snapshot, input).unwrap();
    assert!(inventory.candidates.contains_key(&path("outside-link.txt")));
    assert!(inventory
        .candidates
        .contains_key(&path("inside-hardlink.txt")));
    assert!(inventory.candidates[&path("outside-link.txt")]
        .consumers
        .iter()
        .all(ConsumerResult::is_no_consumer));
    assert_eq!(fs::read(&outside).unwrap(), b"outside secret\n");
    assert!(inventory.candidates[&path("inside-hardlink.txt")]
        .clone()
        .with_retention(RetentionDecision::Keep)
        .is_ok());
    let _ = fs::remove_file(outside);
}

#[test]
fn read_only_ignore_provenance_and_tracked_follow_up_are_separate_from_retention() {
    let repository = TempRepo::new("ignore-policy");
    repository.write(".gitignore", "# generated cache\ncache/\n*.tmp\n");
    repository.write("cache/tracked.bin", "tracked cache\n");
    repository.write("notes.tmp", "temporary\n");
    let before = fs::read(repository.path().join(".gitignore")).unwrap();

    let snapshot = read_ignore_file(repository.path()).unwrap();
    let entries = match snapshot.entries() {
        Availability::Present(entries) => entries,
        other => panic!("expected active ignore entries, got {other:?}"),
    };
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].pattern, ExactText::new("cache/"));
    assert_eq!(entries[1].pattern, ExactText::new("*.tmp"));

    let mut categories = std::collections::BTreeMap::new();
    categories.insert(ExactText::new("cache/"), ArtifactCategory::Cache);
    categories.insert(ExactText::new("*.tmp"), ArtifactCategory::LocalOnlyFile);
    let filesystem_paths = Availability::Present(BTreeSet::from([
        path("cache/tracked.bin"),
        path("notes.tmp"),
    ]));
    let proposals =
        build_existing_ignore_proposals_with_categories(&snapshot, &categories, &filesystem_paths)
            .unwrap();
    let proposals = match proposals {
        Availability::Present(proposals) => proposals,
        other => panic!("expected proposals, got {other:?}"),
    };
    assert_eq!(proposals.len(), 2);
    assert!(proposals.iter().all(|proposal| proposal.is_existing()));
    assert_eq!(proposals[0].match_count, 1);
    assert_eq!(proposals[1].match_count, 1);
    assert!(proposals
        .iter()
        .all(|proposal| !proposal.evidence.is_empty()));

    let tracked = path("cache/tracked.bin");
    let input = ArtifactInventoryInput::new(
        FullId::new("a".repeat(40)).unwrap(),
        release_checkpoint_research::UtcSeconds::now().unwrap(),
        Availability::Present(BTreeSet::from([tracked.clone()])),
        Availability::Present(BTreeSet::from([tracked.clone()])),
    );
    let inventory = release_checkpoint_research::build_artifact_inventory(input).unwrap();
    let follow_ups =
        build_untracking_follow_ups(&inventory.candidates, &snapshot, &filesystem_paths);
    let follow_ups = match follow_ups {
        Availability::Present(follow_ups) => follow_ups,
        other => panic!("expected follow-up map, got {other:?}"),
    };
    assert!(follow_ups.contains_key(&tracked));
    assert_eq!(
        inventory.candidates[&tracked].retention_recommendation(),
        RetentionRecommendation::Retain
    );
    assert!(build_removal_register(&inventory).unwrap().is_empty());
    assert_eq!(
        fs::read(repository.path().join(".gitignore")).unwrap(),
        before
    );
}
