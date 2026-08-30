// Feature: release-checkpoint-research, Property 9: Commit and path delta fidelity
// PROPERTY_TAG: P09_COMMIT_PATH_DELTA
use release_checkpoint_research::{
    ChangedPath, ChangedPathStatus, CommitRecord, EvidenceLocator, FullId, InclusiveSpan,
    RepoRelativePath,
};

#[test]
fn p09_locator_preserves_path_and_inclusive_span() {
    let path = RepoRelativePath::new("src/lib.rs").unwrap();
    let span = InclusiveSpan::new(7, 9).unwrap();
    let locator = EvidenceLocator::new(path.clone(), span);
    assert_eq!(locator.path, path);
    assert_eq!(locator.span.start, 7);
    assert_eq!(locator.span.end, 9);
}

#[test]
fn p09_commit_and_path_delta_fidelity_covers_128_cases() {
    for case in 0..128_u32 {
        let id = FullId::new(format!("{case:040x}")).expect("commit full ID");
        let date = format!("2026-08-{:02}T12:34:56+05:30", (case % 28) + 1);
        let subject = format!("exact subject {case} with spaces");
        let commit = CommitRecord::new(id.clone(), date.clone(), subject.clone());
        assert_eq!(commit.commit, id);
        assert_eq!(commit.committer_date.as_str(), date);
        assert_eq!(commit.subject.as_str(), subject);

        let added_path = RepoRelativePath::new(format!("src/add-{case}.rs")).unwrap();
        let modified_path = RepoRelativePath::new(format!("src/modify-{case}.rs")).unwrap();
        let deleted_path = RepoRelativePath::new(format!("src/delete-{case}.rs")).unwrap();
        let old_path = RepoRelativePath::new(format!("src/old-{case}.rs")).unwrap();
        let new_path = RepoRelativePath::new(format!("src/new-{case}.rs")).unwrap();

        let added = ChangedPath::added(added_path.clone());
        assert_eq!(added.status, ChangedPathStatus::Added);
        assert_eq!(added.path, added_path);
        assert!(added.old_path.is_empty());
        assert!(added.new_path.is_present());

        let modified = ChangedPath::modified(modified_path.clone());
        assert_eq!(modified.status, ChangedPathStatus::Modified);
        assert_eq!(modified.path, modified_path);
        assert!(modified.old_path.is_present());
        assert!(modified.new_path.is_present());

        let deleted = ChangedPath::deleted(deleted_path.clone());
        assert_eq!(deleted.status, ChangedPathStatus::Deleted);
        assert_eq!(deleted.path, deleted_path);
        assert!(deleted.old_path.is_present());
        assert!(deleted.new_path.is_empty());

        let renamed = ChangedPath::renamed(old_path.clone(), new_path.clone());
        assert_eq!(renamed.status, ChangedPathStatus::Renamed);
        assert!(renamed.is_renamed());
        assert_eq!(renamed.path, new_path);
        assert_eq!(renamed.old_path.present_ref(), Some(&old_path));
        assert_eq!(renamed.new_path.present_ref(), Some(&new_path));

        // Negative coverage: unsafe, absolute, escaped, and abbreviated path/
        // or ID spellings cannot enter a committed delta record.
        assert!(RepoRelativePath::new(format!("../escape-{case}")).is_err());
        assert!(RepoRelativePath::new(format!("/absolute-{case}")).is_err());
        assert!(RepoRelativePath::new(format!("src\\bad-{case}.rs")).is_err());
        assert!(FullId::new(format!("{case:x}")).is_err());
    }
}

trait AvailabilityPresentExt<T> {
    fn present_ref(&self) -> Option<&T>;
}

impl<T> AvailabilityPresentExt<T> for release_checkpoint_research::Availability<T> {
    fn present_ref(&self) -> Option<&T> {
        match self {
            release_checkpoint_research::Availability::Present(value) => Some(value),
            release_checkpoint_research::Availability::Empty
            | release_checkpoint_research::Availability::Unavailable => None,
        }
    }
}
