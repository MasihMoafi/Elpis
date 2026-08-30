use release_checkpoint_research::{
    collect_local_release_evidence, serialize_deterministically, Availability, EvidenceSourceKind,
    FullId, LocalReleaseEvidenceCollector, RemoteReferenceObservation, RemoteSnapshotCollector,
};
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
            "release-checkpoint-collector-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create temp repository");
        git(&root, &["init", "-q"]);
        git(
            &root,
            &["config", "user.email", "collector@example.invalid"],
        );
        git(&root, &["config", "user.name", "Collector Test"]);
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

fn git_bytes(root: &Path, args: &[&str]) -> Vec<u8> {
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
    output.stdout
}

fn write_bytes(path: &Path, bytes: &[u8]) {
    let mut file = File::create(path).expect("create file");
    file.write_all(bytes).expect("write file");
}

#[test]
fn local_collector_preserves_refs_categories_exact_text_and_spans() {
    let repo = TempRepo::new("complete");
    write_bytes(
        &repo.path().join("CHANGELOG.md"),
        b"# Release v1.2.3\n\n## [1.1.0] - prior\n",
    );
    write_bytes(
        &repo.path().join("Cargo.toml"),
        b"[package]\nname = \"fixture\"\nversion = \"1.2.3\"  # exact\n",
    );
    write_bytes(&repo.path().join("tracked file.txt"), b"before\n");
    write_bytes(&repo.path().join(".gitignore"), b"ignored *.log\n");
    git(
        &repo.root,
        &[
            "add",
            "CHANGELOG.md",
            "Cargo.toml",
            "tracked file.txt",
            ".gitignore",
        ],
    );
    git(&repo.root, &["commit", "-qm", "initial release"]);
    git(&repo.root, &["tag", "v1.2.3"]);
    git(
        &repo.root,
        &["tag", "-a", "v1.2.4", "-m", "annotated release"],
    );

    write_bytes(&repo.path().join("tracked file.txt"), b"after\n");
    let staged_name = "staged unusual\nname.txt";
    write_bytes(&repo.path().join(staged_name), b"staged\n");
    let staged_path = repo.path().join(staged_name);
    git(&repo.root, &["add", staged_name]);
    let untracked_name = "untracked [unusual] name.txt";
    write_bytes(&repo.path().join(untracked_name), b"untracked\n");
    write_bytes(&repo.path().join("ignored [x].log"), b"ignored\n");

    let before = git_bytes(&repo.root, &["status", "--porcelain=v1", "-z", "--ignored"]);
    let collector = LocalReleaseEvidenceCollector::new(repo.path()).expect("collector root");
    let evidence = collector.collect().expect("collect local evidence");

    let refs = match &evidence.refs {
        Availability::Present(refs) => refs,
        other => panic!("expected refs, got {other:?}; gaps: {:?}", evidence.gaps),
    };
    let head = refs
        .iter()
        .find(|item| {
            item.full_ref.as_str() == "refs/heads/master"
                || item.full_ref.as_str() == "refs/heads/main"
        })
        .expect("local branch ref");
    assert!(head.resolved_commit.is_present());
    assert!(head.date.is_present());
    assert_eq!(
        head.subject,
        Availability::Present("initial release".into())
    );
    assert!(refs
        .iter()
        .any(|item| item.full_ref.as_str() == "refs/tags/v1.2.3"));
    assert!(refs
        .iter()
        .any(|item| item.full_ref.as_str() == "refs/tags/v1.2.4"));
    assert!(refs.iter().all(|item| {
        item.resolved_commit.as_ref().is_present()
            && item
                .resolved_commit
                .as_ref()
                .present_ref()
                .is_some_and(|id| id.as_str().len() == 40)
    }));

    let staged = match &evidence.worktree.staged {
        Availability::Present(entries) => entries,
        other => panic!("expected staged paths, got {other:?}"),
    };
    assert!(staged
        .iter()
        .any(|entry| entry.path.as_str() == staged_name));
    let unstaged = match &evidence.worktree.unstaged {
        Availability::Present(entries) => entries,
        other => panic!("expected unstaged paths, got {other:?}"),
    };
    assert!(unstaged
        .iter()
        .any(|entry| entry.path.as_str() == "tracked file.txt"));
    let untracked = match &evidence.worktree.untracked {
        Availability::Present(entries) => entries,
        other => panic!("expected untracked paths, got {other:?}"),
    };
    assert!(untracked
        .iter()
        .any(|entry| entry.path.as_str() == untracked_name));
    let ignored = match &evidence.worktree.ignored {
        Availability::Present(entries) => entries,
        other => panic!("expected ignored paths, got {other:?}"),
    };
    assert!(ignored
        .iter()
        .any(|entry| entry.path.as_str() == "ignored [x].log"));

    let documents = match &evidence.release_documents {
        Availability::Present(documents) => documents,
        other => panic!("expected release declarations, got {other:?}"),
    };
    let release = documents
        .iter()
        .find(|declaration| declaration.version.as_str() == "v1.2.3")
        .expect("release declaration");
    assert_eq!(release.path.as_str(), "CHANGELOG.md");
    assert_eq!(release.span.start, 1);
    assert_eq!(release.span.end, 1);
    assert_eq!(release.text.as_str(), "# Release v1.2.3");
    assert_eq!(
        release.reference.source.kind,
        EvidenceSourceKind::ReleaseDocument
    );

    let manifests = match &evidence.package_manifests {
        Availability::Present(manifests) => manifests,
        other => panic!("expected manifest declarations, got {other:?}"),
    };
    let manifest = manifests
        .iter()
        .find(|declaration| declaration.path.as_str() == "Cargo.toml")
        .expect("manifest declaration");
    assert_eq!(manifest.version.as_str(), "1.2.3");
    assert_eq!(manifest.span.start, 3);
    assert_eq!(manifest.text.as_str(), "version = \"1.2.3\"  # exact");
    assert_eq!(
        manifest.reference.source.kind,
        EvidenceSourceKind::PackageManifest
    );

    assert_eq!(
        before,
        git_bytes(&repo.root, &["status", "--porcelain=v1", "-z", "--ignored"])
    );
    assert!(!repo.path().join(".kiro").exists());
    assert!(serialize_deterministically(&evidence).is_ok());
    assert!(staged_path.exists());
}

#[test]
fn remote_injection_is_explicit_and_empty_is_not_unavailable() {
    let repo = TempRepo::new("remote");
    write_bytes(&repo.path().join("README.md"), b"readme\n");
    git(&repo.root, &["add", "README.md"]);
    git(&repo.root, &["commit", "-qm", "initial"]);

    let remote_commit = FullId::new("a".repeat(40)).expect("remote full ID");
    let remote_reference = RemoteReferenceObservation::try_new(
        "refs/heads/remote-main",
        Availability::Present(remote_commit),
        Availability::Present("2026-08-30T00:00:00Z".into()),
        Availability::Present("remote subject".into()),
    )
    .expect("remote observation");
    let remote = RemoteSnapshotCollector::new("injected snapshot exact\n", vec![remote_reference]);
    let evidence = collect_local_release_evidence(repo.path())
        .expect("local evidence")
        .attach_remote(&remote);
    let remote_snapshot = match evidence.remote {
        Availability::Present(snapshot) => snapshot,
        other => panic!("expected injected remote snapshot, got {other:?}"),
    };
    assert_eq!(
        remote_snapshot.snapshot.as_str(),
        "injected snapshot exact\n"
    );
    assert!(matches!(
        remote_snapshot.references,
        Availability::Present(_)
    ));

    let empty = collect_local_release_evidence(repo.path()).expect("local evidence");
    assert!(empty.release_documents.is_empty());
    assert!(empty.package_manifests.is_empty());
    assert!(empty.remote.is_empty());
    assert_ne!(empty.remote, Availability::Unavailable);
}

#[cfg(unix)]
#[test]
fn inaccessible_release_document_is_unavailable_and_named() {
    use std::os::unix::fs::PermissionsExt;

    let repo = TempRepo::new("inaccessible-document");
    let document = repo.path().join("CHANGELOG.md");
    write_bytes(&document, b"# Release v9.9.9\n");
    fs::set_permissions(&document, fs::Permissions::from_mode(0o000)).expect("deny document");
    let evidence = collect_local_release_evidence(repo.path()).expect("local evidence");
    fs::set_permissions(&document, fs::Permissions::from_mode(0o600)).expect("restore document");

    assert!(evidence.release_documents.is_unavailable());
    assert!(evidence.gaps.iter().any(|gap| {
        gap.source.kind == EvidenceSourceKind::ReleaseDocument
            && gap.source.name.as_str() == "CHANGELOG.md"
            && gap.reason.as_str().contains("read release document")
    }));
}

#[test]
fn malformed_manifest_is_unavailable_and_named_without_fabrication() {
    let repo = TempRepo::new("malformed");
    write_bytes(
        &repo.path().join("Cargo.toml"),
        b"[package]\nname = \"fixture\"\nversion =\n",
    );
    let evidence = collect_local_release_evidence(repo.path()).expect("local evidence");
    assert!(evidence.package_manifests.is_unavailable());
    assert!(evidence.gaps.iter().any(|gap| {
        gap.source.kind == EvidenceSourceKind::PackageManifest
            && gap.source.name.as_str() == "Cargo.toml"
            && gap.reason.as_str().contains("no value")
    }));
    assert!(!evidence.package_manifests.as_ref().is_present());
}

trait AvailabilityExt<T> {
    fn present_ref(&self) -> Option<&T>;
}

impl<T> AvailabilityExt<T> for Availability<T> {
    fn present_ref(&self) -> Option<&T> {
        match self {
            Availability::Present(value) => Some(value),
            Availability::Empty | Availability::Unavailable => None,
        }
    }
}
