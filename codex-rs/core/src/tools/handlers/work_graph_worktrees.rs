//! Elpis: `isolation: "worktree"` for work graphs. Each implement/fix task works in its own git
//! worktree, a sibling folder of the repository (`<repo>-elpis/<graph>/<task>`, or the same path
//! under the desktop's `desktop.git-worktree-root`), and its verify task checks that worktree. A
//! verified result is committed on `elpis/<graph>/<task>`. When the whole graph has succeeded the
//! results are merged into the checked-out branch; a clash, or an uncommitted change in a file the
//! merge would touch, leaves that branch untouched. A stopped run removes only unchanged
//! worktrees and names the ones it keeps, so an agent's work is never discarded silently.

use super::WorkTaskArgs;
use anyhow::Context;
use anyhow::anyhow;
use anyhow::bail;
use codex_state::WorkGraphTask;
use codex_state::WorkGraphTaskKind;
use codex_state::WorkGraphTaskStatus;
use codex_utils_absolute_path::AbsolutePathBuf;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;

const AGENT_NAME: &str = "Elpis agent";
const AGENT_EMAIL: &str = "elpis-agent@localhost";
/// Scratch worktree in which results are merged before the checked-out branch moves. Task IDs
/// cannot start with a dot, so it never takes a task's folder.
const MERGE_DIR: &str = ".merge";

pub(crate) fn graph_dir(base: &Path, repo_name: &str, graph_id: &str) -> PathBuf {
    base.join(format!("{repo_name}-elpis")).join(graph_id)
}

pub(crate) fn branch_name(graph_id: &str, task_id: &str) -> String {
    format!("elpis/{graph_id}/{task_id}")
}

/// The writers a task builds on: its nearest implement/fix ancestors, reached through read-only
/// tasks, in declared order.
pub(crate) fn writer_bases(task_id: &str, tasks: &[WorkGraphTask]) -> Vec<String> {
    let by_id: BTreeMap<&str, &WorkGraphTask> = tasks
        .iter()
        .map(|task| (task.task_id.as_str(), task))
        .collect();
    let mut pending: Vec<&str> = by_id
        .get(task_id)
        .map(|task| task.dependencies.iter().map(String::as_str).collect())
        .unwrap_or_default();
    let mut seen = BTreeSet::new();
    let mut bases = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        let Some(task) = by_id.get(id) else {
            continue;
        };
        if task.kind.is_writable() {
            bases.insert(id);
        } else {
            pending.extend(task.dependencies.iter().map(String::as_str));
        }
    }
    tasks
        .iter()
        .filter(|task| bases.contains(task.task_id.as_str()))
        .map(|task| task.task_id.clone())
        .collect()
}

/// The writers no other writer builds on. Their commits contain every other result.
pub(crate) fn leaf_writers(tasks: &[WorkGraphTask]) -> Vec<String> {
    let built_on: BTreeSet<String> = tasks
        .iter()
        .filter(|task| task.kind.is_writable())
        .flat_map(|task| writer_bases(task.task_id.as_str(), tasks))
        .collect();
    tasks
        .iter()
        .filter(|task| task.kind.is_writable() && !built_on.contains(&task.task_id))
        .map(|task| task.task_id.clone())
        .collect()
}

fn nul_separated(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect()
}

/// The paths `git status --porcelain -z` names, both sides of a rename or copy included.
fn status_paths(porcelain: &[u8]) -> BTreeSet<String> {
    let mut paths = BTreeSet::new();
    let mut entries = porcelain
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty());
    while let Some(entry) = entries.next() {
        let Some(path) = entry.get(3..) else {
            continue;
        };
        paths.insert(String::from_utf8_lossy(path).into_owned());
        if entry[..2]
            .iter()
            .any(|status| matches!(status, b'R' | b'C'))
            && let Some(source) = entries.next()
        {
            paths.insert(String::from_utf8_lossy(source).into_owned());
        }
    }
    paths
}

#[derive(Debug)]
pub(crate) struct WorktreeIsolation {
    graph_id: String,
    repo_root: PathBuf,
    /// The selected environment's cwd inside the repository; every worktree uses the same one.
    relative_cwd: PathBuf,
    graph_dir: PathBuf,
    /// The commit every writer without writer prerequisites starts from.
    start_head: String,
    /// Every task that runs in a worktree, with the writer that owns the worktree.
    owners: BTreeMap<String, String>,
    /// Writers in declared order.
    writers: Vec<String>,
    state: Mutex<IsolationState>,
}

#[derive(Debug, Default)]
struct IsolationState {
    /// The commit each created worktree started from.
    bases: BTreeMap<String, String>,
    committed: BTreeSet<String>,
    /// Writers whose prerequisites' results clashed, each with the clashing files.
    clashes: Vec<String>,
}

impl WorktreeIsolation {
    /// Plans one worktree per writer for the repository holding `cwd`. `None` when the graph has
    /// no writer, so there is nothing to isolate.
    pub(crate) fn plan(
        graph_id: &str,
        cwd: &Path,
        configured_root: Option<&Path>,
        tasks: &[WorkTaskArgs],
    ) -> anyhow::Result<Option<Self>> {
        let writers: Vec<&WorkTaskArgs> = tasks
            .iter()
            .filter(|task| task.kind.is_writable())
            .collect();
        let Some(first) = writers.first() else {
            return Ok(None);
        };
        if writers
            .iter()
            .any(|writer| writer.environment_id != first.environment_id)
        {
            bail!("worktree isolation needs every implement and fix task in one environment");
        }
        let mut owners: BTreeMap<String, String> = writers
            .iter()
            .map(|writer| (writer.id.clone(), writer.id.clone()))
            .collect();
        for verifier in tasks
            .iter()
            .filter(|task| task.kind == WorkGraphTaskKind::Verify)
        {
            let checked: Vec<&String> = verifier
                .depends_on
                .iter()
                .filter(|dependency| writers.iter().any(|writer| &writer.id == *dependency))
                .collect();
            let [writer] = checked.as_slice() else {
                bail!(
                    "with worktree isolation, verify task `{}` must depend directly on exactly one implement or fix task, whose worktree it checks",
                    verifier.id
                );
            };
            owners.insert(verifier.id.clone(), (*writer).clone());
        }

        let toplevel = git_text(cwd, ["rev-parse", "--show-toplevel"]).map_err(|err| {
            anyhow!(
                "worktree isolation needs {} to be inside a git repository: {err}",
                cwd.display()
            )
        })?;
        let repo_root = dunce::canonicalize(toplevel)?;
        let relative_cwd = dunce::canonicalize(cwd)?
            .strip_prefix(&repo_root)
            .context("the environment folder is outside its repository")?
            .to_path_buf();
        let start_head = git_text(&repo_root, ["rev-parse", "--verify", "HEAD^{commit}"])
            .map_err(|_| anyhow!("worktree isolation needs a repository with a commit"))?;
        let repo_name = repo_root
            .file_name()
            .and_then(OsStr::to_str)
            .context("the repository folder has no UTF-8 name")?;
        let base = match configured_root {
            Some(root) => root.to_path_buf(),
            None => repo_root
                .parent()
                .context("the repository has no parent folder")?
                .to_path_buf(),
        };
        Ok(Some(Self {
            graph_id: graph_id.to_string(),
            graph_dir: graph_dir(&base, repo_name, graph_id),
            repo_root,
            relative_cwd,
            start_head,
            owners,
            writers: writers.iter().map(|writer| writer.id.clone()).collect(),
            state: Mutex::default(),
        }))
    }

    /// The cwd of a task that runs in a worktree: a writer's own, or the one its verifier checks.
    pub(crate) fn task_cwd(&self, task_id: &str) -> Option<AbsolutePathBuf> {
        let worktree = self.worktree(self.owners.get(task_id)?);
        let cwd = if self.relative_cwd.as_os_str().is_empty() {
            worktree
        } else {
            worktree.join(&self.relative_cwd)
        };
        AbsolutePathBuf::from_absolute_path(cwd).ok()
    }

    /// Creates a writer's worktree on `elpis/<graph>/<task>`, from the root's HEAD or from a
    /// merge of the writers it builds on. A clash in that merge keeps the worktree to inspect.
    pub(crate) fn create_writer_worktree(
        &self,
        task: &WorkGraphTask,
        tasks: &[WorkGraphTask],
    ) -> Result<(), String> {
        if self.state().bases.contains_key(&task.task_id) {
            return Ok(());
        }
        let bases = writer_bases(task.task_id.as_str(), tasks);
        for base in &bases {
            self.commit_writer(base, tasks)
                .map_err(|err| format!("cannot commit task `{base}`'s result: {err}"))?;
        }
        let start = match bases.first() {
            Some(first) => git_text(
                &self.repo_root,
                [
                    "rev-parse",
                    "--verify",
                    branch_name(&self.graph_id, first).as_str(),
                ],
            )?,
            None => self.start_head.clone(),
        };
        let worktree = self.worktree(&task.task_id);
        let branch = branch_name(&self.graph_id, &task.task_id);
        git_text(
            &self.repo_root,
            [
                OsStr::new("worktree"),
                OsStr::new("add"),
                OsStr::new("-q"),
                OsStr::new("-b"),
                OsStr::new(&branch),
                worktree.as_os_str(),
                OsStr::new(&start),
            ],
        )
        .map_err(|err| {
            format!(
                "cannot create the worktree for task `{}`: {err}",
                task.task_id
            )
        })?;
        for other in bases.iter().skip(1) {
            let other = branch_name(&self.graph_id, other);
            if let Err(err) = merge(&worktree, &other) {
                let files = conflicted_files(&worktree);
                let clash = format!(
                    "task `{}` builds on {}, whose results clash in: {}; the conflicted worktree is kept at {} (branch {branch})",
                    task.task_id,
                    bases
                        .iter()
                        .map(|base| branch_name(&self.graph_id, base))
                        .collect::<Vec<_>>()
                        .join(" and "),
                    if files.is_empty() {
                        err
                    } else {
                        files.join(", ")
                    },
                    worktree.display()
                );
                self.state().clashes.push(clash.clone());
                return Err(clash);
            }
        }
        let base = git_text(&worktree, ["rev-parse", "HEAD"])?;
        self.state().bases.insert(task.task_id.clone(), base);
        Ok(())
    }

    /// Commits each writer whose verify tasks have all succeeded.
    pub(crate) fn commit_verified_writers(&self, tasks: &[WorkGraphTask]) -> anyhow::Result<()> {
        for writer in &self.writers {
            let verified = tasks
                .iter()
                .filter(|task| {
                    task.task_id == *writer
                        || (task.kind == WorkGraphTaskKind::Verify
                            && self.owners.get(&task.task_id) == Some(writer))
                })
                .all(|task| task.status == WorkGraphTaskStatus::Succeeded);
            if verified {
                self.commit_writer(writer, tasks)?;
            }
        }
        Ok(())
    }

    /// Merges the results into the branch checked out at the root, all or nothing.
    pub(crate) fn merge_into_root(&self, tasks: &[WorkGraphTask]) -> Result<String, String> {
        let stop = |reason: String| Err(format!("{reason} {}", self.kept_report()));
        for writer in &self.writers {
            if let Err(err) = self.commit_writer(writer, tasks) {
                return stop(format!(
                    "Not merged: cannot commit task `{writer}`'s result: {err}."
                ));
            }
        }
        let target = git_text(&self.repo_root, ["symbolic-ref", "--short", "-q", "HEAD"])
            .unwrap_or_else(|_| "the detached HEAD".to_string());
        let head = match git_text(&self.repo_root, ["rev-parse", "HEAD"]) {
            Ok(head) => head,
            Err(err) => return stop(format!("Not merged: cannot read {target}: {err}.")),
        };

        // Rehearse every merge in a scratch worktree, so a clash in a later result cannot leave
        // an earlier one merged into the branch.
        let scratch = self.graph_dir.join(MERGE_DIR);
        if let Err(err) = git_text(
            &self.repo_root,
            [
                OsStr::new("worktree"),
                OsStr::new("add"),
                OsStr::new("-q"),
                OsStr::new("--detach"),
                scratch.as_os_str(),
                OsStr::new(&head),
            ],
        ) {
            return stop(format!("Not merged: cannot prepare the merge: {err}."));
        }
        let mut merged = Vec::new();
        let mut unchanged = Vec::new();
        for leaf in leaf_writers(tasks) {
            let branch = branch_name(&self.graph_id, &leaf);
            if git_text(
                &scratch,
                ["merge-base", "--is-ancestor", branch.as_str(), "HEAD"],
            )
            .is_ok()
            {
                unchanged.push(branch);
                continue;
            }
            if let Err(err) = merge(&scratch, &branch) {
                let files = conflicted_files(&scratch);
                let _ = git_text(&scratch, ["merge", "--abort"]);
                self.remove_scratch(&scratch);
                let clash = if files.is_empty() {
                    err
                } else {
                    files.join(", ")
                };
                return stop(format!(
                    "Not merged: {branch} clashes with {target} in {clash}; {target} is untouched."
                ));
            }
            merged.push(branch);
        }
        let result = git_text(&scratch, ["rev-parse", "HEAD"]);
        self.remove_scratch(&scratch);
        let result = match result {
            Ok(result) => result,
            Err(err) => return stop(format!("Not merged: cannot read the merge: {err}.")),
        };

        if result != head {
            let touched = git_bytes(
                &self.repo_root,
                ["diff", "--name-only", "-z", head.as_str(), result.as_str()],
            )
            .map(|bytes| nul_separated(&bytes).into_iter().collect::<BTreeSet<_>>());
            let dirty = git_bytes(&self.repo_root, ["status", "--porcelain", "-z", "-uall"])
                .map(|bytes| status_paths(&bytes));
            let (touched, dirty) = match (touched, dirty) {
                (Ok(touched), Ok(dirty)) => (touched, dirty),
                (Err(err), _) | (_, Err(err)) => {
                    return stop(format!(
                        "Not merged: cannot compare the working tree: {err}."
                    ));
                }
            };
            let blocked: Vec<String> = dirty.intersection(&touched).cloned().collect();
            if !blocked.is_empty() {
                return stop(format!(
                    "Not merged: {} has uncommitted changes in files the merge would change: {}; nothing was merged.",
                    self.repo_root.display(),
                    blocked.join(", ")
                ));
            }
            if let Err(err) = git_text(
                &self.repo_root,
                ["merge", "-q", "--ff-only", result.as_str()],
            ) {
                return stop(format!("Not merged: cannot move {target}: {err}."));
            }
        }

        // Every result is in the branch now; the worktrees and their branches have served.
        let mut removed = Vec::new();
        let mut left = Vec::new();
        for writer in &self.writers {
            let worktree = self.worktree(writer);
            if worktree.exists() {
                match remove_worktree(&self.repo_root, &worktree, false) {
                    Ok(()) => removed.push(worktree.display().to_string()),
                    Err(err) => {
                        left.push(format!("{} ({err})", worktree.display()));
                        continue;
                    }
                }
            }
            let branch = branch_name(&self.graph_id, writer);
            if let Err(err) = git_text(&self.repo_root, ["branch", "-q", "-d", branch.as_str()]) {
                left.push(format!("{branch} ({err})"));
            }
        }
        self.remove_empty_folders();

        let mut report = vec![format!(
            "Merged into {target} at {}: {}.",
            self.repo_root.display(),
            if merged.is_empty() {
                "nothing; no task changed a file".to_string()
            } else {
                merged.join(", ")
            }
        )];
        if !unchanged.is_empty() {
            report.push(format!("No changes: {}.", unchanged.join(", ")));
        }
        if !removed.is_empty() {
            report.push(format!("Removed worktrees: {}.", removed.join(", ")));
        }
        if !left.is_empty() {
            report.push(format!("Could not remove: {}.", left.join(", ")));
        }
        Ok(report.join(" "))
    }

    /// After a failed or cancelled run: removes unchanged worktrees, keeps and names the rest.
    pub(crate) fn release_after_stop(&self) -> String {
        let bases = self.state().bases.clone();
        let mut kept = Vec::new();
        let mut removed = Vec::new();
        for writer in &self.writers {
            let worktree = self.worktree(writer);
            if !worktree.exists() {
                continue;
            }
            let branch = branch_name(&self.graph_id, writer);
            let unchanged = bases.get(writer).is_some_and(|base| {
                git_bytes(&worktree, ["status", "--porcelain", "-z", "-uall"])
                    .is_ok_and(|status| status.is_empty())
                    && git_text(&worktree, ["rev-parse", "HEAD"]).is_ok_and(|head| &head == base)
            });
            if unchanged && remove_worktree(&self.repo_root, &worktree, false).is_ok() {
                let _ = git_text(&self.repo_root, ["branch", "-q", "-D", branch.as_str()]);
                removed.push(worktree.display().to_string());
            } else {
                kept.push(format!("{} (branch {branch})", worktree.display()));
            }
        }
        self.remove_empty_folders();
        let mut report: Vec<String> = (self.state().clashes.iter())
            .map(|clash| format!("Not built: {clash}."))
            .collect();
        if !kept.is_empty() {
            report.push(format!("Kept worktrees with work: {}.", kept.join(", ")));
        }
        if !removed.is_empty() {
            report.push(format!(
                "Removed unchanged worktrees: {}.",
                removed.join(", ")
            ));
        }
        if report.is_empty() {
            "No worktree was created.".to_string()
        } else {
            report.join(" ")
        }
    }

    fn worktree(&self, writer: &str) -> PathBuf {
        self.graph_dir.join(writer)
    }

    fn state(&self) -> MutexGuard<'_, IsolationState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Commits everything changed in a writer's worktree, once; an unchanged one adds nothing.
    fn commit_writer(&self, writer: &str, tasks: &[WorkGraphTask]) -> anyhow::Result<()> {
        let worktree = self.worktree(writer);
        if self.state().committed.contains(writer) || !worktree.exists() {
            return Ok(());
        }
        let status = git_bytes(&worktree, ["status", "--porcelain", "-z", "-uall"])
            .map_err(anyhow::Error::msg)?;
        if !status.is_empty() {
            let title = tasks
                .iter()
                .find(|task| task.task_id == writer)
                .map_or(writer, |task| task.title.as_str());
            git_text(&worktree, ["add", "-A"]).map_err(anyhow::Error::msg)?;
            git_text(&worktree, ["commit", "-q", "--no-verify", "-m", title])
                .map_err(anyhow::Error::msg)?;
        }
        self.state().committed.insert(writer.to_string());
        Ok(())
    }

    fn kept_report(&self) -> String {
        let kept: Vec<String> = self
            .writers
            .iter()
            .filter(|writer| self.worktree(writer).exists())
            .map(|writer| {
                format!(
                    "{} (branch {})",
                    self.worktree(writer).display(),
                    branch_name(&self.graph_id, writer)
                )
            })
            .collect();
        if kept.is_empty() {
            String::new()
        } else {
            format!("Kept for inspection: {}.", kept.join(", "))
        }
    }

    fn remove_scratch(&self, scratch: &Path) {
        let _ = remove_worktree(&self.repo_root, scratch, true);
    }

    /// Only empty folders go; `remove_dir` refuses any other.
    fn remove_empty_folders(&self) {
        let _ = std::fs::remove_dir(&self.graph_dir);
        if let Some(parent) = self.graph_dir.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }
}

fn merge(worktree: &Path, branch: &str) -> Result<String, String> {
    git_text(
        worktree,
        [
            "merge",
            "-q",
            "--no-ff",
            "--no-verify",
            "--no-edit",
            "-m",
            format!("Merge {branch}").as_str(),
            branch,
        ],
    )
}

fn conflicted_files(worktree: &Path) -> Vec<String> {
    git_bytes(worktree, ["diff", "--name-only", "--diff-filter=U", "-z"])
        .map(|bytes| nul_separated(&bytes))
        .unwrap_or_default()
}

fn remove_worktree(repo_root: &Path, worktree: &Path, force: bool) -> Result<(), String> {
    let mut args = vec![OsStr::new("worktree"), OsStr::new("remove")];
    if force {
        args.push(OsStr::new("--force"));
    }
    args.push(worktree.as_os_str());
    git_text(repo_root, args).map(drop)
}

fn git_text<I, S>(dir: &Path, args: I) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    git_bytes(dir, args).map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
}

/// Runs git in `dir` as the Elpis agent, never prompting; the error is git's own message.
fn git_bytes<I, S>(dir: &Path, args: I) -> Result<Vec<u8>, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", AGENT_NAME)
        .env("GIT_AUTHOR_EMAIL", AGENT_EMAIL)
        .env("GIT_COMMITTER_NAME", AGENT_NAME)
        .env("GIT_COMMITTER_EMAIL", AGENT_EMAIL)
        .stdin(Stdio::null())
        .output()
        .map_err(|err| format!("cannot run git: {err}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git exited with {}", output.status)
        } else {
            stderr
        })
    }
}

#[cfg(test)]
#[path = "work_graph_worktrees_tests.rs"]
mod tests;
