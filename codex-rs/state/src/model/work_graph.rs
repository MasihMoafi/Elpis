use anyhow::Result;
use chrono::DateTime;
use chrono::Utc;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkGraphStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl WorkGraphStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(anyhow::anyhow!("invalid work graph status: {value}")),
        }
    }

    pub const fn is_final(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkGraphTaskStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkGraphTaskKind {
    Explore,
    Implement,
    Verify,
    Fix,
}

impl WorkGraphTaskKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Explore => "explore",
            Self::Implement => "implement",
            Self::Verify => "verify",
            Self::Fix => "fix",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "explore" => Ok(Self::Explore),
            "implement" => Ok(Self::Implement),
            "verify" => Ok(Self::Verify),
            "fix" => Ok(Self::Fix),
            _ => Err(anyhow::anyhow!("invalid work graph task kind: {value}")),
        }
    }

    pub const fn is_writable(self) -> bool {
        matches!(self, Self::Implement | Self::Fix)
    }
}

impl WorkGraphTaskStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "blocked" => Ok(Self::Blocked),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(anyhow::anyhow!("invalid work graph task status: {value}")),
        }
    }

    pub const fn is_final(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Blocked | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkGraph {
    pub id: String,
    pub root_thread_id: String,
    pub name: String,
    pub status: WorkGraphStatus,
    pub max_concurrency: usize,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkGraphTask {
    pub graph_id: String,
    pub task_id: String,
    pub ordinal: i64,
    pub title: String,
    pub instruction: String,
    pub kind: WorkGraphTaskKind,
    pub status: WorkGraphTaskStatus,
    pub dependencies: Vec<String>,
    pub write_scopes: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub environment_id: Option<String>,
    pub workspace_path: Option<String>,
    pub assigned_thread_id: Option<String>,
    pub attempt_count: i64,
    pub baseline: Option<Value>,
    pub result: Option<Value>,
    pub evidence: Vec<String>,
    pub failure_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkGraphEvent {
    pub sequence: i64,
    pub graph_id: String,
    pub task_id: Option<String>,
    pub event_type: String,
    pub payload: Option<Value>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct WorkGraphCreateParams {
    pub id: String,
    pub root_thread_id: String,
    pub name: String,
    pub max_concurrency: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkGraphTaskCreateParams {
    pub task_id: String,
    pub ordinal: i64,
    pub title: String,
    pub instruction: String,
    pub kind: WorkGraphTaskKind,
    pub dependencies: Vec<String>,
    pub write_scopes: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub environment_id: Option<String>,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkGraphTaskReport {
    pub result: Value,
    pub evidence: Vec<String>,
}

#[derive(Debug, sqlx::FromRow)]
pub(crate) struct WorkGraphRow {
    pub(crate) id: String,
    pub(crate) root_thread_id: String,
    pub(crate) name: String,
    pub(crate) status: String,
    pub(crate) max_concurrency: i64,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
    pub(crate) started_at_ms: Option<i64>,
    pub(crate) completed_at_ms: Option<i64>,
    pub(crate) last_error: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
pub(crate) struct WorkGraphTaskRow {
    pub(crate) graph_id: String,
    pub(crate) task_id: String,
    pub(crate) ordinal: i64,
    pub(crate) title: String,
    pub(crate) instruction: String,
    pub(crate) task_kind: String,
    pub(crate) status: String,
    pub(crate) write_scopes_json: String,
    pub(crate) acceptance_criteria_json: String,
    pub(crate) environment_id: Option<String>,
    pub(crate) workspace_path: Option<String>,
    pub(crate) assigned_thread_id: Option<String>,
    pub(crate) attempt_count: i64,
    pub(crate) baseline_json: Option<String>,
    pub(crate) result_json: Option<String>,
    pub(crate) evidence_json: Option<String>,
    pub(crate) failure_reason: Option<String>,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
    pub(crate) started_at_ms: Option<i64>,
    pub(crate) completed_at_ms: Option<i64>,
}

#[derive(Debug, sqlx::FromRow)]
pub(crate) struct WorkGraphEventRow {
    pub(crate) sequence: i64,
    pub(crate) graph_id: String,
    pub(crate) task_id: Option<String>,
    pub(crate) event_type: String,
    pub(crate) payload_json: Option<String>,
    pub(crate) created_at_ms: i64,
}

impl TryFrom<WorkGraphRow> for WorkGraph {
    type Error = anyhow::Error;

    fn try_from(value: WorkGraphRow) -> Result<Self> {
        Ok(Self {
            id: value.id,
            root_thread_id: value.root_thread_id,
            name: value.name,
            status: WorkGraphStatus::parse(value.status.as_str())?,
            max_concurrency: usize::try_from(value.max_concurrency)
                .map_err(|_| anyhow::anyhow!("invalid work graph max_concurrency"))?,
            created_at: millis_to_datetime(value.created_at_ms)?,
            updated_at: millis_to_datetime(value.updated_at_ms)?,
            started_at: value.started_at_ms.map(millis_to_datetime).transpose()?,
            completed_at: value.completed_at_ms.map(millis_to_datetime).transpose()?,
            last_error: value.last_error,
        })
    }
}

impl WorkGraphTaskRow {
    pub(crate) fn into_task(self, dependencies: Vec<String>) -> Result<WorkGraphTask> {
        Ok(WorkGraphTask {
            graph_id: self.graph_id,
            task_id: self.task_id,
            ordinal: self.ordinal,
            title: self.title,
            instruction: self.instruction,
            kind: WorkGraphTaskKind::parse(self.task_kind.as_str())?,
            status: WorkGraphTaskStatus::parse(self.status.as_str())?,
            dependencies,
            write_scopes: serde_json::from_str(self.write_scopes_json.as_str())?,
            acceptance_criteria: serde_json::from_str(self.acceptance_criteria_json.as_str())?,
            environment_id: self.environment_id,
            workspace_path: self.workspace_path,
            assigned_thread_id: self.assigned_thread_id,
            attempt_count: self.attempt_count,
            baseline: self
                .baseline_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()?,
            result: self
                .result_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()?,
            evidence: self
                .evidence_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()?
                .unwrap_or_default(),
            failure_reason: self.failure_reason,
            created_at: millis_to_datetime(self.created_at_ms)?,
            updated_at: millis_to_datetime(self.updated_at_ms)?,
            started_at: self.started_at_ms.map(millis_to_datetime).transpose()?,
            completed_at: self.completed_at_ms.map(millis_to_datetime).transpose()?,
        })
    }
}

impl TryFrom<WorkGraphEventRow> for WorkGraphEvent {
    type Error = anyhow::Error;

    fn try_from(value: WorkGraphEventRow) -> Result<Self> {
        Ok(Self {
            sequence: value.sequence,
            graph_id: value.graph_id,
            task_id: value.task_id,
            event_type: value.event_type,
            payload: value
                .payload_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()?,
            created_at: millis_to_datetime(value.created_at_ms)?,
        })
    }
}

pub fn validate_work_graph_tasks(tasks: &[WorkGraphTaskCreateParams]) -> Result<()> {
    if tasks.is_empty() {
        return Err(anyhow::anyhow!("work graph must contain at least one task"));
    }

    let mut task_ids = BTreeSet::new();
    for task in tasks {
        validate_task_id(task.task_id.as_str())?;
        if !task_ids.insert(task.task_id.as_str()) {
            return Err(anyhow::anyhow!(
                "duplicate work graph task id `{}`",
                task.task_id
            ));
        }
        if task.title.trim().is_empty() {
            return Err(anyhow::anyhow!(
                "work graph task `{}` has an empty title",
                task.task_id
            ));
        }
        if task.instruction.trim().is_empty() {
            return Err(anyhow::anyhow!(
                "work graph task `{}` has an empty instruction",
                task.task_id
            ));
        }
        if task.acceptance_criteria.is_empty()
            || task
                .acceptance_criteria
                .iter()
                .any(|criterion| criterion.trim().is_empty())
        {
            return Err(anyhow::anyhow!(
                "work graph task `{}` must have non-empty acceptance criteria",
                task.task_id
            ));
        }
        validate_write_scopes(task.task_id.as_str(), task.write_scopes.as_slice())?;
        if !task.kind.is_writable() && !task.write_scopes.is_empty() {
            return Err(anyhow::anyhow!(
                "work graph task `{}` is {} and must be read-only",
                task.task_id,
                task.kind.as_str()
            ));
        }
        if task.kind.is_writable() && task.write_scopes.is_empty() {
            return Err(anyhow::anyhow!(
                "work graph task `{}` is {} and must declare write scopes",
                task.task_id,
                task.kind.as_str()
            ));
        }
        let mut dependencies = BTreeSet::new();
        for dependency in &task.dependencies {
            if dependency == &task.task_id {
                return Err(anyhow::anyhow!(
                    "work graph task `{}` cannot depend on itself",
                    task.task_id
                ));
            }
            if !dependencies.insert(dependency.as_str()) {
                return Err(anyhow::anyhow!(
                    "work graph task `{}` repeats dependency `{dependency}`",
                    task.task_id
                ));
            }
        }
    }

    for task in tasks {
        for dependency in &task.dependencies {
            if !task_ids.contains(dependency.as_str()) {
                return Err(anyhow::anyhow!(
                    "work graph task `{}` depends on unknown task `{dependency}`",
                    task.task_id
                ));
            }
        }
    }

    for task in tasks {
        if task.kind.is_writable() {
            let has_verifier = tasks.iter().any(|candidate| {
                candidate.kind == WorkGraphTaskKind::Verify
                    && candidate.dependencies.contains(&task.task_id)
                    && candidate.environment_id == task.environment_id
            });
            if !has_verifier {
                return Err(anyhow::anyhow!(
                    "writable work graph task `{}` requires an independent verification task in the same environment",
                    task.task_id
                ));
            }
        }
        if task.kind == WorkGraphTaskKind::Verify
            && !task.dependencies.iter().any(|dependency| {
                tasks.iter().any(|candidate| {
                    &candidate.task_id == dependency && candidate.kind.is_writable()
                })
            })
        {
            return Err(anyhow::anyhow!(
                "verification task `{}` must directly depend on an implement or fix task",
                task.task_id
            ));
        }
    }

    let mut indegree = BTreeMap::<&str, usize>::new();
    let mut dependents = BTreeMap::<&str, Vec<&str>>::new();
    for task in tasks {
        indegree.insert(task.task_id.as_str(), task.dependencies.len());
        for dependency in &task.dependencies {
            dependents
                .entry(dependency.as_str())
                .or_default()
                .push(task.task_id.as_str());
        }
    }
    let mut queue: VecDeque<&str> = indegree
        .iter()
        .filter_map(|(task_id, degree)| (*degree == 0).then_some(*task_id))
        .collect();
    let mut visited = 0usize;
    while let Some(task_id) = queue.pop_front() {
        visited = visited.saturating_add(1);
        if let Some(children) = dependents.get(task_id) {
            for child in children {
                let degree = indegree
                    .get_mut(child)
                    .ok_or_else(|| anyhow::anyhow!("missing indegree for `{child}`"))?;
                *degree = degree.saturating_sub(1);
                if *degree == 0 {
                    queue.push_back(child);
                }
            }
        }
    }
    if visited != tasks.len() {
        return Err(anyhow::anyhow!("work graph contains a dependency cycle"));
    }

    Ok(())
}

fn validate_task_id(task_id: &str) -> Result<()> {
    if task_id.is_empty()
        || !task_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(anyhow::anyhow!(
            "work graph task id `{task_id}` must use only ASCII letters, digits, hyphens, or underscores"
        ));
    }
    Ok(())
}

fn validate_write_scopes(task_id: &str, scopes: &[String]) -> Result<()> {
    let mut seen = BTreeSet::new();
    for scope in scopes {
        let scope = scope.trim().trim_end_matches('/');
        if scope.is_empty()
            || scope.starts_with('/')
            || scope.contains('\\')
            || scope.contains(':')
            || scope == ".git"
            || scope.starts_with(".git/")
            || scope == "."
            || scope == ".."
            || scope
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".." || part == ".git")
        {
            return Err(anyhow::anyhow!(
                "work graph task `{task_id}` has invalid repository-relative write scope `{scope}`"
            ));
        }
        if !seen.insert(scope) {
            return Err(anyhow::anyhow!(
                "work graph task `{task_id}` repeats write scope `{scope}`"
            ));
        }
    }
    Ok(())
}

fn millis_to_datetime(millis: i64) -> Result<DateTime<Utc>> {
    DateTime::<Utc>::from_timestamp_millis(millis)
        .ok_or_else(|| anyhow::anyhow!("invalid unix timestamp millis: {millis}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, dependencies: &[&str]) -> WorkGraphTaskCreateParams {
        WorkGraphTaskCreateParams {
            task_id: id.to_string(),
            ordinal: 0,
            title: id.to_string(),
            instruction: format!("Implement {id}"),
            kind: WorkGraphTaskKind::Explore,
            dependencies: dependencies
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            write_scopes: Vec::new(),
            acceptance_criteria: vec!["focused test passes".to_string()],
            environment_id: None,
            workspace_path: None,
        }
    }

    #[test]
    fn validates_acyclic_graph() {
        validate_work_graph_tasks(&[
            task("foundation", &[]),
            task("frontend", &["foundation"]),
            task("tests", &["foundation"]),
        ])
        .expect("acyclic graph should validate");
    }

    #[test]
    fn rejects_cycles() {
        let err =
            validate_work_graph_tasks(&[task("first", &["second"]), task("second", &["first"])])
                .expect_err("cycle should fail");
        assert!(err.to_string().contains("cycle"));
    }

    #[test]
    fn rejects_unknown_dependency() {
        let err = validate_work_graph_tasks(&[task("first", &["missing"])])
            .expect_err("unknown dependency should fail");
        assert!(err.to_string().contains("unknown task `missing`"));
    }

    #[test]
    fn rejects_escaping_write_scope() {
        let mut invalid = task("first", &[]);
        invalid.write_scopes = vec!["../outside".to_string()];
        let err = validate_work_graph_tasks(&[invalid]).expect_err("escaping scope should fail");
        assert!(
            err.to_string()
                .contains("invalid repository-relative write scope")
        );
    }

    #[test]
    fn rejects_windows_style_write_scope() {
        let mut invalid = task("first", &[]);
        invalid.write_scopes = vec![r"C:\outside".to_string()];
        let err = validate_work_graph_tasks(&[invalid]).expect_err("drive path should fail");
        assert!(
            err.to_string()
                .contains("invalid repository-relative write scope")
        );
    }

    #[test]
    fn rejects_git_metadata_write_scope() {
        let mut invalid = task("first", &[]);
        invalid.write_scopes = vec![".git/config".to_string()];
        let err = validate_work_graph_tasks(&[invalid]).expect_err("git metadata should fail");
        assert!(
            err.to_string()
                .contains("invalid repository-relative write scope")
        );
    }
}
