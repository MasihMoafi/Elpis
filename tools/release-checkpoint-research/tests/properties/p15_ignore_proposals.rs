// Feature: release-checkpoint-research, Property 15: Ignore proposals preserve exceptions and provenance
use release_checkpoint_research::{
    build_artifact_inventory, build_ignore_pattern_proposal, build_untracking_follow_ups,
    ArtifactCategory, ArtifactInventoryInput, Availability, EvidenceReference,
    EvidenceReferenceLocator, EvidenceSourceIdentity, EvidenceSourceKind, ExactText, FullId,
    IgnoreFileSnapshot, IgnorePatternOrigin, IgnorePatternRequest, PrimaryClassification,
    RepoRelativePath, RequiredExceptionResult, RetentionRecommendation, UtcSeconds,
};
use std::collections::{BTreeMap, BTreeSet};

const PROPERTY_TAG: &str = "p15_ignore_proposals";

fn path(value: &str) -> RepoRelativePath {
    RepoRelativePath::new(value).expect("valid property path")
}

fn evidence(line: u32) -> EvidenceReference {
    let source = EvidenceSourceIdentity::new(EvidenceSourceKind::Worktree, "p15").unwrap();
    EvidenceReference::new(
        source,
        EvidenceReferenceLocator::file(
            path(".gitignore"),
            release_checkpoint_research::InclusiveSpan::new(line, line).unwrap(),
        ),
    )
}

#[test]
fn p15_exact_tag_and_128_positive_negative_provenance_cases() {
    assert_eq!(PROPERTY_TAG, "p15_ignore_proposals");
    for case in 0..128_u32 {
        let matched = path(&format!("cache/case-{case}.bin"));
        let current = Availability::Present(BTreeSet::from([matched.clone()]));
        let exceptions = if case % 2 == 0 {
            RequiredExceptionResult::paths(BTreeSet::from([path("cache/README.md")])).unwrap()
        } else {
            RequiredExceptionResult::none()
        };
        let category: ArtifactCategory = PrimaryClassification::Cache;
        let request = IgnorePatternRequest::new(
            "cache/*.bin",
            if case % 2 == 0 {
                IgnorePatternOrigin::ExistingIgnoreFileEntry
            } else {
                IgnorePatternOrigin::ProposedNewEntry
            },
            category.clone(),
            exceptions.clone(),
            vec![evidence(case + 1)],
        )
        .unwrap();
        let proposal = match build_ignore_pattern_proposal(&request, &current).unwrap() {
            Availability::Present(proposal) => proposal,
            other => panic!("expected present proposal, got {other:?}"),
        };
        assert_eq!(proposal.pattern, ExactText::new("cache/*.bin"));
        assert_eq!(proposal.origin, request.origin);
        assert_eq!(proposal.category, category);
        assert_eq!(proposal.match_count, 1);
        assert_eq!(proposal.examples, vec![matched.clone()]);
        assert_eq!(proposal.required_exceptions, exceptions);
        assert_eq!(proposal.evidence, request.evidence);

        // A present-but-empty filesystem is a measured zero, not unavailable.
        let zero = build_ignore_pattern_proposal(&request, &Availability::Present(BTreeSet::new()))
            .unwrap();
        let zero = match zero {
            Availability::Present(proposal) => proposal,
            other => panic!("expected zero-match proposal, got {other:?}"),
        };
        assert_eq!(zero.match_count, 0);
        assert!(zero.examples.is_empty());

        // Unsupported wildmatch syntax is conservative and cannot claim a match.
        let uncertain = IgnorePatternRequest::proposed(
            "cache/[ab].bin",
            PrimaryClassification::Cache,
            RequiredExceptionResult::none(),
            vec![evidence(case + 1)],
        )
        .unwrap();
        let uncertain = build_ignore_pattern_proposal(&uncertain, &current).unwrap();
        assert!(uncertain.is_unavailable());

        let unavailable =
            build_ignore_pattern_proposal(&request, &Availability::Unavailable).unwrap();
        assert!(unavailable.is_unavailable());
    }
}

#[test]
fn p15_existing_tracked_match_has_separate_follow_up_and_never_changes_retention() {
    assert_eq!(PROPERTY_TAG, "p15_ignore_proposals");
    for case in 0..128_u32 {
        let tracked_path = path(&format!("cache/tracked-{case}.bin"));
        let input = ArtifactInventoryInput::new(
            FullId::new("a".repeat(40)).unwrap(),
            UtcSeconds::now().unwrap(),
            Availability::Present(BTreeSet::from([tracked_path.clone()])),
            Availability::Present(BTreeSet::from([tracked_path.clone()])),
        );
        let inventory = build_artifact_inventory(input).unwrap();
        let before = inventory.candidates[&tracked_path].clone();
        assert_eq!(
            before.retention_recommendation(),
            RetentionRecommendation::Retain
        );
        let ignore = IgnoreFileSnapshot::from_patterns(vec!["cache/".to_owned()]).unwrap();
        let follow_ups = build_untracking_follow_ups(
            &inventory.candidates,
            &ignore,
            &Availability::Present(BTreeSet::from([tracked_path.clone()])),
        );
        let follow_ups = match follow_ups {
            Availability::Present(follow_ups) => follow_ups,
            other => panic!("expected follow-up map, got {other:?}"),
        };
        let follow_up = follow_ups.get(&tracked_path).expect("tracked ignore match");
        assert_eq!(follow_up.path, tracked_path);
        assert_eq!(follow_up.pattern, ExactText::new("cache/"));
        assert!(!follow_up.evidence.is_empty());
        assert_eq!(inventory.candidates[&tracked_path], before);
        assert_eq!(
            inventory.candidates[&tracked_path].retention,
            release_checkpoint_research::RetentionDecision::Unassessed
        );

        let proposed = IgnorePatternRequest::proposed(
            "cache/",
            PrimaryClassification::Cache,
            RequiredExceptionResult::none(),
            vec![evidence(case + 1)],
        )
        .unwrap();
        let proposals = release_checkpoint_research::build_ignore_proposals(
            [proposed],
            &Availability::Present(BTreeSet::from([tracked_path.clone()])),
        )
        .unwrap();
        let proposed_follow_ups =
            release_checkpoint_research::build_untracking_follow_ups_from_proposals(
                &inventory.candidates,
                &proposals,
                &Availability::Present(BTreeSet::from([tracked_path.clone()])),
            );
        assert!(matches!(proposed_follow_ups, Availability::Present(ref map) if map.is_empty()));
    }
}

#[test]
fn p15_snapshot_provenance_is_existing_and_ordered() {
    let snapshot =
        IgnoreFileSnapshot::from_patterns(vec!["cache/".to_owned(), "*.tmp".to_owned()]).unwrap();
    let entries = match snapshot.entries() {
        Availability::Present(entries) => entries,
        other => panic!("expected entries, got {other:?}"),
    };
    assert_eq!(entries[0].pattern, ExactText::new("cache/"));
    assert_eq!(entries[0].line, 1);
    assert_eq!(entries[1].pattern, ExactText::new("*.tmp"));
    assert!(entries
        .iter()
        .all(|entry| entry.evidence.source.name.as_str() == ".gitignore"));

    let mut categories = BTreeMap::new();
    categories.insert(ExactText::new("cache/"), PrimaryClassification::Cache);
    categories.insert(
        ExactText::new("*.tmp"),
        PrimaryClassification::LocalOnlyFile,
    );
    let proposals = release_checkpoint_research::build_existing_ignore_proposals_with_categories(
        &snapshot,
        &categories,
        &Availability::Present(BTreeSet::new()),
    )
    .unwrap();
    let proposals = match proposals {
        Availability::Present(proposals) => proposals,
        other => panic!("expected proposals, got {other:?}"),
    };
    assert_eq!(proposals.len(), 2);
    assert!(proposals.iter().all(|proposal| proposal.is_existing()));
}
