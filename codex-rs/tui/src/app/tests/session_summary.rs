// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use super::*;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn session_summary_skips_when_no_usage_or_resume_hint() {
    assert!(
        session_summary(
            TokenUsage::default(),
            /*thread_id*/ None,
            /*thread_name*/ None,
            /*rollout_path*/ None,
        )
        .is_none()
    );
}

#[tokio::test]
async fn session_summary_skips_resume_hint_until_rollout_exists() {
    let usage = TokenUsage::default();
    let conversation = ThreadId::from_string("123e4567-e89b-12d3-a456-426614174000").unwrap();
    let temp_dir = tempdir().expect("temp dir");
    let rollout_path = temp_dir.path().join("rollout.jsonl");

    assert!(
        session_summary(
            usage,
            Some(conversation),
            /*thread_name*/ None,
            Some(&rollout_path),
        )
        .is_none()
    );
}

#[tokio::test]
async fn session_summary_includes_resume_hint_for_persisted_rollout() {
    let usage = TokenUsage {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        ..Default::default()
    };
    let conversation = ThreadId::from_string("123e4567-e89b-12d3-a456-426614174000").unwrap();
    let temp_dir = tempdir().expect("temp dir");
    let rollout_path = temp_dir.path().join("rollout.jsonl");
    std::fs::write(&rollout_path, "{}\n").expect("write rollout");

    let summary = session_summary(
        usage,
        Some(conversation),
        /*thread_name*/ None,
        Some(&rollout_path),
    )
    .expect("summary");
    // Token usage stays out of the session-end summary; it lives in /usage.
    assert_eq!(summary.usage_line, None);
    assert_eq!(
        summary.resume_hint,
        Some("elpis resume 123e4567-e89b-12d3-a456-426614174000".to_string())
    );
}

#[tokio::test]
async fn session_summary_names_picker_item_when_thread_has_name() {
    let usage = TokenUsage {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        ..Default::default()
    };
    let conversation = ThreadId::from_string("123e4567-e89b-12d3-a456-426614174000").unwrap();
    let temp_dir = tempdir().expect("temp dir");
    let rollout_path = temp_dir.path().join("rollout.jsonl");
    std::fs::write(&rollout_path, "{}\n").expect("write rollout");

    let summary = session_summary(
        usage,
        Some(conversation),
        Some("my-session".to_string()),
        Some(&rollout_path),
    )
    .expect("summary");
    assert_eq!(
        summary.resume_hint,
        Some(
            "elpis resume, then select my-session (123e4567-e89b-12d3-a456-426614174000)"
                .to_string()
        )
    );
}
