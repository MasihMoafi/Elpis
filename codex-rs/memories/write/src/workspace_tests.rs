// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use super::*;
use codex_git_utils::GitBaselineChange;
use codex_git_utils::GitBaselineChangeStatus;
use pretty_assertions::assert_eq;
use std::fs;
use tempfile::TempDir;

#[test]
fn render_workspace_diff_file_bounds_large_diff() {
    let diff = GitBaselineDiff {
        changes: vec![GitBaselineChange {
            status: GitBaselineChangeStatus::Modified,
            path: "MEMORY.md".to_string(),
        }],
        unified_diff: "a".repeat(crate::workspace_diff::MAX_BYTES + 128),
    };

    let rendered = render_workspace_diff_file(&diff);

    assert!(rendered.contains("- M MEMORY.md"));
    assert!(rendered.contains("[workspace diff truncated at 4194304 bytes]"));
    assert!(rendered.ends_with("```\n"));
}

#[tokio::test]
async fn reset_memory_workspace_baseline_removes_generated_diff() {
    let home = TempDir::new().expect("tempdir");
    let root = home.path().join("memories");
    prepare_memory_workspace(&root)
        .await
        .expect("prepare memory workspace");
    fs::write(root.join("MEMORY.md"), "memory").expect("write memory");
    write_workspace_diff(
        &root,
        &GitBaselineDiff {
            changes: vec![GitBaselineChange {
                status: GitBaselineChangeStatus::Added,
                path: "MEMORY.md".to_string(),
            }],
            unified_diff: "+memory\n".to_string(),
        },
    )
    .await
    .expect("write workspace diff");

    reset_memory_workspace_baseline(&root)
        .await
        .expect("reset baseline");

    assert!(!root.join(crate::workspace_diff::FILENAME).exists());
    let diff = memory_workspace_diff(&root)
        .await
        .expect("load workspace diff");
    assert_eq!(diff.changes, Vec::new());
}

#[tokio::test]
async fn reset_memory_workspace_baseline_archives_deleted_lines() {
    let home = TempDir::new().expect("tempdir");
    let root = home.path().join("memories");
    fs::create_dir_all(&root).expect("create memory root");
    fs::write(root.join("MEMORY.md"), "keep\narchive this fact\n").expect("write memory");
    prepare_memory_workspace(&root)
        .await
        .expect("prepare memory workspace");

    fs::write(root.join("MEMORY.md"), "keep\n").expect("remove memory line");
    reset_memory_workspace_baseline(&root)
        .await
        .expect("reset baseline");

    let archive = fs::read_to_string(root.join("archive.md")).expect("read archive");
    assert!(archive.starts_with("# Elpis Memory Archive\n"));
    assert!(archive.contains("archive this fact"));
    assert!(!archive.contains("--- a/MEMORY.md"));
    let diff = memory_workspace_diff(&root)
        .await
        .expect("load workspace diff");
    assert_eq!(diff.changes, Vec::new());
}

#[tokio::test]
async fn reset_memory_workspace_baseline_propagates_archive_write_failure() {
    let home = TempDir::new().expect("tempdir");
    let root = home.path().join("memories");
    fs::create_dir_all(&root).expect("create memory root");
    fs::write(root.join("MEMORY.md"), "keep\narchive this fact\n").expect("write memory");
    prepare_memory_workspace(&root)
        .await
        .expect("prepare memory workspace");

    fs::write(root.join("MEMORY.md"), "keep\n").expect("remove memory line");
    fs::create_dir(root.join("archive.md")).expect("block archive file write");

    let err = reset_memory_workspace_baseline(&root)
        .await
        .expect_err("archive failure must stop baseline reset");
    assert!(err.to_string().contains("memory archive"));

    let diff = memory_workspace_diff(&root)
        .await
        .expect("load workspace diff after failed reset");
    assert!(!diff.changes.is_empty(), "baseline must remain unmodified");
    assert!(diff.unified_diff.contains("archive this fact"));
}

#[tokio::test]
async fn prepare_memory_workspace_recovers_unusable_git_dir() {
    let home = TempDir::new().expect("tempdir");
    let root = home.path().join("memories");
    fs::create_dir_all(root.join(".git")).expect("create unusable git dir");
    fs::write(root.join("MEMORY.md"), "memory").expect("write memory");

    prepare_memory_workspace(&root)
        .await
        .expect("prepare memory workspace");

    let diff = memory_workspace_diff(&root)
        .await
        .expect("load workspace diff");
    assert_eq!(diff.changes, Vec::new());
}

#[test]
fn previous_char_boundary_handles_multibyte_text() {
    let text = "aé";
    assert_eq!(previous_char_boundary(text, /*max_bytes*/ 2), 1);
}

#[tokio::test]
async fn validate_consolidation_artifacts_rejects_invalid_summary() {
    let home = TempDir::new().expect("tempdir");
    let root = home.path().join("memories");
    fs::create_dir_all(&root).expect("create memory root");
    fs::write(root.join("MEMORY.md"), "memory").expect("write memory");
    fs::write(root.join("memory_summary.md"), "outdated\n").expect("write summary");

    let err = validate_consolidation_artifacts(&root)
        .await
        .expect_err("invalid summary should fail validation");

    assert!(err.to_string().contains("does not start with v1"));
}

#[tokio::test]
async fn validate_consolidation_artifacts_rejects_oversized_memory() {
    let home = TempDir::new().expect("tempdir");
    let root = home.path().join("memories");
    fs::create_dir_all(&root).expect("create memory root");
    fs::write(
        root.join("MEMORY.md"),
        "x".repeat(super::MAX_DURABLE_MEMORY_CHARS + 1),
    )
    .expect("write memory");
    fs::write(root.join("memory_summary.md"), "v1\n").expect("write summary");

    let err = validate_consolidation_artifacts(&root)
        .await
        .expect_err("oversized memory should fail validation");

    assert!(err.to_string().contains("exceeds 30000 characters"));
}

#[tokio::test]
async fn validate_consolidation_artifacts_rejects_oversized_summary() {
    let home = TempDir::new().expect("tempdir");
    let root = home.path().join("memories");
    fs::create_dir_all(&root).expect("create memory root");
    fs::write(root.join("MEMORY.md"), "memory").expect("write memory");
    fs::write(
        root.join("memory_summary.md"),
        format!("v1\n{}", "x".repeat(super::MAX_MEMORY_SUMMARY_CHARS)),
    )
    .expect("write summary");

    let err = validate_consolidation_artifacts(&root)
        .await
        .expect_err("oversized summary should fail validation");

    assert!(err.to_string().contains("exceeds 10000 characters"));
}
