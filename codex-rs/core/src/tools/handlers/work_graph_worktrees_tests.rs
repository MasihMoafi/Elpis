use super::*;
use chrono::Utc;
use codex_state::WorkGraphTaskKind as Kind;
use codex_state::WorkGraphTaskStatus as Status;
use pretty_assertions::assert_eq;
use std::process::Command;

fn args(id: &str, kind: Kind, depends_on: &[&str], scopes: &[&str]) -> WorkTaskArgs {
    WorkTaskArgs {
        id: id.to_string(),
        kind,
        title: format!("{id} title"),
        instruction: format!("Do {id}"),
        provider: None,
        model: None,
        reasoning_effort: None,
        depends_on: depends_on
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        write_scopes: scopes.iter().map(|value| (*value).to_string()).collect(),
        acceptance_criteria: vec!["checked".to_string()],
        environment_id: None,
    }
}

fn state_task(id: &str, kind: Kind, dependencies: &[&str], status: Status) -> WorkGraphTask {
    let now = Utc::now();
    WorkGraphTask {
        graph_id: "g-1".to_string(),
        task_id: id.to_string(),
        ordinal: 0,
        title: format!("{id} title"),
        instruction: format!("Do {id}"),
        provider: None,
        model: None,
        kind,
        status,
        dependencies: dependencies
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        write_scopes: Vec::new(),
        acceptance_criteria: vec!["checked".to_string()],
        environment_id: None,
        workspace_path: None,
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

/// Two parallel writers (`left` edits `a`, `right` edits `b`), each with its verifier, and a
/// `join` fix task that builds on both.
fn diamond(status: Status) -> Vec<WorkGraphTask> {
    let mut tasks = vec![
        state_task("left", Kind::Implement, &[], status),
        state_task("verify-left", Kind::Verify, &["left"], status),
        state_task("right", Kind::Implement, &[], status),
        state_task("verify-right", Kind::Verify, &["right"], status),
        state_task(
            "join",
            Kind::Fix,
            &["verify-left", "verify-right"],
            Status::Pending,
        ),
        state_task("verify-join", Kind::Verify, &["join"], Status::Pending),
    ];
    for (ordinal, task) in tasks.iter_mut().enumerate() {
        task.ordinal = ordinal as i64;
    }
    tasks
}

fn diamond_args() -> Vec<WorkTaskArgs> {
    vec![
        args("left", Kind::Implement, &[], &["a"]),
        args("verify-left", Kind::Verify, &["left"], &[]),
        args("right", Kind::Implement, &[], &["b"]),
        args("verify-right", Kind::Verify, &["right"], &[]),
        args("join", Kind::Fix, &["verify-left", "verify-right"], &["a"]),
        args("verify-join", Kind::Verify, &["join"], &[]),
    ]
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@localhost",
        ])
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("utf-8 git output")
        .trim()
        .to_string()
}

/// A temporary folder holding `repo/` (one commit on `main`) and room for `worktrees/`.
fn fixture_repo(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().expect("temporary folder");
    let repo = dunce::canonicalize(temp.path())
        .expect("canonical temporary folder")
        .join("repo");
    std::fs::create_dir(&repo).expect("repository folder");
    git(&repo, &["init", "-q", "-b", "main"]);
    for (path, contents) in files {
        write(&repo, path, contents);
    }
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "initial"]);
    (temp, repo)
}

fn write(root: &Path, path: &str, contents: &str) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("parent folder");
    std::fs::write(path, contents).expect("write fixture file");
}

fn read(root: &Path, path: &str) -> String {
    std::fs::read_to_string(root.join(path)).expect("read fixture file")
}

fn isolation(repo: &Path, tasks: &[WorkTaskArgs]) -> WorktreeIsolation {
    let root = repo.parent().expect("temporary folder").join("worktrees");
    WorktreeIsolation::plan("g-1", repo, Some(root.as_path()), tasks)
        .expect("plan")
        .expect("the graph has writers")
}

fn worktree(isolation: &WorktreeIsolation, task_id: &str) -> PathBuf {
    isolation
        .task_cwd(task_id)
        .expect("task runs in a worktree")
        .as_path()
        .to_path_buf()
}

fn succeed(tasks: &mut [WorkGraphTask], ids: &[&str]) {
    for task in tasks.iter_mut() {
        if ids.contains(&task.task_id.as_str()) {
            task.status = Status::Succeeded;
        }
    }
}

fn find<'a>(tasks: &'a [WorkGraphTask], id: &str) -> &'a WorkGraphTask {
    tasks
        .iter()
        .find(|task| task.task_id == id)
        .expect("fixture task")
}

#[test]
fn worktrees_are_folders_named_after_the_repository_graph_and_task() {
    assert_eq!(
        graph_dir(Path::new("/src/p"), "Elpis", "g-1"),
        PathBuf::from("/src/p/Elpis-elpis/g-1")
    );
    assert_eq!(branch_name("g-1", "left"), "elpis/g-1/left");
}

#[test]
fn a_writer_and_its_verifier_share_a_worktree_beside_the_repository() {
    let (temp, repo) = fixture_repo(&[("src/lib.rs", "one\n")]);
    let tasks = [
        args("left", Kind::Implement, &[], &["x"]),
        args("verify-left", Kind::Verify, &["left"], &[]),
        args("look", Kind::Explore, &[], &[]),
    ];
    let isolation = WorktreeIsolation::plan("g-1", &repo.join("src"), None, &tasks)
        .expect("plan")
        .expect("the graph has writers");
    let expected = dunce::canonicalize(temp.path())
        .expect("canonical temporary folder")
        .join("repo-elpis/g-1/left/src");
    assert_eq!(worktree(&isolation, "left"), expected);
    assert_eq!(worktree(&isolation, "verify-left"), expected);
    assert_eq!(isolation.task_cwd("look"), None);
}

#[test]
fn isolation_is_refused_for_a_verifier_of_two_writers_or_a_folder_outside_git() {
    let (temp, repo) = fixture_repo(&[("a/one.txt", "a\n")]);
    let shared_verifier = [
        args("left", Kind::Implement, &[], &["a"]),
        args("right", Kind::Implement, &[], &["a"]),
        args("verify", Kind::Verify, &["left", "right"], &[]),
    ];
    let error = WorktreeIsolation::plan("g-1", &repo, None, &shared_verifier)
        .expect_err("a verifier cannot share two worktrees");
    assert!(error.to_string().contains("exactly one"), "{error}");

    let outside = temp.path().join("plain");
    std::fs::create_dir(&outside).expect("plain folder");
    let error = WorktreeIsolation::plan("g-1", &outside, None, &diamond_args())
        .expect_err("worktrees need a git repository");
    assert!(error.to_string().contains("git repository"), "{error}");
}

#[test]
fn a_writer_builds_on_the_nearest_writers_through_read_only_tasks() {
    let tasks = diamond(Status::Pending);
    assert_eq!(writer_bases("left", &tasks), Vec::<String>::new());
    assert_eq!(writer_bases("verify-join", &tasks), vec!["join"]);
    assert_eq!(writer_bases("join", &tasks), vec!["left", "right"]);
}

#[test]
fn only_writers_no_other_writer_builds_on_are_merged() {
    let tasks = diamond(Status::Pending);
    assert_eq!(leaf_writers(&tasks), vec!["join"]);
    assert_eq!(leaf_writers(&tasks[..4]), vec!["left", "right"]);
}

#[test]
fn git_path_lists_are_read_from_nul_separated_output() {
    assert_eq!(
        nul_separated(b"a.txt\0dir/b c.txt\0"),
        vec!["a.txt", "dir/b c.txt"]
    );
    assert_eq!(
        status_paths(b" M a.txt\0?? new dir/n.txt\0R  moved.txt\0old.txt\0"),
        BTreeSet::from([
            "a.txt".to_string(),
            "moved.txt".to_string(),
            "new dir/n.txt".to_string(),
            "old.txt".to_string(),
        ])
    );
}

#[test]
fn a_writer_that_builds_on_two_writers_starts_from_a_merge_of_their_commits() {
    let (_temp, repo) = fixture_repo(&[("a/one.txt", "a\n"), ("b/two.txt", "b\n")]);
    let isolation = isolation(&repo, &diamond_args());
    let mut tasks = diamond(Status::Running);
    isolation
        .create_writer_worktree(find(&tasks, "left"), &tasks)
        .expect("left worktree");
    isolation
        .create_writer_worktree(find(&tasks, "right"), &tasks)
        .expect("right worktree");
    write(&worktree(&isolation, "left"), "a/one.txt", "left\n");
    write(&worktree(&isolation, "right"), "b/two.txt", "right\n");
    succeed(
        &mut tasks,
        &["left", "verify-left", "right", "verify-right"],
    );
    isolation
        .commit_verified_writers(&tasks)
        .expect("verified writers commit");
    assert_eq!(
        git(&repo, &["log", "-1", "--format=%an|%s", "elpis/g-1/left"]),
        "Elpis agent|left title"
    );

    isolation
        .create_writer_worktree(find(&tasks, "join"), &tasks)
        .expect("join worktree");
    let join = worktree(&isolation, "join");
    assert_eq!(read(&join, "a/one.txt"), "left\n");
    assert_eq!(read(&join, "b/two.txt"), "right\n");
    assert_eq!(git(&join, &["branch", "--show-current"]), "elpis/g-1/join");
}

#[test]
fn conflicting_writer_bases_fail_with_the_clashing_files_and_keep_the_worktree() {
    let (_temp, repo) = fixture_repo(&[("a/notes.txt", "shared\n")]);
    let isolation = isolation(&repo, &diamond_args());
    let mut tasks = diamond(Status::Running);
    for (writer, text) in [("left", "left\n"), ("right", "right\n")] {
        isolation
            .create_writer_worktree(find(&tasks, writer), &tasks)
            .expect("writer worktree");
        write(&worktree(&isolation, writer), "a/notes.txt", text);
    }
    succeed(
        &mut tasks,
        &["left", "verify-left", "right", "verify-right"],
    );
    isolation
        .commit_verified_writers(&tasks)
        .expect("verified writers commit");

    let error = isolation
        .create_writer_worktree(find(&tasks, "join"), &tasks)
        .expect_err("the bases clash");
    assert!(error.contains("a/notes.txt"), "{error}");
    let join = worktree(&isolation, "join");
    assert!(error.contains(join.to_string_lossy().as_ref()), "{error}");
    assert!(
        join.exists(),
        "the clashing worktree is kept for inspection"
    );
    let report = isolation.release_after_stop();
    assert!(
        report.contains("a/notes.txt"),
        "the failed graph's message names the clash: {report}"
    );
    assert!(join.exists(), "a stopped run keeps the clashing worktree");
}

fn parallel_args() -> Vec<WorkTaskArgs> {
    diamond_args().into_iter().take(4).collect()
}

/// `left` and `right` ran, were verified, and wrote `left_file` and `right_file`.
fn parallel_run(
    files: &[(&str, &str)],
    left: (&str, &str),
    right: (&str, &str),
) -> (
    tempfile::TempDir,
    PathBuf,
    WorktreeIsolation,
    Vec<WorkGraphTask>,
) {
    let (temp, repo) = fixture_repo(files);
    let isolation = isolation(&repo, &parallel_args());
    let mut tasks = diamond(Status::Running);
    tasks.truncate(4);
    for (writer, (path, text)) in [("left", left), ("right", right)] {
        isolation
            .create_writer_worktree(find(&tasks, writer), &tasks)
            .expect("writer worktree");
        write(&worktree(&isolation, writer), path, text);
    }
    succeed(
        &mut tasks,
        &["left", "verify-left", "right", "verify-right"],
    );
    isolation
        .commit_verified_writers(&tasks)
        .expect("verified writers commit");
    (temp, repo, isolation, tasks)
}

#[test]
fn verified_results_merge_into_the_checked_out_branch_and_their_worktrees_go() {
    let (_temp, repo, isolation, tasks) = parallel_run(
        &[("a/one.txt", "a\n"), ("b/two.txt", "b\n")],
        ("a/one.txt", "left\n"),
        ("b/two.txt", "right\n"),
    );
    let report = isolation.merge_into_root(&tasks).expect("clean merge");
    assert_eq!(git(&repo, &["show", "HEAD:a/one.txt"]), "left");
    assert_eq!(git(&repo, &["show", "HEAD:b/two.txt"]), "right");
    assert_eq!(git(&repo, &["branch", "--show-current"]), "main");
    assert_eq!(
        git(&repo, &["log", "--merges", "--format=%s", "main"]),
        "Merge elpis/g-1/right\nMerge elpis/g-1/left"
    );
    assert_eq!(git(&repo, &["branch", "--list", "elpis/*"]), "");
    assert!(!worktree(&isolation, "left").exists());
    assert!(!worktree(&isolation, "right").exists());
    for expected in ["main", "elpis/g-1/left", "elpis/g-1/right"] {
        assert!(
            report.contains(expected),
            "{expected} missing from: {report}"
        );
    }
}

#[test]
fn a_clash_between_results_leaves_the_branch_untouched_and_keeps_the_work() {
    let (_temp, repo, isolation, tasks) = parallel_run(
        &[("a/notes.txt", "shared\n")],
        ("a/notes.txt", "left\n"),
        ("a/notes.txt", "right\n"),
    );
    let before = git(&repo, &["rev-parse", "HEAD"]);
    let report = isolation
        .merge_into_root(&tasks)
        .expect_err("results clash");
    assert!(report.contains("a/notes.txt"), "{report}");
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), before);
    assert_eq!(git(&repo, &["status", "--porcelain"]), "");
    assert_eq!(
        git(
            &repo,
            &["branch", "--list", "--format=%(refname:short)", "elpis/*"]
        ),
        "elpis/g-1/left\nelpis/g-1/right"
    );
    assert!(worktree(&isolation, "left").exists());
    assert!(worktree(&isolation, "right").exists());
}

#[test]
fn uncommitted_root_changes_in_merged_files_stop_the_merge_untouched() {
    let (_temp, repo, isolation, tasks) = parallel_run(
        &[("a/one.txt", "a\n"), ("b/two.txt", "b\n")],
        ("a/one.txt", "left\n"),
        ("b/two.txt", "right\n"),
    );
    write(&repo, "a/one.txt", "uncommitted\n");
    let before = git(&repo, &["rev-parse", "HEAD"]);
    let report = isolation
        .merge_into_root(&tasks)
        .expect_err("dirty root file");
    assert!(report.contains("a/one.txt"), "{report}");
    assert!(!report.contains("b/two.txt"), "{report}");
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), before);
    assert_eq!(read(&repo, "a/one.txt"), "uncommitted\n");
    assert!(worktree(&isolation, "left").exists());
}

#[test]
fn a_stopped_run_removes_unchanged_worktrees_and_keeps_changed_ones() {
    let (_temp, repo) = fixture_repo(&[("a/one.txt", "a\n"), ("b/two.txt", "b\n")]);
    let isolation = isolation(&repo, &parallel_args());
    let tasks = diamond(Status::Running);
    for writer in ["left", "right"] {
        isolation
            .create_writer_worktree(find(&tasks, writer), &tasks)
            .expect("writer worktree");
    }
    write(&worktree(&isolation, "left"), "a/one.txt", "unfinished\n");

    let report = isolation.release_after_stop();
    let left = worktree(&isolation, "left");
    assert_eq!(read(&left, "a/one.txt"), "unfinished\n");
    assert!(!worktree(&isolation, "right").exists());
    assert_eq!(
        git(
            &repo,
            &["branch", "--list", "--format=%(refname:short)", "elpis/*"]
        ),
        "elpis/g-1/left"
    );
    assert!(report.contains(left.to_string_lossy().as_ref()), "{report}");
    assert!(report.contains("elpis/g-1/left"), "{report}");
}
