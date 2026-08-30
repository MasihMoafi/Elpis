// Feature: release-checkpoint-research, Property 10: Clean-state derivation
// PROPERTY_TAG: P10_CLEAN_STATE
use release_checkpoint_research::{
    Availability, EvidenceCitation, EvidenceId, EvidenceLocator, EvidenceSet, ExactText,
    InclusiveSpan, RepoRelativePath, WorktreeInventories, WorktreeInventoryKind,
    WorktreePathObservation,
};

fn citation(id: &str, line: u32) -> EvidenceCitation {
    EvidenceCitation::new(
        EvidenceId::new(id).unwrap(),
        EvidenceLocator::new(
            RepoRelativePath::new("src/lib.rs").unwrap(),
            InclusiveSpan::new(line, line).unwrap(),
        ),
        Availability::Present(ExactText::new("quote")),
    )
}

#[test]
fn p10_duplicate_ids_and_locators_fail() {
    assert!(EvidenceSet::try_new(vec![citation("a", 1), citation("a", 2)]).is_err());
    assert!(EvidenceSet::try_new(vec![citation("a", 1), citation("b", 1)]).is_err());
    assert!(EvidenceSet::try_new(vec![citation("a", 1), citation("b", 2)]).is_ok());
}

#[test]
fn p10_clean_state_derivation_covers_128_positive_and_negative_cases() {
    for case in 0..128_u32 {
        let ignored_path = RepoRelativePath::new(format!("ignored-{case}.log")).unwrap();
        let ignored =
            WorktreePathObservation::new(WorktreeInventoryKind::Ignored, ignored_path, "ignored");
        let ignored_only = WorktreeInventories {
            staged: Availability::Empty,
            unstaged: Availability::Empty,
            untracked: Availability::Empty,
            ignored: Availability::Present(vec![ignored]),
        };
        assert!(ignored_only.is_clean());
        assert_eq!(ignored_only.clean_fact(), Availability::Present(true));

        let dirty_path = RepoRelativePath::new(format!("tracked-{case}.txt")).unwrap();
        let staged =
            WorktreePathObservation::new(WorktreeInventoryKind::Staged, dirty_path.clone(), "M");
        let unstaged =
            WorktreePathObservation::new(WorktreeInventoryKind::Unstaged, dirty_path, "M");
        let dirty = WorktreeInventories {
            staged: Availability::Present(vec![staged]),
            unstaged: Availability::Present(vec![unstaged]),
            untracked: Availability::Empty,
            ignored: Availability::Empty,
        };
        assert!(!dirty.is_clean());
        assert_eq!(dirty.clean_fact(), Availability::Present(false));

        // Negative coverage: an unavailable relevant inventory fails closed;
        // it must not be mistaken for an inspected clean worktree.
        let unavailable = WorktreeInventories {
            staged: Availability::Empty,
            unstaged: Availability::Unavailable,
            untracked: Availability::Empty,
            ignored: Availability::Present(Vec::new()),
        };
        assert_eq!(unavailable.clean_fact(), Availability::Unavailable);
        assert!(!unavailable.is_clean());
    }
}
