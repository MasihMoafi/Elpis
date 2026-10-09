use super::*;
use pretty_assertions::assert_eq;

#[test]
fn families_keep_their_hues_and_other_models_stay_stable() {
    assert_eq!(agent_hex("claude/opus"), "#b4532a");
    assert_eq!(agent_hex("Claude/Sonnet"), "#b4532a");
    assert_eq!(agent_hex("gpt-6.1-sol"), "#0b7a5e");
    assert_eq!(agent_hex("agy/gemini-3.8-flash-high"), "#1a5fd0");
    assert_eq!(agent_hex("gpt-6-luna"), "#6d3fb5");
    let others = OTHERS.map(|(r, g, b)| format!("#{r:02x}{g:02x}{b:02x}"));
    for model in ["gpt-5.5", "gpt-6-astra", "local/qwen", "gpt-reserve"] {
        assert_eq!(agent_hex(model), agent_hex(model), "{model} is stable");
        assert!(others.contains(&agent_hex(model)), "{model}");
    }
}

#[test]
fn model_label_adds_the_effort_unless_the_name_already_has_it() {
    assert_eq!(
        model_label("GPT-6.1-Sol", Some(&ReasoningEffort::High)),
        "GPT-6.1-Sol · high"
    );
    assert_eq!(
        model_label("Gemini Flash (high)", Some(&ReasoningEffort::High)),
        "Gemini Flash (high)"
    );
    assert_eq!(model_label("GPT-6.1-Sol", /*effort*/ None), "GPT-6.1-Sol");
}
