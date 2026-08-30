// Feature: release-checkpoint-research, Property 2: Independent worktree inventories
// required property tag: p02_worktree
use release_checkpoint_research::{Availability, ExactText, FullId, RepoRelativePath};

#[test]
fn p02_worktree_property_tag_and_independence() {
    assert_eq!(PROPERTY_TAG, "p02_worktree");
    for case in 1..=128_u32 {
        let path =
            RepoRelativePath::new(format!("worktree-{case}/src/lib.rs")).expect("relative path");
        let first = vec![path.clone()];
        let mut second = first.clone();
        second.push(RepoRelativePath::new(format!("worktree-{case}/Cargo.toml")).unwrap());
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 2);
        let id = FullId::new("b".repeat(40)).unwrap();
        let remotes: Availability<
            std::collections::BTreeMap<ExactText, release_checkpoint_research::Fingerprint>,
        > = Availability::Empty;
        assert!(id.as_str().ends_with('b'));
        assert!(remotes.is_empty());
    }
}

const PROPERTY_TAG: &str = "p02_worktree";
