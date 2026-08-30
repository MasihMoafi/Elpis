// Feature: release-checkpoint-research, Property 11: No-baseline current fallback
// PROPERTY_TAG: P11_NO_BASELINE_FALLBACK
use release_checkpoint_research::{
    ComparisonRange, Conclusion, ConclusionLabel, CurrentFallback, CurrentRevision, DeltaReport,
    EvidenceId, ExactText, FullId, Redaction,
};

#[test]
fn p11_conclusion_labels_are_closed_and_ids_unique() {
    let id = EvidenceId::new("e1").unwrap();
    let conclusion = Conclusion::new(
        ConclusionLabel::Pass,
        Redaction::None,
        ExactText::new("exact rationale"),
        vec![id.clone()],
    )
    .unwrap();
    assert_eq!(conclusion.label, ConclusionLabel::Pass);
    assert!(Conclusion::new(
        ConclusionLabel::Fail,
        Redaction::None,
        ExactText::new("x"),
        vec![id.clone(), id]
    )
    .is_err());
}

#[test]
fn p11_no_baseline_fallback_covers_128_positive_and_negative_cases() {
    for case in 0..128_u32 {
        let current_id = FullId::new(format!("{:040x}", case + 1)).unwrap();
        let current = CurrentRevision::new(
            current_id.clone(),
            format!("2026-08-{:02}T01:02:03-04:00", (case % 28) + 1),
            format!("current subject {case}"),
        );
        let fallback = CurrentFallback::new(current.clone());
        assert!(fallback.comparison_is_unavailable());
        assert!(fallback.reason.as_str().contains("baseline-to-current"));
        assert!(fallback.reason.as_str().contains("unavailable"));
        assert_eq!(fallback.current, current);

        let report = DeltaReport::CurrentFallback(fallback);
        assert!(report.is_current_fallback());
        assert!(!report.is_compared());
        assert_eq!(report.current().commit, current_id);
        assert!(report.range().is_none());
        assert!(report.commits().is_empty());
        assert!(report.changed_paths().is_empty());

        // Negative coverage: a real comparison is never mislabeled as a
        // current-only fallback, even when its range is empty.
        let compared = DeltaReport::Compared(release_checkpoint_research::DeltaComparison {
            current: current.clone(),
            range: ComparisonRange::new(current_id.clone(), current_id),
            commits: Vec::new(),
            changed_paths: Vec::new(),
        });
        assert!(compared.is_compared());
        assert!(!compared.is_current_fallback());
        assert!(compared.range().is_some());
    }
}
