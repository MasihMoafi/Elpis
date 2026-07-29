// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Conservative local policy for the `/model` Auto selection.

use codex_protocol::openai_models::ReasoningEffort;

pub(crate) const LUNA_MODEL: &str = "gpt-5.6-luna";
pub(crate) const TERRA_MODEL: &str = "gpt-5.6-terra";
pub(crate) const SOL_MODEL: &str = "gpt-5.6-sol";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ModelRoute {
    pub(super) model: &'static str,
    pub(super) reasoning_effort: ReasoningEffort,
    pub(super) reason: &'static str,
}

pub(super) fn route_user_request(request: &str) -> ModelRoute {
    let normalized = request.to_ascii_lowercase();

    if needs_frontier_reasoning(&normalized, request.len()) {
        return ModelRoute {
            model: SOL_MODEL,
            reasoning_effort: ReasoningEffort::High,
            reason: "complex, critical, or long-horizon request",
        };
    }

    if is_plainly_mechanical(&normalized, request.len()) {
        return ModelRoute {
            model: LUNA_MODEL,
            reasoning_effort: ReasoningEffort::Low,
            reason: "plainly mechanical request",
        };
    }

    ModelRoute {
        model: TERRA_MODEL,
        reasoning_effort: ReasoningEffort::Medium,
        reason: "default for everyday work",
    }
}

fn needs_frontier_reasoning(request: &str, byte_len: usize) -> bool {
    if byte_len > 6_000 {
        return true;
    }

    [
        "critical review",
        "final review",
        "research paper",
        "security audit",
        "threat model",
        "production incident",
        "root cause analysis",
        "long-horizon",
        "long horizon",
        "multi-day",
        "architecture redesign",
        "migration plan",
    ]
    .iter()
    .any(|signal| request.contains(signal))
}

fn is_plainly_mechanical(request: &str, byte_len: usize) -> bool {
    if byte_len > 280
        || [
            "delete",
            "deploy",
            "release",
            "security",
            "permission",
            "auth",
            "payment",
            "migration",
            "refactor",
            "debug",
            "investigate",
            "review",
            "design",
        ]
        .iter()
        .any(|risk| request.contains(risk))
    {
        return false;
    }

    [
        "copy ",
        "move ",
        "rename ",
        "list ",
        "show ",
        "print ",
        "create directory",
        "make directory",
    ]
    .iter()
    .any(|verb| request.starts_with(verb))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_ordinary_work_to_terra() {
        assert_eq!(
            route_user_request("Add a focused test for this parser").model,
            TERRA_MODEL
        );
    }

    #[test]
    fn routes_only_plainly_mechanical_work_to_luna() {
        assert_eq!(
            route_user_request("Copy notes.md to archive.md").model,
            LUNA_MODEL
        );
        assert_eq!(
            route_user_request("Delete the old notes file").model,
            TERRA_MODEL
        );
    }

    #[test]
    fn routes_high_stakes_and_long_work_to_sol() {
        assert_eq!(
            route_user_request("Do a critical review of the final research paper").model,
            SOL_MODEL
        );
        assert_eq!(route_user_request(&"x".repeat(6_001)).model, SOL_MODEL);
    }
}
