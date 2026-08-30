// Feature: release-checkpoint-research, Property 1: Canonical audit identity
// required property tag: p01_identity
use release_checkpoint_research::{Availability, ExactText, FullId};

#[test]
fn p01_identity_property_tag_and_round_trip() {
    assert_eq!(PROPERTY_TAG, "p01_identity");
    for case in 0..128_u32 {
        let text = format!(" exact {case}  ");
        let exact = ExactText::new(text.clone());
        assert_eq!(exact.as_str(), text);
        let id = FullId::new(format!("{:0>40}", format!("{case:x}"))).expect("full ID");
        assert_eq!(id.as_str().len(), 40);
        let value: Availability<ExactText> = Availability::Present(exact);
        assert!(value.is_present());
    }
}

const PROPERTY_TAG: &str = "p01_identity";
