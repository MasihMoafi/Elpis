use super::*;
use chrono::Utc;
use codex_protocol::models::ManagedFileSystemPermissions;
use codex_protocol::models::PermissionProfile;
use codex_protocol::openai_models::ReasoningEffortPreset;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_utils_absolute_path::AbsolutePathBuf;
use pretty_assertions::assert_eq;

async fn provider_route_fixture() -> (Config, tempfile::TempDir) {
    let home = tempfile::tempdir().expect("temporary config home");
    let mut config = Config::load_default_with_cli_overrides_for_codex_home(
        home.path().to_path_buf(),
        Vec::new(),
    )
    .await
    .expect("default native config");
    config.model = Some("root-model".to_string());
    config.developer_instructions = Some("Preserve graph instructions".to_string());
    for id in ["root", "provider-a", "provider-b"] {
        config.model_providers.insert(
            id.to_string(),
            serde_json::from_value(serde_json::json!({
                "name": id,
                "base_url": format!("http://127.0.0.1:8123/{id}"),
                "wire_api": "responses",
                "requires_openai_auth": false,
                "experimental_bearer_token": format!("synthetic-{id}"),
            }))
            .expect("fixture provider"),
        );
    }
    config.model_provider_id = "root".to_string();
    config.model_provider = config.model_providers["root"].clone();
    (config, home)
}

#[tokio::test]
async fn task_provider_routes_preserve_independent_auth_and_inherited_config() {
    let (base, _home) = provider_route_fixture().await;
    let inherited = resolve_task_spawn_config(&base, None, None).expect("inherited route");
    assert_eq!(inherited.model.as_deref(), Some("root-model"));
    assert_eq!(inherited.model_provider, base.model_provider);
    let model_only =
        resolve_task_spawn_config(&base, None, Some("root/custom")).expect("model-only route");
    assert_eq!(model_only.model_provider_id, "root");
    assert_eq!(model_only.model_provider, base.model_provider);
    for id in ["provider-a", "provider-b"] {
        let selected = resolve_task_spawn_config(&base, Some(id), Some("custom/model"))
            .expect("configured native route");
        assert_eq!(selected.model_provider_id, id);
        assert_eq!(selected.model.as_deref(), Some("custom/model"));
        assert_eq!(selected.model_provider, base.model_providers[id]);
        assert_ne!(selected.model_provider, base.model_provider);
        assert_eq!(selected.developer_instructions, base.developer_instructions);
        assert_eq!(
            selected.permissions.permission_profile(),
            base.permissions.permission_profile()
        );
        assert_eq!(
            selected.config_layer_stack.requirements(),
            base.config_layer_stack.requirements()
        );
    }
}

#[tokio::test]
async fn task_provider_routes_reject_unknown_incomplete_and_subscription_routes() {
    let (base, _home) = provider_route_fixture().await;
    for (provider, model) in [
        (Some("provider-a"), None),
        (Some("unknown"), Some("custom/model")),
        (Some("claude"), Some("custom/model")),
        (Some("agy"), Some("custom/model")),
        (Some("antigravity"), Some("custom/model")),
        (Some("provider-a"), Some("Claude/opus")),
        (None, Some("agy/model")),
        (None, Some("antigravity/model")),
        (Some("provider-a"), Some("")),
        (Some("provider-a"), Some("bad model")),
        (Some(" provider-a"), Some("custom/model")),
    ] {
        assert!(resolve_task_spawn_config(&base, provider, model).is_err());
    }
}

#[tokio::test]
async fn task_provider_routes_retain_managed_provider_requirements() {
    let (mut base, _home) = provider_route_fixture().await;
    let mut requirements = base.config_layer_stack.requirements().clone();
    requirements.model_provider = Some(codex_config::Sourced::new(
        "root".to_string(),
        codex_config::RequirementSource::Unknown,
    ));
    base.config_layer_stack = codex_config::ConfigLayerStack::new(
        base.config_layer_stack
            .layers_low_to_high()
            .cloned()
            .collect(),
        requirements,
        base.config_layer_stack.requirements_toml().clone(),
    )
    .expect("managed config stack");
    assert!(resolve_task_spawn_config(&base, None, Some("another-root-model")).is_ok());
    let error = resolve_task_spawn_config(&base, Some("provider-a"), Some("custom/model"))
        .expect_err("managed provider cannot be overridden");
    assert!(
        error
            .to_string()
            .contains("managed policy requires model provider")
    );
}

fn model_offering(levels: &[ReasoningEffort], known: bool) -> ModelInfo {
    let mut info = codex_models_manager::model_info::model_info_from_slug("effort-model");
    info.used_fallback_model_metadata = !known;
    info.supported_reasoning_levels = levels
        .iter()
        .map(|effort| ReasoningEffortPreset {
            effort: effort.clone(),
            description: effort.to_string(),
        })
        .collect();
    info
}

#[test]
fn task_args_read_an_optional_reasoning_effort() {
    let args = |extra: Value| {
        let mut task = serde_json::json!({
            "id": "inspect", "kind": "explore", "title": "Inspect", "instruction": "Read",
        });
        task.as_object_mut()
            .expect("task object")
            .extend(extra.as_object().expect("extra object").clone());
        serde_json::from_value::<WorkTaskArgs>(task)
    };
    assert_eq!(
        args(serde_json::json!({"reasoning_effort": "high"}))
            .expect("effort")
            .reasoning_effort,
        Some(ReasoningEffort::High)
    );
    for inherited in [
        serde_json::json!({}),
        serde_json::json!({"reasoning_effort": null}),
    ] {
        assert_eq!(args(inherited).expect("task").reasoning_effort, None);
    }
    assert!(args(serde_json::json!({"reasoning_effort": ""})).is_err());
    assert!(args(serde_json::json!({"reasoning_effort": 3})).is_err());
}

#[tokio::test]
async fn task_reasoning_effort_reaches_the_worker_config_when_its_model_offers_it() {
    let (base, _home) = provider_route_fixture().await;
    let mut config = resolve_task_spawn_config(&base, None, Some("effort-model")).expect("route");
    let model = model_offering(&[ReasoningEffort::Low, ReasoningEffort::High], true);
    apply_task_reasoning_effort(&mut config, Some(&ReasoningEffort::High), &model)
        .expect("offered effort");
    assert_eq!(config.model_reasoning_effort, Some(ReasoningEffort::High));
}

#[tokio::test]
async fn task_reasoning_effort_the_model_lacks_is_refused_and_leaves_the_config_alone() {
    let (base, _home) = provider_route_fixture().await;
    let mut config = resolve_task_spawn_config(&base, None, Some("effort-model")).expect("route");
    let before = config.model_reasoning_effort.clone();
    let model = model_offering(&[ReasoningEffort::Low, ReasoningEffort::High], true);
    let error = apply_task_reasoning_effort(&mut config, Some(&ReasoningEffort::XHigh), &model)
        .expect_err("unsupported effort");
    for expected in ["xhigh", "effort-model", "low, high"] {
        assert!(error.contains(expected), "{expected} missing from: {error}");
    }
    assert_eq!(config.model_reasoning_effort, before);
}

#[tokio::test]
async fn task_without_a_reasoning_effort_inherits_the_coordinator_effort() {
    let (mut base, _home) = provider_route_fixture().await;
    base.model_reasoning_effort = Some(ReasoningEffort::Medium);
    let mut config = resolve_task_spawn_config(&base, None, Some("effort-model")).expect("route");
    let model = model_offering(&[ReasoningEffort::Low], true);
    apply_task_reasoning_effort(&mut config, None, &model).expect("nothing to apply");
    assert_eq!(config.model_reasoning_effort, Some(ReasoningEffort::Medium));
}

#[tokio::test]
async fn task_reasoning_effort_for_a_model_without_catalog_metadata_is_left_to_its_provider() {
    let (base, _home) = provider_route_fixture().await;
    let mut config = resolve_task_spawn_config(&base, None, Some("effort-model")).expect("route");
    let model = model_offering(&[], false);
    apply_task_reasoning_effort(&mut config, Some(&ReasoningEffort::High), &model)
        .expect("unknown model metadata cannot refuse");
    assert_eq!(config.model_reasoning_effort, Some(ReasoningEffort::High));
}

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
        provider: Some("fixture-provider".to_string()),
        model: Some("fixture-model".to_string()),
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
            provider: None,
            model: None,
            reasoning_effort: None,
            depends_on: Vec::new(),
            write_scopes: vec!["src".to_string()],
            acceptance_criteria: vec!["focused check passes".to_string()],
            environment_id: Some("task-worktree".to_string()),
        }],
        max_concurrency: Some(1),
        max_runtime_seconds: Some(30),
        isolation: None,
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
    for args in [
        vec!["init", "-q"],
        vec!["add", "src/modified.rs", "src/deleted.rs"],
    ] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(workspace.path())
            .output()
            .expect("git fixture");
        assert!(output.status.success());
    }
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
fn engine_snapshot_measures_changes_outside_write_scopes() {
    let workspace = tempfile::tempdir().expect("workspace");
    std::fs::create_dir(workspace.path().join("src")).expect("scope");
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
    std::fs::write(workspace.path().join("outside.txt"), "outside").expect("outside change");
    let current = snapshot_task_scopes(&task).expect("current");
    assert_eq!(
        changed_paths(&baseline, &current).expect("changes"),
        BTreeSet::from(["outside.txt".to_string()])
    );
}

#[test]
fn engine_snapshot_does_not_count_git_ignored_files() {
    let workspace = tempfile::tempdir().expect("workspace");
    let output = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(workspace.path())
        .output()
        .expect("git init");
    assert!(output.status.success());
    std::fs::create_dir_all(workspace.path().join("src/__pycache__")).expect("scope");
    std::fs::write(workspace.path().join(".gitignore"), "__pycache__/\n").expect("ignore rules");
    std::fs::write(workspace.path().join("src/__pycache__/old.pyc"), "before").expect("old cache");
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
    assert!(baseline.get("src/__pycache__/old.pyc").is_none());
    assert!(
        baseline
            .as_object()
            .expect("snapshot")
            .keys()
            .all(|path| !path.starts_with(".git/"))
    );
    std::fs::write(workspace.path().join("src/__pycache__/old.pyc"), "after")
        .expect("modify cache");
    std::fs::write(workspace.path().join("src/__pycache__/new.pyc"), "new").expect("create cache");
    std::fs::write(workspace.path().join("src/calc.py"), "source").expect("source change");
    let current = snapshot_task_scopes(&task).expect("current");
    assert_eq!(
        changed_paths(&baseline, &current).expect("changes"),
        BTreeSet::from(["src/calc.py".to_string()])
    );
}

#[test]
fn engine_snapshot_uses_paths_relative_to_selected_workspace() {
    let repo = tempfile::tempdir().expect("repo");
    let workspace = repo.path().join("app");
    std::fs::create_dir_all(workspace.join("src")).expect("scope");
    std::fs::write(workspace.join("src/calc.py"), "before").expect("source");
    std::fs::write(repo.path().join("sibling.txt"), "outside workspace").expect("sibling");
    for args in [
        vec!["init", "-q"],
        vec!["add", "app/src/calc.py", "sibling.txt"],
    ] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(repo.path())
            .output()
            .expect("git fixture");
        assert!(output.status.success());
    }
    let mut task = task(
        "measure",
        0,
        codex_state::WorkGraphTaskStatus::Running,
        &[],
        &["src"],
        "repo",
    );
    task.workspace_path = Some(workspace.display().to_string());
    let baseline = snapshot_task_scopes(&task).expect("baseline");
    assert_eq!(
        baseline
            .as_object()
            .expect("snapshot")
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        vec!["src/calc.py"]
    );
    std::fs::write(workspace.join("src/calc.py"), "after").expect("modify source");
    let current = snapshot_task_scopes(&task).expect("current");
    assert_eq!(
        changed_paths(&baseline, &current).expect("changes"),
        BTreeSet::from(["src/calc.py".to_string()])
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
            path: cwd.join("src/core").into()
        }
    );
    assert_eq!(entries[1].access, FileSystemAccessMode::Write);
    assert_eq!(
        entries[2].path,
        FileSystemPath::Path {
            path: cwd.join("tests/focused.rs").into()
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
                    missing_path_behavior: None,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Path {
                        path: cwd.join("src").into(),
                    },
                    access: FileSystemAccessMode::Write,
                    missing_path_behavior: None,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Path {
                        path: secret.clone().into(),
                    },
                    access: FileSystemAccessMode::Deny,
                    missing_path_behavior: None,
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
    let cwd_uri = codex_utils_path_uri::PathUri::from_abs_path(&cwd);
    let context = codex_protocol::permissions::FileSystemSandboxPolicyContext {
        cwd: &cwd_uri,
        workspace_roots: std::slice::from_ref(&cwd_uri),
        user_home_dir: None,
        temporary_directories: None,
    };
    let uri = |path: AbsolutePathBuf| codex_utils_path_uri::PathUri::from_abs_path(&path);
    assert!(policy.can_write_path(&uri(cwd.join("src/core")), &context));
    assert!(!policy.can_write_path(&uri(cwd.join("tests")), &context));
    assert!(!policy.can_read_local_path_with_cwd(secret.as_path(), cwd.as_path()));
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

#[test]
fn isolated_writers_in_one_environment_run_in_parallel() {
    let mut tasks = vec![
        task(
            "left",
            0,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src"],
            "repo",
        ),
        task(
            "right",
            1,
            codex_state::WorkGraphTaskStatus::Pending,
            &[],
            &["src"],
            "repo",
        ),
    ];
    tasks[0].workspace_path = Some("/tmp/repo-elpis/graph-1/left".to_string());
    tasks[1].workspace_path = Some("/tmp/repo-elpis/graph-1/right".to_string());
    assert_eq!(
        select_ready_tasks(tasks.as_slice(), 2).len(),
        2,
        "writers in their own worktrees cannot touch each other's files"
    );
}

#[test]
fn a_task_workspace_is_recorded_as_a_native_path() {
    let cwd = AbsolutePathBuf::from_absolute_path("/tmp/work graph/repo").expect("absolute path");
    assert_eq!(
        native_workspace_path(&PathUri::from_abs_path(&cwd)),
        "/tmp/work graph/repo",
        "scope snapshots read this path from disk; a file: URI matches nothing"
    );
}
