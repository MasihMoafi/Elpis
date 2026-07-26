// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use super::normalize_thread_name;

#[test]
fn normalize_thread_name_trims_and_rejects_empty() {
    assert_eq!(normalize_thread_name("   "), None);
    assert_eq!(
        normalize_thread_name("  my thread  "),
        Some("my thread".to_string())
    );
}
