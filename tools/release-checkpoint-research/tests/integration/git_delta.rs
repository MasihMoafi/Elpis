use release_checkpoint_research::{
    collect_git_delta, collect_local_release_evidence, select_release_baseline,
    serialize_deterministically, Availability, BaselineDecision, ChangedPathStatus, DeltaReport,
    FullId,
};
use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct TempRepo {
    root: PathBuf,
}

impl TempRepo {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "release-checkpoint-delta-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create temporary repository");
        let repo = Self { root };
        repo.git(&["init", "-q"]);
        repo.git(&["config", "user.email", "delta@example.invalid"]);
        repo.git(&["config", "user.name", "Delta Test"]);
        repo.git(&["branch", "-M", "main"]);
        repo
    }

    fn path(&self) -> &Path {
        &self.root
    }

    fn git(&self, args: &[&str]) {
        self.run_git(args, &[]);
    }

    fn git_env(&self, args: &[&str], environment: &[(&str, &str)]) {
        self.run_git(args, environment);
    }

    fn run_git(&self, args: &[&str], environment: &[(&str, &str)]) {
        let mut command = Command::new("git");
        command.args(args).current_dir(&self.root);
        for (name, value) in environment {
            command.env(name, value);
        }
        let output = command.output().expect("run git fixture command");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn bytes(&self, args: &[&str]) -> Vec<u8> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .output()
            .expect("run git fixture query");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn head(&self) -> FullId {
        let text = String::from_utf8(self.bytes(&["rev-parse", "HEAD"])).expect("UTF-8 head ID");
        FullId::new(text.trim()).expect("full head ID")
    }

    fn commit(&self, subject: &str, date: &str) {
        self.git_env(
            &["commit", "-qm", subject],
            &[("GIT_AUTHOR_DATE", date), ("GIT_COMMITTER_DATE", date)],
        );
    }

    fn write(&self, path: &str, contents: &[u8]) {
        let path = self.root.join(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create fixture parent");
        }
        fs::write(path, contents).expect("write fixture file");
    }

    fn remove(&self, path: &str) {
        fs::remove_file(self.root.join(path)).expect("remove fixture file");
    }

    fn state_hash(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        for args in [
            &["rev-parse", "HEAD"][..],
            &["for-each-ref", "--format=%(refname)%00%(objectname)%00"][..],
            &["status", "--porcelain=v1", "-z", "--ignored"][..],
            &["diff", "--no-ext-diff", "--binary"][..],
            &["diff", "--cached", "--no-ext-diff", "--binary"][..],
            &["ls-files", "--stage", "-z"][..],
        ] {
            self.bytes(args).hash(&mut hasher);
        }
        hasher.finish()
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn selected_baseline(repo: &TempRepo) -> BaselineDecision {
    let evidence = collect_local_release_evidence(repo.path()).expect("collect baseline evidence");
    let decision = select_release_baseline(&evidence);
    assert!(
        decision.is_selected(),
        "expected selected baseline: {decision:?}"
    );
    decision
}

fn path_statuses(report: &DeltaReport) -> BTreeMap<String, ChangedPathStatus> {
    report
        .changed_paths()
        .iter()
        .map(|path| (path.path.as_str().to_owned(), path.status))
        .collect()
}

#[test]
fn selected_baseline_records_exact_boundaries_commits_paths_and_offsets() {
    let repo = TempRepo::new("fidelity");
    repo.write("keep.txt", b"before\n");
    repo.write("delete.txt", b"delete me\n");
    repo.write("rename-old [fixture].txt", b"rename me\n");
    repo.git(&["add", "."]);
    repo.commit("baseline subject exact", "2026-08-01T10:00:00+05:30");
    repo.git(&["tag", "v1.0.0"]);

    repo.write("first.txt", b"first\n");
    repo.git(&["add", "first.txt"]);
    repo.commit("first post-baseline subject", "2026-08-02T10:00:00+05:30");

    repo.write("keep.txt", b"after\n");
    repo.remove("delete.txt");
    repo.git(&["mv", "rename-old [fixture].txt", "rename-new [fixture].txt"]);
    repo.git(&["add", "-u"]);
    repo.commit("second post-baseline subject", "2026-08-03T10:00:00+05:30");

    repo.write("third.txt", b"third\n");
    repo.git(&["add", "third.txt"]);
    repo.commit("third post-baseline subject", "2026-08-04T10:00:00+05:30");

    let before = repo.state_hash();
    let decision = selected_baseline(&repo);
    let baseline = decision
        .baseline()
        .expect("selected baseline")
        .commit
        .clone();
    let current = repo.head();
    let report = collect_git_delta(repo.path(), &decision).expect("collect committed delta");
    let after = repo.state_hash();
    assert_eq!(
        before, after,
        "read-only collection changed the fixture state"
    );

    let compared = match &report {
        DeltaReport::Compared(value) => value,
        other => panic!("expected compared report, got {other:?}"),
    };
    assert_eq!(compared.range.baseline, baseline);
    assert_eq!(compared.range.current, current);
    assert!(compared.range.baseline_is_excluded());
    assert!(compared.range.current_is_included());
    assert_eq!(compared.commits.len(), 3);
    assert_eq!(
        compared
            .commits
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect::<Vec<_>>(),
        vec![
            "first post-baseline subject",
            "second post-baseline subject",
            "third post-baseline subject"
        ]
    );
    assert!(compared
        .commits
        .iter()
        .all(|commit| commit.commit.as_str().len() == 40));
    assert_eq!(
        compared.commits[0].committer_date.as_str(),
        "2026-08-02T10:00:00+05:30"
    );
    assert_eq!(
        compared.current.committer_date.as_str(),
        "2026-08-04T10:00:00+05:30"
    );
    assert_eq!(
        compared.current.subject.as_str(),
        "third post-baseline subject"
    );

    let statuses = path_statuses(&report);
    assert_eq!(statuses.get("first.txt"), Some(&ChangedPathStatus::Added));
    assert_eq!(statuses.get("keep.txt"), Some(&ChangedPathStatus::Modified));
    assert_eq!(
        statuses.get("delete.txt"),
        Some(&ChangedPathStatus::Deleted)
    );
    assert_eq!(
        statuses.get("rename-new [fixture].txt"),
        Some(&ChangedPathStatus::Renamed)
    );
    assert_eq!(statuses.get("third.txt"), Some(&ChangedPathStatus::Added));
    assert_eq!(statuses.len(), 5);
    let rename = report
        .changed_paths()
        .iter()
        .find(|path| path.status == ChangedPathStatus::Renamed)
        .expect("one rename record");
    assert_eq!(
        rename
            .old_path
            .as_ref()
            .present_ref()
            .expect("old rename path")
            .as_str(),
        "rename-old [fixture].txt"
    );
    assert_eq!(
        rename
            .new_path
            .as_ref()
            .present_ref()
            .expect("new rename path")
            .as_str(),
        "rename-new [fixture].txt"
    );
}

#[test]
fn equal_boundaries_produce_an_explicit_empty_delta() {
    let repo = TempRepo::new("empty-range");
    repo.write("README.md", b"empty range\n");
    repo.git(&["add", "README.md"]);
    repo.commit("only commit", "2026-08-01T00:00:00+00:00");
    repo.git(&["tag", "v1.0.0"]);

    let decision = selected_baseline(&repo);
    let report = collect_git_delta(repo.path(), &decision).expect("collect empty delta");
    let compared = report.comparison().expect("compared empty range");
    assert_eq!(compared.range.baseline, compared.range.current);
    assert!(compared.commits.is_empty());
    assert!(compared.changed_paths.is_empty());
}

#[test]
fn branched_merge_history_is_complete_and_ordered_by_committer_time() {
    let repo = TempRepo::new("merge");
    repo.write("base.txt", b"base\n");
    repo.git(&["add", "base.txt"]);
    repo.commit("merge baseline", "2026-08-01T00:00:00+00:00");
    repo.git(&["tag", "v1.0.0"]);

    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.write("feature.txt", b"feature\n");
    repo.git(&["add", "feature.txt"]);
    repo.commit("feature commit", "2026-08-02T00:00:00+00:00");

    repo.git(&["checkout", "-q", "main"]);
    repo.write("main.txt", b"main\n");
    repo.git(&["add", "main.txt"]);
    repo.commit("main commit", "2026-08-03T00:00:00+00:00");
    repo.git_env(
        &["merge", "--no-ff", "-qm", "merge commit", "feature"],
        &[
            ("GIT_AUTHOR_DATE", "2026-08-04T00:00:00+00:00"),
            ("GIT_COMMITTER_DATE", "2026-08-04T00:00:00+00:00"),
        ],
    );

    let report =
        collect_git_delta(repo.path(), &selected_baseline(&repo)).expect("collect merge delta");
    let subjects = report
        .commits()
        .iter()
        .map(|commit| commit.subject.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        subjects,
        vec!["feature commit", "main commit", "merge commit"]
    );
    assert_eq!(report.changed_paths().len(), 2);
}

#[test]
fn comparison_does_not_require_baseline_to_be_an_ancestor() {
    let repo = TempRepo::new("unrelated");
    repo.write("old.txt", b"old root\n");
    repo.git(&["add", "old.txt"]);
    repo.commit("baseline root", "2026-08-01T00:00:00+00:00");
    repo.git(&["tag", "v1.0.0"]);

    repo.git(&["checkout", "-q", "--orphan", "unrelated"]);
    repo.git(&["rm", "-q", "-rf", "."]);
    repo.write("new.txt", b"new root\n");
    repo.git(&["add", "new.txt"]);
    repo.commit("unrelated current root", "2026-08-02T00:00:00+00:00");

    let report = collect_git_delta(repo.path(), &selected_baseline(&repo))
        .expect("collect unrelated-root delta");
    assert_eq!(report.commits().len(), 1);
    assert_eq!(
        report.commits()[0].subject.as_str(),
        "unrelated current root"
    );
}

#[test]
fn no_baseline_returns_only_current_fallback_and_never_a_path_delta() {
    let repo = TempRepo::new("no-baseline");
    repo.write("README.md", b"no baseline\n");
    repo.git(&["add", "README.md"]);
    repo.commit("current subject exact", "2026-08-05T09:10:11-04:00");

    let before = repo.state_hash();
    let evidence = collect_local_release_evidence(repo.path()).expect("collect evidence");
    let decision = select_release_baseline(&evidence);
    assert!(matches!(decision, BaselineDecision::NoUnambiguous { .. }));
    let report = collect_git_delta(repo.path(), &decision).expect("collect fallback");
    assert_eq!(before, repo.state_hash());

    let fallback = match &report {
        DeltaReport::CurrentFallback(value) => value,
        other => panic!("expected current fallback, got {other:?}"),
    };
    assert!(fallback.reason.as_str().contains("baseline-to-current"));
    assert!(fallback.reason.as_str().contains("unavailable"));
    assert_eq!(fallback.current.commit, repo.head());
    assert_eq!(fallback.current.subject.as_str(), "current subject exact");
    assert_eq!(
        fallback.current.committer_date.as_str(),
        "2026-08-05T09:10:11-04:00"
    );
    assert!(report.range().is_none());
    assert!(report.commits().is_empty());
    assert!(report.changed_paths().is_empty());
    let serialized = serialize_deterministically(&report).expect("serialize fallback");
    assert!(serialized.contains("CurrentFallback"));
    assert!(!serialized.contains("changed_paths"));
}

#[test]
fn worktree_categories_overlap_only_by_observation_and_clean_ignores_ignored_files() {
    let repo = TempRepo::new("worktree-overlap");
    repo.write(".gitignore", b"ignored.log\n");
    repo.write("tracked.txt", b"base\n");
    repo.git(&["add", "."]);
    repo.commit("worktree baseline", "2026-08-01T00:00:00+00:00");

    repo.write("tracked.txt", b"staged\n");
    repo.git(&["add", "tracked.txt"]);
    repo.write("tracked.txt", b"unstaged\n");
    repo.write("untracked.txt", b"untracked\n");
    repo.write("ignored.log", b"ignored\n");

    let before = repo.state_hash();
    let evidence = collect_local_release_evidence(repo.path()).expect("collect worktree evidence");
    assert_eq!(before, repo.state_hash());
    let staged = match &evidence.worktree.staged {
        Availability::Present(entries) => entries,
        other => panic!("expected staged inventory, got {other:?}"),
    };
    let unstaged = match &evidence.worktree.unstaged {
        Availability::Present(entries) => entries,
        other => panic!("expected unstaged inventory, got {other:?}"),
    };
    assert!(staged
        .iter()
        .any(|entry| entry.path.as_str() == "tracked.txt"));
    assert!(unstaged
        .iter()
        .any(|entry| entry.path.as_str() == "tracked.txt"));
    assert!(evidence.worktree.is_clean() == false);
    assert!(matches!(
        evidence.worktree.clean_fact(),
        Availability::Present(false)
    ));
    assert!(matches!(
        &evidence.worktree.ignored,
        Availability::Present(entries) if entries.iter().any(|entry| entry.path.as_str() == "ignored.log")
    ));

    let ignored_only = TempRepo::new("ignored-only");
    ignored_only.write(".gitignore", b"ignored.log\n");
    ignored_only.write("tracked.txt", b"tracked\n");
    ignored_only.git(&["add", "."]);
    ignored_only.commit("clean baseline", "2026-08-01T00:00:00+00:00");
    ignored_only.write("ignored.log", b"ignored only\n");
    let ignored_evidence =
        collect_local_release_evidence(ignored_only.path()).expect("collect ignored-only evidence");
    assert!(ignored_evidence.worktree.is_clean());
    assert!(matches!(
        ignored_evidence.worktree.clean_fact(),
        Availability::Present(true)
    ));
}

trait AvailabilityPresentExt<T> {
    fn present_ref(&self) -> Option<&T>;
}

impl<T> AvailabilityPresentExt<T> for Availability<T> {
    fn present_ref(&self) -> Option<&T> {
        match self {
            Availability::Present(value) => Some(value),
            Availability::Empty | Availability::Unavailable => None,
        }
    }
}
