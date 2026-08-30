use release_checkpoint_research::{
    is_visualization_path, AuditBoundary, AuditSession, Availability, CompletionStatus,
    FilesystemEntryType, PathDisposition, RepoRelativePath, ReportOutput,
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
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "release-checkpoint-research-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q"]);
        git(
            &root,
            &["config", "user.email", "foundation@example.invalid"],
        );
        git(&root, &["config", "user.name", "Foundation Test"]);
        write_file(&root.join("README.md"), b"initial\n");
        git(&root, &["add", "README.md"]);
        git(&root, &["commit", "-qm", "initial"]);
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
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn write_file(path: &Path, bytes: &[u8]) {
    let mut file = File::create(path).unwrap();
    file.write_all(bytes).unwrap();
}

#[test]
fn snapshot_precedes_any_output_and_publication_is_allowed_after_zero_changes() {
    let repo = TempRepo::new("snapshot");
    let boundary = AuditBoundary::new(repo.path()).unwrap();
    assert!(!boundary.is_snapshot_complete());
    assert!(boundary
        .open_report(ReportOutput::ResearchReportJson)
        .is_err());
    assert!(!repo.path().join(".kiro").exists());

    let session = AuditSession::start(repo.path()).unwrap();
    assert!(session.boundary().is_snapshot_complete());
    assert!(session
        .snapshot()
        .identity
        .repository_root
        .as_path()
        .is_absolute());
    assert!(matches!(
        session.snapshot().protected_artifact.metadata,
        Availability::Empty
    ));
    let readme = RepoRelativePath::new("README.md").unwrap();
    let readme_snapshot = session.snapshot().filesystem.entry(&readme).unwrap();
    assert_eq!(readme_snapshot.entry_type, FilesystemEntryType::RegularFile);
    assert!(readme_snapshot.content_fingerprint.is_present());
    assert!(!repo.path().join(".kiro").exists());

    let published = session
        .publish_report(ReportOutput::ResearchReportJson, br"{}")
        .unwrap();
    assert_eq!(published.output, ReportOutput::ResearchReportJson);
    assert_eq!(
        published.path.as_path(),
        repo.path()
            .join(".kiro/specs/release-checkpoint-research/research-report.json")
            .as_path()
    );
    assert_eq!(fs::read(published.path.as_path()).unwrap(), b"{}");
}

#[test]
fn independent_worktree_inventories_keep_their_roots_and_files_separate() {
    let first = TempRepo::new("inventory-a");
    let second = TempRepo::new("inventory-b");
    write_file(&second.path().join("other.txt"), b"other\n");
    let first_inventory =
        release_checkpoint_research::capture_worktree_inventory(first.path()).unwrap();
    let second_inventory =
        release_checkpoint_research::capture_worktree_inventory(second.path()).unwrap();
    assert_ne!(
        first_inventory.identity.repository_root,
        second_inventory.identity.repository_root
    );
    assert!(first_inventory
        .tracked
        .iter()
        .all(|path| path.as_str() != "other.txt"));
    assert!(second_inventory
        .entries
        .iter()
        .any(|entry| entry.path.as_str() == "other.txt"));
}

#[test]
fn completion_detects_outside_file_content_addition_and_deletion() {
    let repo = TempRepo::new("content");
    write_file(&repo.path().join("outside.txt"), b"before\n");
    let session = AuditSession::start(repo.path()).unwrap();
    write_file(&repo.path().join("outside.txt"), b"after\n");
    let comparison = session.compare_completion();
    assert_eq!(comparison.status, CompletionStatus::Failed);
    assert!(comparison.current_filesystem_fingerprint.is_present());
    assert!(comparison
        .failure_reason
        .present_reason()
        .unwrap()
        .contains("filesystem"));

    let added = TempRepo::new("addition");
    let added_session = AuditSession::start(added.path()).unwrap();
    write_file(&added.path().join("added.txt"), b"added\n");
    assert_eq!(
        added_session.compare_completion().status,
        CompletionStatus::Failed
    );

    let deleted = TempRepo::new("deletion");
    write_file(&deleted.path().join("deleted.txt"), b"deleted\n");
    let deleted_session = AuditSession::start(deleted.path()).unwrap();
    fs::remove_file(deleted.path().join("deleted.txt")).unwrap();
    assert_eq!(
        deleted_session.compare_completion().status,
        CompletionStatus::Failed
    );
}

#[test]
fn completion_detects_outside_type_and_symlink_target_changes() {
    let repo = TempRepo::new("type");
    write_file(&repo.path().join("shape"), b"file\n");
    let session = AuditSession::start(repo.path()).unwrap();
    fs::remove_file(repo.path().join("shape")).unwrap();
    fs::create_dir(repo.path().join("shape")).unwrap();
    assert_eq!(
        session.compare_completion().status,
        CompletionStatus::Failed
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let links = TempRepo::new("symlink");
        write_file(&links.path().join("one"), b"one\n");
        write_file(&links.path().join("two"), b"two\n");
        symlink("one", links.path().join("link")).unwrap();
        let link_session = AuditSession::start(links.path()).unwrap();
        fs::remove_file(links.path().join("link")).unwrap();
        symlink("two", links.path().join("link")).unwrap();
        assert_eq!(
            link_session.compare_completion().status,
            CompletionStatus::Failed
        );
    }
}

#[cfg(unix)]
#[test]
fn completion_detects_outside_permission_changes_and_unreadable_entries() {
    use std::os::unix::fs::PermissionsExt;

    let repo = TempRepo::new("permissions");
    write_file(&repo.path().join("mode.txt"), b"mode\n");
    let session = AuditSession::start(repo.path()).unwrap();
    fs::set_permissions(
        repo.path().join("mode.txt"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert_eq!(
        session.compare_completion().status,
        CompletionStatus::Failed
    );

    let unreadable = TempRepo::new("unreadable");
    fs::create_dir(unreadable.path().join("blocked")).unwrap();
    write_file(&unreadable.path().join("blocked/entry.txt"), b"blocked\n");
    let unreadable_session = AuditSession::start(unreadable.path()).unwrap();
    fs::set_permissions(
        unreadable.path().join("blocked"),
        fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    let comparison = unreadable_session.compare_completion();
    fs::set_permissions(
        unreadable.path().join("blocked"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert_eq!(comparison.status, CompletionStatus::Failed);
    assert!(comparison.current_filesystem_fingerprint.is_unavailable());
}

#[test]
fn artifact_subtree_changes_are_excluded_but_output_names_remain_exact() {
    let repo = TempRepo::new("artifact");
    let artifact = repo.path().join(".kiro/specs/release-checkpoint-research");
    fs::create_dir_all(&artifact).unwrap();
    write_file(&artifact.join("ordinary.html"), b"before\n");
    let session = AuditSession::start(repo.path()).unwrap();
    write_file(&artifact.join("ordinary.html"), b"after\n");
    assert_eq!(
        session.compare_completion().status,
        CompletionStatus::VerifiedNoChanges
    );
    assert!(!is_visualization_path("ordinary.html"));
    assert!(!is_visualization_path("ordinary.svg"));
    assert!(!is_visualization_path("ordinary.png"));
    assert!(!is_visualization_path("ordinary.webp"));
    assert!(!is_visualization_path("ordinary.md"));
}

#[test]
fn completion_failure_is_not_a_successful_publication() {
    let repo = TempRepo::new("integrity");
    let session = AuditSession::start(repo.path()).unwrap();
    write_file(
        &repo.path().join("changed-after-snapshot.txt"),
        b"changed\n",
    );
    let comparison = session.compare_completion();
    assert_eq!(comparison.status, CompletionStatus::Failed);
    assert!(session
        .publish_report(ReportOutput::ResearchReportJson, br"should not publish")
        .is_err());
    assert!(!repo
        .path()
        .join(".kiro/specs/release-checkpoint-research/research-report.json")
        .exists());
}

#[cfg(unix)]
#[test]
fn symlink_and_hardlink_outputs_are_rejected() {
    use std::os::unix::fs::{symlink, MetadataExt};

    let repo = TempRepo::new("links");
    let session = AuditSession::start(repo.path()).unwrap();
    let artifact = repo.path().join(".kiro/specs/release-checkpoint-research");
    fs::create_dir_all(&artifact).unwrap();

    let symlink_target = repo.path().join("outside-output.txt");
    write_file(&symlink_target, b"must survive\n");
    symlink(&symlink_target, artifact.join("research-report.json")).unwrap();
    assert!(session
        .open_report(ReportOutput::ResearchReportJson)
        .is_err());
    assert_eq!(fs::read(&symlink_target).unwrap(), b"must survive\n");
    fs::remove_file(artifact.join("research-report.json")).unwrap();

    let hardlink_target = repo.path().join("outside-hardlink.txt");
    write_file(&hardlink_target, b"must also survive\n");
    fs::hard_link(&hardlink_target, artifact.join("research-report.md")).unwrap();
    assert!(session
        .open_report(ReportOutput::ResearchReportMarkdown)
        .is_err());
    assert_eq!(fs::metadata(&hardlink_target).unwrap().nlink(), 2);
    assert_eq!(fs::read(&hardlink_target).unwrap(), b"must also survive\n");
}

#[test]
fn input_boundary_and_visualization_exclusion_are_explicit() {
    let repo = TempRepo::new("paths");
    let boundary = AuditSession::start(repo.path()).unwrap();
    let safe = RepoRelativePath::new("README.md").unwrap();
    assert!(boundary.boundary().resolve_input(&safe).unwrap().is_file());
    assert_eq!(
        boundary.boundary().path_disposition(
            &RepoRelativePath::new(".kiro/specs/release-checkpoint-research/research-report.json",)
                .unwrap()
        ),
        PathDisposition::ProtectedArtifact
    );
    assert_eq!(
        boundary.boundary().path_disposition(
            &RepoRelativePath::new("evidence:masihmoafi.com_projects_elpis").unwrap()
        ),
        PathDisposition::Visualization
    );
    assert_eq!(
        boundary
            .boundary()
            .path_disposition(&RepoRelativePath::new("reports/page.html").unwrap()),
        PathDisposition::Candidate
    );
}

trait AvailabilityTextExt {
    fn present_reason(&self) -> Option<&str>;
}

impl AvailabilityTextExt for Availability<release_checkpoint_research::ExactText> {
    fn present_reason(&self) -> Option<&str> {
        match self {
            Availability::Present(value) => Some(value.as_str()),
            _ => None,
        }
    }
}
