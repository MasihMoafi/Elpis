//! Elpis: guidance for one compaction, from `/compact <text>` or the `instructions` field of
//! `thread/compact/start`. Copied from v0.3.0 `compact.rs`.
//!
//! The guidance extends the base instructions of that compaction request only. The summary
//! prompt stays, and later compactions and normal turns do not inherit the guidance.

use codex_protocol::models::BaseInstructions;

const ADDITIONAL_COMPACTION_INSTRUCTIONS_HEADER: &str = "Additional compaction instructions:";

pub(crate) fn with_additional_compaction_instructions(
    mut base_instructions: BaseInstructions,
    instructions: Option<&str>,
) -> BaseInstructions {
    if let Some(instructions) = instructions {
        base_instructions.text.push_str("\n\n");
        base_instructions
            .text
            .push_str(ADDITIONAL_COMPACTION_INSTRUCTIONS_HEADER);
        base_instructions.text.push('\n');
        base_instructions.text.push_str(instructions);
    }
    base_instructions
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn additional_compaction_instructions_extend_base_guidance_exactly() {
        let base = BaseInstructions {
            text: "normal base guidance".to_string(),
            provenance: None,
        };

        let augmented = with_additional_compaction_instructions(
            base,
            Some("Preserve unresolved blockers — ۳ نکته."),
        );

        assert_eq!(
            augmented.text,
            "normal base guidance\n\nAdditional compaction instructions:\nPreserve unresolved blockers — ۳ نکته."
        );
    }

    #[test]
    fn bare_compaction_leaves_base_guidance_unchanged() {
        let base = BaseInstructions {
            text: "normal base guidance".to_string(),
            provenance: None,
        };

        let unchanged = with_additional_compaction_instructions(base.clone(), None);

        assert_eq!(unchanged, base);
    }
}
