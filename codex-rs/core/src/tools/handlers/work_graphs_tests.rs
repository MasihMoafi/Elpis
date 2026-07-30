use super::*;
use chrono::Utc;
use codex_protocol::models::ManagedFileSystemPermissions;
use codex_protocol::models::PermissionProfile;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_utils_absolute_path::AbsolutePathBuf;
use pretty_assertions::assert_eq;

fn task(
    id: &str,
    ordinal: i64,
    status: codex_state::WorkGraphTaskStatus,
    dependencies: &[&str],
    scopes: &[&str],
    environment_id: &str,
) -> codex_state::WorkGraphTask {
    let now = Utc::now();
    codex_state::WorkGraphTask {
        graph_id: "graph-1".to_string(),
        task_id: id.to_string(),
        ordinal,
        title: id.to_string(),
        instruction: format!("Implement {id}"),
        kind: if scopes.is_empty() {
            codex_state::WorkGraphTaskKind::Explore
        } else {
            codex_state::WorkGraphTaskKind::Implement
        },
        status,
        dependencies: dependencies
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        write_scopes: scopes.iter().map(|value| (*value).to_string()).collect(),
        acceptance_criteria: vec!["focused check passes".to_string()],
        environment_id: Some(environment_id.to_string()),
        workspace_path: Some(format!("/tmp/{environment_id}")),
        assigned_thread_id: None,
        attempt_count: 0,
        baseline: None,
        result: None,
        evidence: Vec::new(),
        failure_reason: None,
        created_at: now,
        updated_at: now,
        started_at: None,
        completed_at: None,
    }
}

#[test]
fn scheduler_selects_only_dependency_ready_tasks_in_stable_order() {
    let tasks = vec![
        task(
            "first",
            0,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src/first"],
            "repo",
        ),
        task(
            "blocked",
            1,
            codex_state::WorkGraphTaskStatus::Pending,
            &["first"],
            &["src/blocked"],
            "repo",
        ),
        task(
            "second",
            2,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src/second"],
            "repo",
        ),
    ];
    let selected = select_ready_tasks(tasks.as_slice(), 3);
    assert_eq!(
        selected
            .iter()
            .map(|task| task.task_id.as_str())
            .collect::<Vec<_>>(),
        vec!["first"]
    );
}

#[test]
fn scheduler_serializes_all_writers_in_one_environment() {
    let tasks = vec![
        task(
            "broad",
            0,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src"],
            "repo",
        ),
        task(
            "narrow",
            1,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src/core"],
            "repo",
        ),
        task(
            "independent",
            2,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["tests"],
            "repo",
        ),
    ];
    let selected = select_ready_tasks(tasks.as_slice(), 3);
    assert_eq!(
        selected
            .iter()
            .map(|task| task.task_id.as_str())
            .collect::<Vec<_>>(),
        vec!["broad"]
    );
}

#[test]
fn scheduler_conservatively_serializes_case_variant_scopes() {
    let tasks = vec![
        task(
            "first",
            0,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src/Core"],
            "repo",
        ),
        task(
            "second",
            1,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src/core"],
            "repo",
        ),
    ];
    assert_eq!(select_ready_tasks(tasks.as_slice(), 2).len(), 1);
}

#[test]
fn isolated_environments_can_use_the_same_scope_in_parallel() {
    let tasks = vec![
        task(
            "one",
            0,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src"],
            "worktree-one",
        ),
        task(
            "two",
            1,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src"],
            "worktree-two",
        ),
    ];
    assert_eq!(select_ready_tasks(tasks.as_slice(), 2).len(), 2);
}

#[test]
fn one_environment_never_runs_two_writable_tasks_concurrently() {
    let tasks = vec![
        task(
            "one",
            0,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src/one"],
            "shared-worktree",
        ),
        task(
            "two",
            1,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src/two"],
            "shared-worktree",
        ),
    ];
    assert_eq!(
        select_ready_tasks(tasks.as_slice(), 2).len(),
        1,
        "parallel writers in one worktree cannot be attributed safely even when scopes differ"
    );
}

#[test]
fn writable_graph_requires_an_independent_verification_task() {
    let args = RunAgentWorkGraphArgs {
        name: "missing verification gate".to_string(),
        tasks: vec![WorkTaskArgs {
            id: "implement".to_string(),
            kind: codex_state::WorkGraphTaskKind::Implement,
            title: "Implement".to_string(),
            instruction: "Change the requested behavior.".to_string(),
            depends_on: Vec::new(),
            write_scopes: vec!["src".to_string()],
            acceptance_criteria: vec!["focused check passes".to_string()],
            environment_id: Some("task-worktree".to_string()),
        }],
        max_concurrency: Some(1),
        max_runtime_seconds: Some(30),
    };
    let err = validate_runner_args(&args)
        .expect_err("a writable task without an independent verifier must be rejected");
    assert!(err.to_string().contains("verification"));
}

#[test]
fn report_scope_validation_rejects_out_of_scope_and_read_only_changes() {
    assert_eq!(
        changed_files_outside_scopes(
            &["src/core/lib.rs".to_string(), "docs/guide.md".to_string()],
            &["src/core".to_string()],
        )
        .expect("valid paths"),
        vec!["docs/guide.md"]
    );
    assert_eq!(
        changed_files_outside_scopes(&["src/lib.rs".to_string()], &[])
            .expect("valid read-only path"),
        vec!["src/lib.rs"]
    );
}

#[test]
fn repository_paths_cannot_escape() {
    let err = normalize_repo_path("../outside").expect_err("escaping path should fail");
    assert!(err.to_string().contains("invalid repository-relative path"));
    let err = normalize_repo_path(r"C:\outside").expect_err("drive path should fail");
    assert!(err.to_string().contains("invalid repository-relative path"));
    let err = normalize_repo_path(".git/config").expect_err("git metadata should fail");
    assert!(err.to_string().contains("invalid repository-relative path"));
}

#[test]
fn engine_snapshot_identifies_modified_created_and_deleted_files() {
    let workspace = tempfile::tempdir().expect("workspace");
    std::fs::create_dir(workspace.path().join("src")).expect("scope");
    std::fs::write(workspace.path().join("src/modified.rs"), "before").expect("seed modified");
    std::fs::write(workspace.path().join("src/deleted.rs"), "delete me").expect("seed deleted");
    let mut task = task(
        "measure",
        0,
        codex_state::WorkGraphTaskStatus::Running,
        &[],
        &["src"],
        "repo",
    );
    task.workspace_path = Some(workspace.path().display().to_string());
    let baseline = snapshot_task_scopes(&task).expect("baseline");

    std::fs::write(workspace.path().join("src/modified.rs"), "after").expect("modify");
    std::fs::write(workspace.path().join("src/created.rs"), "new").expect("create");
    std::fs::remove_file(workspace.path().join("src/deleted.rs")).expect("delete");

    let current = snapshot_task_scopes(&task).expect("current");
    assert_eq!(
        changed_paths(&baseline, &current).expect("changed paths"),
        BTreeSet::from([
            "src/created.rs".to_string(),
            "src/deleted.rs".to_string(),
            "src/modified.rs".to_string(),
        ])
    );
}

#[test]
fn worker_prompt_removes_graph_and_merge_authority() {
    let task = task(
        "safe",
        0,
        codex_state::WorkGraphTaskStatus::Pending,
        &[],
        &["src/safe"],
        "repo",
    );
    let prompt =
        build_worker_prompt(&task, std::slice::from_ref(&task)).expect("prompt should render");
    assert!(prompt.contains("Do not merge, rebase, push"));
    assert!(prompt.contains("Do not delegate or spawn another agent"));
    assert!(prompt.contains("report_agent_work_task"));
}

#[test]
fn worker_permission_profile_hard_limits_writes_to_declared_scopes() {
    let cwd = AbsolutePathBuf::from_absolute_path("/tmp/work-graph").expect("absolute test path");
    let profile = scoped_permission_profile(
        &cwd,
        &["src/core".to_string(), "tests/focused.rs".to_string()],
        &PermissionProfile::Disabled,
    )
    .expect("profile");
    let PermissionProfile::Managed { file_system, .. } = profile else {
        panic!("expected managed profile");
    };
    let ManagedFileSystemPermissions::Restricted { entries, .. } = file_system else {
        panic!("expected restricted filesystem");
    };
    assert_eq!(entries[0].access, FileSystemAccessMode::Read);
    assert_eq!(
        entries[1].path,
        FileSystemPath::Path {
            path: cwd.join("src/core")
        }
    );
    assert_eq!(entries[1].access, FileSystemAccessMode::Write);
    assert_eq!(
        entries[2].path,
        FileSystemPath::Path {
            path: cwd.join("tests/focused.rs")
        }
    );
}

#[test]
fn read_only_task_profile_contains_no_write_entry() {
    let cwd = AbsolutePathBuf::from_absolute_path("/tmp/work-graph").expect("absolute test path");
    let profile =
        scoped_permission_profile(&cwd, &[], &PermissionProfile::Disabled).expect("profile");
    let PermissionProfile::Managed { file_system, .. } = profile else {
        panic!("expected managed profile");
    };
    let ManagedFileSystemPermissions::Restricted { entries, .. } = file_system else {
        panic!("expected restricted filesystem");
    };
    assert!(entries.iter().all(|entry| !entry.access.can_write()));
}

#[test]
fn child_profile_cannot_broaden_parent_write_or_read_denials() {
    let cwd = AbsolutePathBuf::from_absolute_path("/tmp/work-graph").expect("absolute test path");
    let secret = cwd.join("secret");
    let parent = PermissionProfile::Managed {
        file_system: ManagedFileSystemPermissions::Restricted {
            entries: vec![
                FileSystemSandboxEntry {
                    path: FileSystemPath::Special {
                        value: FileSystemSpecialPath::Root,
                    },
                    access: FileSystemAccessMode::Read,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Path {
                        path: cwd.join("src"),
                    },
                    access: FileSystemAccessMode::Write,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Path {
                        path: secret.clone(),
                    },
                    access: FileSystemAccessMode::Deny,
                },
            ],
            glob_scan_max_depth: None,
        },
        network: codex_protocol::permissions::NetworkSandboxPolicy::Restricted,
    };
    let profile = scoped_permission_profile(&cwd, &["src/core".to_string()], &parent)
        .expect("narrow child scope");
    let PermissionProfile::Managed { file_system, .. } = profile else {
        panic!("expected managed profile");
    };
    let policy = file_system.to_sandbox_policy();
    assert!(policy.can_write_path_with_cwd(cwd.join("src/core").as_path(), cwd.as_path()));
    assert!(!policy.can_write_path_with_cwd(cwd.join("tests").as_path(), cwd.as_path()));
    assert!(!policy.can_read_path_with_cwd(secret.as_path(), cwd.as_path()));
    assert!(scoped_permission_profile(&cwd, &["tests".to_string()], &parent).is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_scope_cannot_escape_selected_workspace() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("workspace");
    let outside = temp.path().join("outside");
    std::fs::create_dir_all(&workspace).expect("workspace");
    std::fs::create_dir_all(&outside).expect("outside");
    symlink(&outside, workspace.join("link")).expect("symlink");
    let cwd = AbsolutePathBuf::from_absolute_path(&workspace).expect("absolute workspace");
    let err = validate_scope_resolution(&cwd, &["link/generated".to_string()])
        .expect_err("symlink escape should fail");
    assert!(err.to_string().contains("outside the selected workspace"));
}

#[test]
fn write_scope_rejects_a_file_mount_target() {
    let workspace = tempfile::tempdir().expect("workspace");
    std::fs::write(workspace.path().join("focused.rs"), "before").expect("fixture");
    let cwd = AbsolutePathBuf::from_absolute_path(workspace.path()).expect("absolute workspace");

    let err = validate_scope_resolution(&cwd, &["focused.rs".to_string()])
        .expect_err("bubblewrap writable roots must be directories");

    assert!(err.to_string().contains("must be an existing directory"));
}
