//! Startup phrases (Elpis replaces the list; the selection logic is upstream's).
//! One selection is shared by the provisional, live, and committed session headers.

use rand::Rng;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Greeting {
    pub(crate) phrase: &'static str,
}

impl Greeting {
    pub(super) fn choose() -> Self {
        Self {
            phrase: GREETINGS[rand::rng().random_range(0..GREETINGS.len())],
        }
    }
}

// Elpis: its own startup lines in place of Codex's list.
const GREETINGS: &[&str] = &[
    "Elpis here. What are we building?",
    "Hope, with a test suite.",
    "Context in check. Ready when you are.",
    "Tab shows exactly what the model sees.",
    "Fresh context, clear head.",
    "Small steps, verified.",
    "Ready to read, plan and patch.",
    "Bring the hard part.",
];

#[cfg(test)]
mod tests {
    use super::*;

    // Elpis: the header greets with Elpis's lines, never Codex's.
    #[test]
    fn greeting_is_one_of_elpis_lines() {
        for _ in 0..64 {
            let phrase = Greeting::choose().phrase;
            assert!(GREETINGS.contains(&phrase));
            assert!(!phrase.contains("neighborhood"), "{phrase}");
        }
    }
}
