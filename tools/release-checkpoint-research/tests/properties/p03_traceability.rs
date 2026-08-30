// PROPERTY_TAG: P03_TRACEABILITY
// Feature: release-checkpoint-research, Property 3: Evidence and conclusion traceability
use release_checkpoint_research::{
    deserialize_strict, serialize_deterministically, Availability, EvidenceReference,
    EvidenceSourceIdentity, EvidenceSourceKind, ExactText, FullId, InclusiveSpan, ReleaseCandidate,
    ReleaseDateObservation, RepoRelativePath,
};

#[test]
fn p03_traceability_is_stable_and_evidence_is_traceable() {
    assert_eq!(PROPERTY_TAG, "p03_traceability");
    for case in 0..128_u32 {
        let path = RepoRelativePath::new(format!("release-evidence-{case}/README.md")).unwrap();
        let span = InclusiveSpan::new(case + 1, case + 1).unwrap();
        let source = EvidenceSourceIdentity::new(
            EvidenceSourceKind::ReleaseDocument,
            format!("release-evidence-{case}"),
        )
        .unwrap();
        let evidence = EvidenceReference::file(source, path, span);
        let date = ReleaseDateObservation::new(
            format!(
                "2026-{:02}-{:02}T00:00:00Z",
                (case % 12) + 1,
                (case % 28) + 1
            ),
            evidence.clone(),
        )
        .unwrap();
        let candidate = ReleaseCandidate::new(
            format!("document:{case}"),
            Availability::Present(ExactText::new(format!("v{case}.0.0"))),
            Availability::Present(ExactText::new(format!("Release v{case}.0.0"))),
            Availability::Present(ExactText::new(format!("refs/tags/v{case}.0.0"))),
            Availability::Present(FullId::new(format!("{case:040x}")).unwrap()),
            vec![date],
            vec![evidence],
        );
        let json = serialize_deterministically(&candidate).unwrap();
        let decoded: ReleaseCandidate = deserialize_strict(&json).unwrap();
        assert_eq!(decoded, candidate);
        assert_eq!(decoded.source_evidence.len(), 1);
        assert!(!decoded.source_evidence[0].source.name.as_str().is_empty());
    }

    let value = Availability::Present(ExactText::new("keep whitespace  "));
    let json = serialize_deterministically(&value).unwrap();
    let decoded: Availability<ExactText> = deserialize_strict(&json).unwrap();
    assert_eq!(decoded, value);
}

const PROPERTY_TAG: &str = "p03_traceability";
