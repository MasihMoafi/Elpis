// Explicitly include every nested property file so Cargo's test harness compiles
// all 25 property modules rather than only top-level integration-test files.
#[path = "properties/p01_identity.rs"]
mod p01_identity;
#[path = "properties/p02_worktree.rs"]
mod p02_worktree;
#[path = "properties/p03_traceability.rs"]
mod p03_traceability;
#[path = "properties/p04_release_enumeration.rs"]
mod p04_release_enumeration;
#[path = "properties/p05_unavailable_release.rs"]
mod p05_unavailable_release;
#[path = "properties/p06_selected_baseline.rs"]
mod p06_selected_baseline;
#[path = "properties/p07_ambiguous_baseline.rs"]
mod p07_ambiguous_baseline;
#[path = "properties/p08_boundaries.rs"]
mod p08_boundaries;
#[path = "properties/p09_delta_fidelity.rs"]
mod p09_delta_fidelity;
#[path = "properties/p10_clean_state.rs"]
mod p10_clean_state;
#[path = "properties/p11_no_baseline.rs"]
mod p11_no_baseline;
#[path = "properties/p12_artifact_union.rs"]
mod p12_artifact_union;
#[path = "properties/p13_artifact_schema.rs"]
mod p13_artifact_schema;
#[path = "properties/p14_artifact_safety.rs"]
mod p14_artifact_safety;
#[path = "properties/p15_ignore_proposals.rs"]
mod p15_ignore_proposals;
#[path = "properties/p16_removal_register.rs"]
mod p16_removal_register;
#[path = "properties/p17_artifact_unavailable.rs"]
mod p17_artifact_unavailable;
#[path = "properties/p18_workflow_extraction.rs"]
mod p18_workflow_extraction;
#[path = "properties/p19_readme_input.rs"]
mod p19_readme_input;
#[path = "properties/p20_trigger_evaluation.rs"]
mod p20_trigger_evaluation;
#[path = "properties/p21_execution_evidence.rs"]
mod p21_execution_evidence;
#[path = "properties/p22_build_policy.rs"]
mod p22_build_policy;
#[path = "properties/p23_action_dependency.rs"]
mod p23_action_dependency;
#[path = "properties/p24_action_plan.rs"]
mod p24_action_plan;
#[path = "properties/p25_boundary.rs"]
mod p25_boundary;
