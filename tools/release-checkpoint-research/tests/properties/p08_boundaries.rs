// Feature: release-checkpoint-research, Property 8: Comparison boundaries are exact
// PROPERTY_TAG: P08_COMPARISON_BOUNDARIES
use release_checkpoint_research::{ComparisonRange, EvidenceId, FullId};

#[test]
fn p08_evidence_ids_are_typed() {
    assert_eq!(
        EvidenceId::new("evidence-01").unwrap().as_str(),
        "evidence-01"
    );
    assert!(EvidenceId::new("").is_err());
    assert!(EvidenceId::new("not an id").is_err());
}

#[test]
fn p08_comparison_boundaries_are_exact_for_128_cases() {
    for case in 0..128_u32 {
        let baseline = FullId::new(format!("{case:040x}")).expect("baseline full ID");
        let current = FullId::new(format!("{:040x}", case + 1)).expect("current full ID");
        let range = ComparisonRange::new(baseline.clone(), current.clone());
        assert_eq!(range.baseline, baseline);
        assert_eq!(range.current, current);
        assert!(!range.is_empty());
        assert!(range.baseline_is_excluded());
        assert!(range.current_is_included());

        let empty = ComparisonRange::new(current.clone(), current);
        assert!(empty.is_empty());
        assert!(empty.baseline_is_excluded());
        assert!(empty.current_is_included());

        // Negative coverage: abbreviated and non-hex IDs never become a
        // comparison boundary, so a malformed boundary cannot be fabricated.
        assert!(FullId::new(format!("{case:x}")).is_err());
        assert!(FullId::new(format!("{case:039x}z")).is_err());
    }
}
