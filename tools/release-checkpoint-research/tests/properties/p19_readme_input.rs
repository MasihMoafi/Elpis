// Feature: release-checkpoint-research, Property 19: README causality input is preserved
const PROPERTY_TAG: &str = "p19_readme_input";

use release_checkpoint_research::{
    Availability, ExactText, FullId, ReadmeUpdateInput, RepoRelativePath,
};

fn full_id(number: usize) -> FullId {
    FullId::new(format!("{number:040x}")).expect("generated full ID")
}

#[test]
fn p19_preserves_every_supplied_field_and_unavailable_state() {
    assert_eq!(PROPERTY_TAG, "p19_readme_input");
    let mut complete_cases = 0;
    let mut partial_cases = 0;
    for case in 0..256_usize {
        let commit = full_id(case + 1);
        let parent = full_id(case + 10_000);
        let path = RepoRelativePath::new(format!("docs/readme-{case}.md")).unwrap();
        let event = ExactText::new(if case % 2 == 0 {
            "push"
        } else {
            "pull_request"
        });
        let reference = ExactText::new(format!("refs/heads/branch-{case}"));
        let mask = case % 32;
        let input = ReadmeUpdateInput::new(
            if mask & 1 == 0 {
                Availability::Present(commit.clone())
            } else {
                Availability::Unavailable
            },
            if mask & 2 == 0 {
                Availability::Present(vec![parent.clone()])
            } else {
                Availability::Unavailable
            },
            if mask & 4 == 0 {
                Availability::Present(vec![path.clone()])
            } else {
                Availability::Unavailable
            },
            if mask & 8 == 0 {
                Availability::Present(event.clone())
            } else {
                Availability::Unavailable
            },
            if mask & 16 == 0 {
                Availability::Present(reference.clone())
            } else {
                Availability::Unavailable
            },
        );

        match (&input.update_commit, mask & 1) {
            (Availability::Present(actual), 0) => assert_eq!(actual, &commit),
            (Availability::Unavailable, 1) => {}
            other => panic!("update commit changed state: {other:?}"),
        }
        match (&input.parent_commits, mask & 2) {
            (Availability::Present(actual), 0) => assert_eq!(actual, &vec![parent.clone()]),
            (Availability::Unavailable, 2) => {}
            other => panic!("parent commits changed state: {other:?}"),
        }
        match (&input.changed_paths, mask & 4) {
            (Availability::Present(actual), 0) => assert_eq!(actual, &vec![path.clone()]),
            (Availability::Unavailable, 4) => {}
            other => panic!("changed paths changed state: {other:?}"),
        }
        match (&input.event, mask & 8) {
            (Availability::Present(actual), 0) => assert_eq!(actual, &event),
            (Availability::Unavailable, 8) => {}
            other => panic!("event changed state: {other:?}"),
        }
        match (&input.r#ref, mask & 16) {
            (Availability::Present(actual), 0) => assert_eq!(actual, &reference),
            (Availability::Unavailable, 16) => {}
            other => panic!("ref changed state: {other:?}"),
        }

        if mask == 0 {
            complete_cases += 1;
            let complete =
                ReadmeUpdateInput::complete(commit, vec![parent], vec![path], event, reference);
            assert!(complete.update_commit.is_present());
            assert!(complete.parent_commits.is_present());
            assert!(complete.changed_paths.is_present());
            assert!(complete.event.is_present());
            assert!(complete.r#ref.is_present());
        } else {
            partial_cases += 1;
        }
    }
    assert!(complete_cases >= 8);
    assert!(partial_cases >= 128);
    assert!(ReadmeUpdateInput::unavailable()
        .update_commit
        .is_unavailable());
}
