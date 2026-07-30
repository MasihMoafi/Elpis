// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use super::rollout_summary_file_stem;
use crate::ensure_layout;
use crate::raw_memories_file;
use crate::rebuild_raw_memories_file_from_memories;
use crate::rollout_summaries_dir;
use crate::sync_rollout_summaries_from_memories;
use chrono::TimeZone;
use chrono::Utc;
use codex_config::types::DEFAULT_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION;
use codex_protocol::ThreadId;
use codex_state::Stage1Output;
use pretty_assertions::assert_eq;
use std::path::PathBuf;
use tempfile::tempdir;

const FIXED_PREFIX: &str = "2025-02-11T15-35-19-jqmb";

fn stage1_output_with_slug(thread_id: ThreadId, rollout_slug: Option<&str>) -> Stage1Output {
    Stage1Output {
        thread_id,
        source_updated_at: Utc.timestamp_opt(123, 0).single().expect("timestamp"),
        raw_memory: "raw memory".to_string(),
        rollout_summary: "summary".to_string(),
        rollout_slug: rollout_slug.map(ToString::to_string),
        rollout_path: PathBuf::from("/tmp/rollout.jsonl"),
        cwd: PathBuf::from("/tmp/workspace"),
        git_branch: None,
        generated_at: Utc.timestamp_opt(124, 0).single().expect("timestamp"),
        recall_count: 0,
        unique_query_count: 0,
        last_recalled_at: None,
    }
}

fn fixed_thread_id() -> ThreadId {
    ThreadId::try_from("0194f5a6-89ab-7cde-8123-456789abcdef").expect("valid thread id")
}

/// The sweep log is where Masih looks to answer "is memory working"; a bare candidate count
/// cannot distinguish a working gate from a stuck pipeline.
#[test]
fn promotion_progress_says_how_far_off_the_nearest_memory_is() {
    use super::describe_promotion_progress;

    assert_eq!(describe_promotion_progress(&[]), "nothing stored yet");

    let mut cold = stage1_output_with_slug(fixed_thread_id(), Some("cold"));
    let mut warm = stage1_output_with_slug(fixed_thread_id(), Some("warm"));
    warm.recall_count = 1;
    assert_eq!(
        describe_promotion_progress(&[cold.clone(), warm.clone()]),
        "none of 2 eligible yet; most recalled memory has 1 of the 2 recalls needed"
    );

    cold.recall_count = 2;
    cold.unique_query_count = 2;
    assert_eq!(
        describe_promotion_progress(&[cold, warm]),
        "1 of 2 eligible to promote"
    );
}

#[test]
fn rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_missing() {
    let thread_id = fixed_thread_id();
    let memory = stage1_output_with_slug(thread_id, /*rollout_slug*/ None);

    assert_eq!(rollout_summary_file_stem(&memory), FIXED_PREFIX);
}

#[test]
fn rollout_summary_file_stem_sanitizes_and_truncates_slug() {
    let thread_id = fixed_thread_id();
    let memory = stage1_output_with_slug(
        thread_id,
        Some("Unsafe Slug/With Spaces & Symbols + EXTRA_LONG_12345_67890_ABCDE_fghij_klmno"),
    );

    let stem = rollout_summary_file_stem(&memory);
    let slug = stem
        .strip_prefix(&format!("{FIXED_PREFIX}-"))
        .expect("slug suffix should be present");
    assert_eq!(slug.len(), 60);
    assert_eq!(
        slug,
        "unsafe_slug_with_spaces___symbols___extra_long_12345_67890_a"
    );
}

#[test]
fn rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_is_empty() {
    let thread_id = fixed_thread_id();
    let memory = stage1_output_with_slug(thread_id, Some(""));

    assert_eq!(rollout_summary_file_stem(&memory), FIXED_PREFIX);
}

#[tokio::test]
async fn sync_rollout_summaries_and_raw_memories_file_keeps_latest_memories_only() {
    let dir = tempdir().expect("tempdir");
    let root = dir.path().join("memory");
    ensure_layout(&root).await.expect("ensure layout");

    let keep_id = ThreadId::default().to_string();
    let drop_id = ThreadId::default().to_string();
    let keep_path = rollout_summaries_dir(&root).join(format!("{keep_id}.md"));
    let drop_path = rollout_summaries_dir(&root).join(format!("{drop_id}.md"));
    tokio::fs::write(&keep_path, "keep")
        .await
        .expect("write keep");
    tokio::fs::write(&drop_path, "drop")
        .await
        .expect("write drop");

    let memories = vec![Stage1Output {
        thread_id: ThreadId::try_from(keep_id.clone()).expect("thread id"),
        source_updated_at: Utc.timestamp_opt(100, 0).single().expect("timestamp"),
        raw_memory: "raw memory".to_string(),
        rollout_summary: "short summary".to_string(),
        rollout_slug: None,
        rollout_path: PathBuf::from("/tmp/rollout-100.jsonl"),
        cwd: PathBuf::from("/tmp/workspace"),
        git_branch: None,
        generated_at: Utc.timestamp_opt(101, 0).single().expect("timestamp"),
        recall_count: 3,
        unique_query_count: 2,
        last_recalled_at: Some(Utc.timestamp_opt(102, 0).single().expect("timestamp")),
    }];

    sync_rollout_summaries_from_memories(
        &root,
        &memories,
        DEFAULT_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION,
    )
    .await
    .expect("sync rollout summaries");
    rebuild_raw_memories_file_from_memories(
        &root,
        &memories,
        DEFAULT_MEMORIES_MAX_RAW_MEMORIES_FOR_CONSOLIDATION,
    )
    .await
    .expect("rebuild raw memories");

    assert!(
        !tokio::fs::try_exists(&keep_path)
            .await
            .expect("check stale keep path"),
        "sync should prune stale filename that used thread id only"
    );
    assert!(
        !tokio::fs::try_exists(&drop_path)
            .await
            .expect("check stale drop path"),
        "sync should prune stale filename for dropped thread"
    );

    let mut dir = tokio::fs::read_dir(rollout_summaries_dir(&root))
        .await
        .expect("open rollout summaries dir");
    let mut files = Vec::new();
    while let Some(entry) = dir.next_entry().await.expect("read dir entry") {
        files.push(entry.file_name().to_string_lossy().to_string());
    }
    files.sort_unstable();
    assert_eq!(files.len(), 1);
    let canonical_rollout_summary_file = &files[0];

    let raw_memories = tokio::fs::read_to_string(raw_memories_file(&root))
        .await
        .expect("read raw memories");
    assert!(raw_memories.contains("raw memory"));
    assert!(raw_memories.contains(&keep_id));
    assert!(raw_memories.contains("cwd: /tmp/workspace"));
    assert!(raw_memories.contains("rollout_path: /tmp/rollout-100.jsonl"));
    assert!(raw_memories.contains(&format!(
        "rollout_summary_file: {canonical_rollout_summary_file}"
    )));
    assert!(raw_memories.contains("recall_count: 3"));
    assert!(raw_memories.contains("unique_query_count: 2"));
    assert!(raw_memories.contains("promotion_eligible: true"));
}
