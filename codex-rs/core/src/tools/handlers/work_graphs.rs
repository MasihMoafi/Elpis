use crate::agent::control::SpawnAgentOptions;
use crate::agent::status::is_final;
use crate::config::Config;
use crate::function_tool::FunctionCallError;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use crate::tools::context::FunctionToolOutput;
use crate::tools::context::ToolInvocation;
use crate::tools::context::ToolPayload;
use crate::tools::context::boxed_tool_output;
use crate::tools::handlers::multi_agents::build_agent_spawn_config;
use crate::tools::handlers::parse_arguments;
use crate::tools::handlers::work_graphs_spec::create_report_agent_work_task_tool;
use crate::tools::handlers::work_graphs_spec::create_run_agent_work_graph_tool;
use crate::tools::registry::CoreToolRuntime;
use crate::tools::registry::ToolExecutor;
use codex_protocol::ThreadId;
use codex_protocol::error::CodexErr;
use codex_protocol::models::ManagedFileSystemPermissions;
use codex_protocol::models::PermissionProfile;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxEntry;
use codex_protocol::permissions::FileSystemSandboxKind;
use codex_protocol::permissions::FileSystemSpecialPath;
use codex_protocol::protocol::AgentStatus;
use codex_protocol::protocol::MultiAgentVersion;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_protocol::protocol::TurnEnvironmentSelection;
use codex_protocol::user_input::UserInput;
use codex_tools::ToolName;
use codex_tools::ToolSpec;
use codex_utils_absolute_path::AbsolutePathBuf;
use futures::StreamExt;
use futures::stream::FuturesUnordered;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::watch::Receiver;
use tokio::time::Duration;
use tokio::time::Instant;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const DEFAULT_WORK_GRAPH_CONCURRENCY: usize = 4;
const MAX_WORK_GRAPH_CONCURRENCY: usize = 32;
const DEFAULT_TASK_RUNTIME: Duration = Duration::from_secs(60 * 30);
const STATUS_POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_WORK_GRAPH_TASKS: usize = 256;

#[derive(Debug, Deserialize)]
struct RunAgentWorkGraphArgs {
    name: String,
    tasks: Vec<WorkTaskArgs>,
    max_concurrency: Option<usize>,
    max_runtime_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct WorkTaskArgs {
    id: String,
    kind: codex_state::WorkGraphTaskKind,
    title: String,
    instruction: String,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    write_scopes: Vec<String>,
    #[serde(default)]
    acceptance_criteria: Vec<String>,
    environment_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReportAgentWorkTaskArgs {
    graph_id: String,
    task_id: String,
    outcome: String,
    summary: String,
    #[serde(default)]
    changed_files: Vec<String>,
    #[serde(default)]
    checks: Vec<String>,
    #[serde(default)]
    evidence: Vec<String>,
    #[serde(default)]
    risks: Vec<String>,
    edge_cases_considered: Vec<String>,
    open_questions: Vec<String>,
    what_i_did_not_check: Vec<String>,
    failure_reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct WorkGraphToolResult {
    graph_id: String,
    name: String,
    status: String,
    max_concurrency: usize,
    tasks: Vec<WorkGraphTaskToolResult>,
    event_count: usize,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct WorkGraphTaskToolResult {
    id: String,
    kind: String,
    status: String,
    assigned_thread_id: Option<String>,
    workspace_path: Option<String>,
    attempt_count: i64,
    result: Option<Value>,
    evidence: Vec<String>,
    failure_reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct ReportToolResult {
    accepted: bool,
    reason: Option<String>,
}

#[derive(Debug, Clone)]
struct RunnerOptions {
    max_concurrency: usize,
    max_runtime: Duration,
    spawn_config: Config,
}

#[derive(Debug, Clone)]
struct ActiveTask {
    task_id: String,
    started_at: Instant,
    status_rx: Option<Receiver<AgentStatus>>,
}

pub struct RunAgentWorkGraphHandler;

impl ToolExecutor<ToolInvocation> for RunAgentWorkGraphHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("run_agent_work_graph")
    }

    fn spec(&self) -> ToolSpec {
        create_run_agent_work_graph_tool()
    }

    fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_> {
        Box::pin(run_work_graph_call(invocation))
    }
}

impl CoreToolRuntime for RunAgentWorkGraphHandler {
    fn matches_kind(&self, payload: &ToolPayload) -> bool {
        matches!(payload, ToolPayload::Function { .. })
    }

    fn waits_for_runtime_cancellation(&self) -> bool {
        true
    }
}

pub struct ReportAgentWorkTaskHandler;

impl ToolExecutor<ToolInvocation> for ReportAgentWorkTaskHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("report_agent_work_task")
    }

    fn spec(&self) -> ToolSpec {
        create_report_agent_work_task_tool()
    }

    fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_> {
        Box::pin(report_work_task_call(invocation))
    }
}

impl CoreToolRuntime for ReportAgentWorkTaskHandler {
    fn matches_kind(&self, payload: &ToolPayload) -> bool {
        matches!(payload, ToolPayload::Function { .. })
    }
}

async fn run_work_graph_call(
    invocation: ToolInvocation,
) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError> {
    let ToolInvocation {
        session,
        turn,
        cancellation_token,
        payload,
        ..
    } = invocation;
    let arguments = function_arguments(payload, "work graph runner")?;
    run_work_graph(session, turn, cancellation_token, arguments)
        .await
        .map(boxed_tool_output)
}

async fn report_work_task_call(
    invocation: ToolInvocation,
) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError> {
    let ToolInvocation {
        session, payload, ..
    } = invocation;
    let arguments = function_arguments(payload, "work graph reporter")?;
    report_work_task(session, arguments)
        .await
        .map(boxed_tool_output)
}

fn function_arguments(
    payload: ToolPayload,
    handler_name: &str,
) -> Result<String, FunctionCallError> {
    match payload {
        ToolPayload::Function { arguments } => Ok(arguments),
        _ => Err(FunctionCallError::RespondToModel(format!(
            "{handler_name} received unsupported payload"
        ))),
    }
}

async fn run_work_graph(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    cancellation_token: CancellationToken,
    arguments: String,
) -> Result<FunctionToolOutput, FunctionCallError> {
    let args: RunAgentWorkGraphArgs = parse_arguments(arguments.as_str())?;
    validate_runner_args(&args)?;
    let db = required_state_db(&session)?;
    let options = build_runner_options(&session, &turn, &args).await?;
    let selections = turn.environments.to_selections();
    let default_environment = selections.first().ok_or_else(|| {
        FunctionCallError::RespondToModel(
            "run_agent_work_graph requires at least one selected environment".to_string(),
        )
    })?;

    db.fail_unfinished_work_graphs_for_root(
        session.thread_id.to_string().as_str(),
        "superseded by a new work graph run after coordinator interruption",
    )
    .await
    .map_err(storage_error)?;

    let graph_id = Uuid::new_v4().to_string();
    let tasks = args
        .tasks
        .iter()
        .enumerate()
        .map(|(ordinal, task)| {
            let environment = resolve_task_environment(
                selections.as_slice(),
                default_environment,
                task.environment_id.as_deref(),
            )?;
            Ok(codex_state::WorkGraphTaskCreateParams {
                task_id: task.id.clone(),
                ordinal: i64::try_from(ordinal).map_err(|_| {
                    FunctionCallError::RespondToModel("too many work graph tasks".to_string())
                })?,
                title: task.title.clone(),
                instruction: task.instruction.clone(),
                kind: task.kind,
                dependencies: task.depends_on.clone(),
                write_scopes: normalize_scopes(task.write_scopes.as_slice())?,
                acceptance_criteria: task.acceptance_criteria.clone(),
                environment_id: Some(environment.environment_id.clone()),
                workspace_path: Some(environment.cwd.to_string()),
            })
        })
        .collect::<Result<Vec<_>, FunctionCallError>>()?;

    db.create_work_graph(
        &codex_state::WorkGraphCreateParams {
            id: graph_id.clone(),
            root_thread_id: session.thread_id.to_string(),
            name: args.name.clone(),
            max_concurrency: options.max_concurrency,
        },
        tasks.as_slice(),
    )
    .await
    .map_err(|err| FunctionCallError::RespondToModel(format!("invalid work graph: {err}")))?;
    db.mark_work_graph_running(graph_id.as_str())
        .await
        .map_err(storage_error)?;

    if let Err(err) = run_scheduler(
        Arc::clone(&session),
        Arc::clone(&turn),
        Arc::clone(&db),
        graph_id.as_str(),
        &options,
        &cancellation_token,
    )
    .await
    {
        let message = format!("work graph scheduler failed: {err}");
        if let Ok(tasks) = db.list_work_graph_tasks(graph_id.as_str()).await {
            for task in tasks {
                if !task.status.is_final() {
                    let _ = db
                        .mark_work_graph_task_failed(
                            graph_id.as_str(),
                            task.task_id.as_str(),
                            message.as_str(),
                        )
                        .await;
                }
            }
        }
        let _ = db
            .finish_work_graph(
                graph_id.as_str(),
                codex_state::WorkGraphStatus::Failed,
                Some(message.as_str()),
            )
            .await;
    }

    render_graph_result(db, graph_id.as_str()).await
}

async fn report_work_task(
    session: Arc<Session>,
    arguments: String,
) -> Result<FunctionToolOutput, FunctionCallError> {
    let args: ReportAgentWorkTaskArgs = parse_arguments(arguments.as_str())?;
    let db = required_state_db(&session)?;
    let tasks = db
        .list_work_graph_tasks(args.graph_id.as_str())
        .await
        .map_err(storage_error)?;
    let Some(task) = tasks.iter().find(|task| task.task_id == args.task_id) else {
        return tool_json(&ReportToolResult {
            accepted: false,
            reason: Some("unknown graph or task id".to_string()),
        });
    };
    if args.summary.trim().is_empty() {
        return tool_json(&ReportToolResult {
            accepted: false,
            reason: Some("work graph reports require a non-empty summary".to_string()),
        });
    }

    let invalid_files =
        changed_files_outside_scopes(args.changed_files.as_slice(), task.write_scopes.as_slice())?;
    if !invalid_files.is_empty() {
        return tool_json(&ReportToolResult {
            accepted: false,
            reason: Some(format!(
                "changed files outside declared write scopes: {}",
                invalid_files.join(", ")
            )),
        });
    }
    if task.kind.is_writable() {
        let baseline = task.baseline.as_ref().ok_or_else(|| {
            FunctionCallError::Fatal(format!(
                "writable task `{}` has no engine-owned baseline",
                task.task_id
            ))
        })?;
        let current = snapshot_task_scopes(task).map_err(|err| {
            FunctionCallError::Fatal(format!(
                "failed to measure changed files for task `{}`: {err}",
                task.task_id
            ))
        })?;
        let actual = changed_paths(baseline, &current)?;
        let declared = args
            .changed_files
            .iter()
            .map(|path| normalize_repo_path(path))
            .collect::<Result<BTreeSet<_>, _>>()?;
        if actual != declared {
            return tool_json(&ReportToolResult {
                accepted: false,
                reason: Some(format!(
                    "declared changed files do not match engine measurement; measured: [{}], declared: [{}]",
                    actual.iter().cloned().collect::<Vec<_>>().join(", "),
                    declared.iter().cloned().collect::<Vec<_>>().join(", ")
                )),
            });
        }
    }

    let result = serde_json::json!({
        "summary": args.summary,
        "changed_files": args.changed_files,
        "checks": args.checks,
        "risks": args.risks,
        "edge_cases_considered": args.edge_cases_considered,
        "open_questions": args.open_questions,
        "what_i_did_not_check": args.what_i_did_not_check,
    });
    let thread_id = session.thread_id.to_string();
    let accepted = match args.outcome.as_str() {
        "succeeded" => {
            if task.kind.is_writable() && args.changed_files.is_empty() {
                return tool_json(&ReportToolResult {
                    accepted: false,
                    reason: Some(
                        "successful implement and fix reports require at least one attributable changed file"
                            .to_string(),
                    ),
                });
            }
            if args.evidence.is_empty()
                || args.evidence.iter().any(|item| item.trim().is_empty())
                || args.checks.is_empty()
                || args.checks.iter().any(|item| item.trim().is_empty())
            {
                return tool_json(&ReportToolResult {
                    accepted: false,
                    reason: Some(
                        "successful work graph reports require non-empty checks and evidence"
                            .to_string(),
                    ),
                });
            }
            db.report_work_graph_task_success(
                args.graph_id.as_str(),
                args.task_id.as_str(),
                thread_id.as_str(),
                &codex_state::WorkGraphTaskReport {
                    result,
                    evidence: args.evidence,
                },
            )
            .await
            .map_err(storage_error)?
        }
        "failed" => {
            let reason = args
                .failure_reason
                .as_deref()
                .filter(|reason| !reason.trim().is_empty())
                .ok_or_else(|| {
                    FunctionCallError::RespondToModel(
                        "failed work graph reports require failure_reason".to_string(),
                    )
                })?;
            db.report_work_graph_task_failure(
                args.graph_id.as_str(),
                args.task_id.as_str(),
                thread_id.as_str(),
                reason,
                Some(&result),
            )
            .await
            .map_err(storage_error)?
        }
        other => {
            return Err(FunctionCallError::RespondToModel(format!(
                "outcome must be `succeeded` or `failed`, got `{other}`"
            )));
        }
    };

    tool_json(&ReportToolResult {
        accepted,
        reason: (!accepted)
            .then(|| "report was not sent by the currently assigned worker".to_string()),
    })
}

fn validate_runner_args(args: &RunAgentWorkGraphArgs) -> Result<(), FunctionCallError> {
    if args.name.trim().is_empty() {
        return Err(FunctionCallError::RespondToModel(
            "work graph name must be non-empty".to_string(),
        ));
    }
    if args.tasks.is_empty() {
        return Err(FunctionCallError::RespondToModel(
            "work graph must contain at least one task".to_string(),
        ));
    }
    if args.tasks.len() > MAX_WORK_GRAPH_TASKS {
        return Err(FunctionCallError::RespondToModel(format!(
            "work graph has {} tasks; maximum is {MAX_WORK_GRAPH_TASKS}",
            args.tasks.len()
        )));
    }
    for task in &args.tasks {
        if task.kind.is_writable()
            && !args.tasks.iter().any(|candidate| {
                candidate.kind == codex_state::WorkGraphTaskKind::Verify
                    && candidate.depends_on.contains(&task.id)
                    && candidate.environment_id == task.environment_id
            })
        {
            return Err(FunctionCallError::RespondToModel(format!(
                "writable task `{}` requires an independent verification task in the same environment",
                task.id
            )));
        }
    }
    if args.max_concurrency == Some(0) {
        return Err(FunctionCallError::RespondToModel(
            "max_concurrency must be at least 1".to_string(),
        ));
    }
    if args.max_runtime_seconds == Some(0) {
        return Err(FunctionCallError::RespondToModel(
            "max_runtime_seconds must be at least 1".to_string(),
        ));
    }
    Ok(())
}

async fn build_runner_options(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    args: &RunAgentWorkGraphArgs,
) -> Result<RunnerOptions, FunctionCallError> {
    if turn.multi_agent_version == MultiAgentVersion::Disabled {
        return Err(FunctionCallError::RespondToModel(
            "multi-agent runtime is disabled; this session cannot run a work graph".to_string(),
        ));
    }
    let agent_limit = turn
        .config
        .effective_agent_max_threads(turn.multi_agent_version);
    if agent_limit == Some(0) {
        return Err(FunctionCallError::RespondToModel(
            "agent thread limit is zero; this session cannot run a work graph".to_string(),
        ));
    }
    let requested = args
        .max_concurrency
        .unwrap_or(DEFAULT_WORK_GRAPH_CONCURRENCY)
        .clamp(1, MAX_WORK_GRAPH_CONCURRENCY);
    let max_concurrency = agent_limit.map_or(requested, |limit| requested.min(limit.max(1)));
    let base_instructions = session.get_base_instructions().await;
    let spawn_config = build_agent_spawn_config(&base_instructions, turn.as_ref())?;
    Ok(RunnerOptions {
        max_concurrency,
        max_runtime: args
            .max_runtime_seconds
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_TASK_RUNTIME),
        spawn_config,
    })
}

async fn run_scheduler(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    db: Arc<codex_state::StateRuntime>,
    graph_id: &str,
    options: &RunnerOptions,
    cancellation_token: &CancellationToken,
) -> anyhow::Result<()> {
    let mut active = HashMap::<ThreadId, ActiveTask>::new();
    loop {
        if cancellation_token.is_cancelled() {
            cancel_running_graph(Arc::clone(&session), Arc::clone(&db), graph_id, &mut active)
                .await?;
            return Ok(());
        }
        let mut tasks = db.list_work_graph_tasks(graph_id).await?;
        block_tasks_with_failed_dependencies(db.as_ref(), graph_id, tasks.as_slice()).await?;

        reap_terminal_and_stale_tasks(
            Arc::clone(&session),
            Arc::clone(&db),
            graph_id,
            &mut active,
            options.max_runtime,
        )
        .await?;
        tasks = db.list_work_graph_tasks(graph_id).await?;

        if tasks.iter().all(|task| task.status.is_final()) && active.is_empty() {
            let failed = tasks.iter().any(|task| {
                matches!(
                    task.status,
                    codex_state::WorkGraphTaskStatus::Failed
                        | codex_state::WorkGraphTaskStatus::Blocked
                        | codex_state::WorkGraphTaskStatus::Cancelled
                )
            });
            if failed {
                db.finish_work_graph(
                    graph_id,
                    codex_state::WorkGraphStatus::Failed,
                    Some("one or more work graph tasks failed or were blocked"),
                )
                .await?;
            } else {
                db.finish_work_graph(graph_id, codex_state::WorkGraphStatus::Succeeded, None)
                    .await?;
            }
            return Ok(());
        }

        let slots = options.max_concurrency.saturating_sub(active.len());
        let ready = select_ready_tasks(tasks.as_slice(), slots);
        let mut progressed = false;
        for task in ready {
            let setup = (|| {
                let prompt = build_worker_prompt(&task, tasks.as_slice())?;
                let environments =
                    task_environment_selection(&turn, task.environment_id.as_deref())?;
                let spawn_config =
                    scoped_spawn_config(&options.spawn_config, &task, &environments[0])?;
                let baseline = task
                    .kind
                    .is_writable()
                    .then(|| snapshot_task_scopes(&task))
                    .transpose()?;
                Ok::<_, anyhow::Error>((prompt, environments, spawn_config, baseline))
            })();
            let (prompt, environments, spawn_config, baseline) = match setup {
                Ok(setup) => setup,
                Err(err) => {
                    db.mark_work_graph_task_failed(
                        graph_id,
                        task.task_id.as_str(),
                        format!("worker setup failed: {err}").as_str(),
                    )
                    .await?;
                    progressed = true;
                    continue;
                }
            };
            let spawned = session
                .services
                .agent_control
                .spawn_agent_with_metadata(
                    spawn_config,
                    vec![UserInput::Text {
                        text: prompt,
                        text_elements: Vec::new(),
                    }],
                    Some(SessionSource::SubAgent(SubAgentSource::Other(format!(
                        "work_graph:{graph_id}:{}",
                        task.task_id
                    )))),
                    SpawnAgentOptions {
                        parent_thread_id: Some(session.thread_id),
                        environments: Some(environments),
                        ..Default::default()
                    },
                )
                .await;
            let thread_id = match spawned {
                Ok(agent) => agent.thread_id,
                Err(CodexErr::AgentLimitReached { .. }) => break,
                Err(err) => {
                    db.mark_work_graph_task_failed(
                        graph_id,
                        task.task_id.as_str(),
                        format!("failed to spawn worker: {err}").as_str(),
                    )
                    .await?;
                    progressed = true;
                    continue;
                }
            };
            let assigned = db
                .mark_work_graph_task_running_with_thread(
                    graph_id,
                    task.task_id.as_str(),
                    thread_id.to_string().as_str(),
                    baseline.as_ref(),
                )
                .await;
            match assigned {
                Ok(true) => {}
                Ok(false) => {
                    let _ = session
                        .services
                        .agent_control
                        .shutdown_live_agent(thread_id)
                        .await;
                    continue;
                }
                Err(err) => {
                    let _ = session
                        .services
                        .agent_control
                        .shutdown_live_agent(thread_id)
                        .await;
                    return Err(err);
                }
            };
            active.insert(
                thread_id,
                ActiveTask {
                    task_id: task.task_id,
                    started_at: Instant::now(),
                    status_rx: session
                        .services
                        .agent_control
                        .subscribe_status(thread_id)
                        .await
                        .ok(),
                },
            );
            progressed = true;
        }

        if !progressed {
            wait_for_status_change(&active, cancellation_token).await;
        }
    }
}

async fn cancel_running_graph(
    session: Arc<Session>,
    db: Arc<codex_state::StateRuntime>,
    graph_id: &str,
    active: &mut HashMap<ThreadId, ActiveTask>,
) -> anyhow::Result<()> {
    for thread_id in active.keys().copied().collect::<Vec<_>>() {
        let _ = session
            .services
            .agent_control
            .shutdown_live_agent(thread_id)
            .await;
    }
    active.clear();
    for task in db.list_work_graph_tasks(graph_id).await? {
        if !task.status.is_final() {
            db.mark_work_graph_task_cancelled(
                graph_id,
                task.task_id.as_str(),
                "coordinator turn was cancelled",
            )
            .await?;
        }
    }
    db.finish_work_graph(
        graph_id,
        codex_state::WorkGraphStatus::Cancelled,
        Some("coordinator turn was cancelled"),
    )
    .await?;
    Ok(())
}

async fn block_tasks_with_failed_dependencies(
    db: &codex_state::StateRuntime,
    graph_id: &str,
    tasks: &[codex_state::WorkGraphTask],
) -> anyhow::Result<()> {
    let statuses: BTreeMap<&str, codex_state::WorkGraphTaskStatus> = tasks
        .iter()
        .map(|task| (task.task_id.as_str(), task.status))
        .collect();
    for task in tasks
        .iter()
        .filter(|task| task.status == codex_state::WorkGraphTaskStatus::Pending)
    {
        let failed_dependency = task.dependencies.iter().find(|dependency| {
            statuses.get(dependency.as_str()).is_some_and(|status| {
                matches!(
                    status,
                    codex_state::WorkGraphTaskStatus::Failed
                        | codex_state::WorkGraphTaskStatus::Blocked
                        | codex_state::WorkGraphTaskStatus::Cancelled
                )
            })
        });
        if let Some(dependency) = failed_dependency {
            db.mark_work_graph_task_blocked(
                graph_id,
                task.task_id.as_str(),
                format!("prerequisite `{dependency}` did not succeed").as_str(),
            )
            .await?;
        }
    }
    Ok(())
}

fn select_ready_tasks(
    tasks: &[codex_state::WorkGraphTask],
    limit: usize,
) -> Vec<codex_state::WorkGraphTask> {
    if limit == 0 {
        return Vec::new();
    }
    let statuses: BTreeMap<&str, codex_state::WorkGraphTaskStatus> = tasks
        .iter()
        .map(|task| (task.task_id.as_str(), task.status))
        .collect();
    let mut occupied: Vec<&codex_state::WorkGraphTask> = tasks
        .iter()
        .filter(|task| task.status == codex_state::WorkGraphTaskStatus::Running)
        .collect();
    let mut selected = Vec::new();
    for task in tasks
        .iter()
        .filter(|task| task.status == codex_state::WorkGraphTaskStatus::Pending)
    {
        let dependencies_succeeded = task.dependencies.iter().all(|dependency| {
            statuses.get(dependency.as_str()) == Some(&codex_state::WorkGraphTaskStatus::Succeeded)
        });
        if !dependencies_succeeded
            || occupied
                .iter()
                .any(|active| tasks_have_write_conflict(task, active))
        {
            continue;
        }
        selected.push(task.clone());
        occupied.push(task);
        if selected.len() == limit {
            break;
        }
    }
    selected
}

fn tasks_have_write_conflict(
    first: &codex_state::WorkGraphTask,
    second: &codex_state::WorkGraphTask,
) -> bool {
    if first.environment_id != second.environment_id {
        return false;
    }
    !first.write_scopes.is_empty() && !second.write_scopes.is_empty()
}

async fn reap_terminal_and_stale_tasks(
    session: Arc<Session>,
    db: Arc<codex_state::StateRuntime>,
    graph_id: &str,
    active: &mut HashMap<ThreadId, ActiveTask>,
    max_runtime: Duration,
) -> anyhow::Result<()> {
    let tasks = db.list_work_graph_tasks(graph_id).await?;
    let by_id: BTreeMap<&str, &codex_state::WorkGraphTask> = tasks
        .iter()
        .map(|task| (task.task_id.as_str(), task))
        .collect();
    let mut remove = Vec::new();
    for (thread_id, active_task) in active.iter() {
        let Some(task) = by_id.get(active_task.task_id.as_str()) else {
            remove.push(*thread_id);
            continue;
        };
        if task.status.is_final() {
            remove.push(*thread_id);
            continue;
        }
        if active_task.started_at.elapsed() >= max_runtime {
            db.mark_work_graph_task_failed(
                graph_id,
                active_task.task_id.as_str(),
                format!("worker exceeded max runtime of {max_runtime:?}").as_str(),
            )
            .await?;
            remove.push(*thread_id);
            continue;
        }
        let status = if let Some(status_rx) = active_task.status_rx.as_ref()
            && status_rx.has_changed().is_ok()
        {
            status_rx.borrow().clone()
        } else {
            session.services.agent_control.get_status(*thread_id).await
        };
        if is_final(&status) {
            db.mark_work_graph_task_failed(
                graph_id,
                active_task.task_id.as_str(),
                "worker finished without an accepted report_agent_work_task call",
            )
            .await?;
            remove.push(*thread_id);
        }
    }
    for thread_id in remove {
        let _ = session
            .services
            .agent_control
            .shutdown_live_agent(thread_id)
            .await;
        active.remove(&thread_id);
    }
    Ok(())
}

async fn wait_for_status_change(
    active: &HashMap<ThreadId, ActiveTask>,
    cancellation_token: &CancellationToken,
) {
    let mut waiters = FuturesUnordered::new();
    for task in active.values() {
        if let Some(status_rx) = task.status_rx.as_ref() {
            let mut status_rx = status_rx.clone();
            waiters.push(async move {
                let _ = status_rx.changed().await;
            });
        }
    }
    if waiters.is_empty() {
        tokio::select! {
            _ = tokio::time::sleep(STATUS_POLL_INTERVAL) => {}
            _ = cancellation_token.cancelled() => {}
        }
    } else {
        tokio::select! {
            _ = timeout(STATUS_POLL_INTERVAL, waiters.next()) => {}
            _ = cancellation_token.cancelled() => {}
        }
    }
}

fn build_worker_prompt(
    task: &codex_state::WorkGraphTask,
    all_tasks: &[codex_state::WorkGraphTask],
) -> anyhow::Result<String> {
    let dependency_evidence: Vec<Value> = task
        .dependencies
        .iter()
        .filter_map(|dependency| {
            all_tasks
                .iter()
                .find(|candidate| &candidate.task_id == dependency)
        })
        .map(|dependency| {
            serde_json::json!({
                "task_id": dependency.task_id,
                "result": dependency.result,
                "evidence": dependency.evidence,
            })
        })
        .collect();
    let dependencies_json = serde_json::to_string_pretty(&dependency_evidence)?;
    let scopes = if task.write_scopes.is_empty() {
        "READ-ONLY: do not modify files.".to_string()
    } else {
        task.write_scopes
            .iter()
            .map(|scope| format!("- {scope}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let criteria = if task.acceptance_criteria.is_empty() {
        "- Return concrete evidence for the requested behavior.".to_string()
    } else {
        task.acceptance_criteria
            .iter()
            .map(|criterion| format!("- {criterion}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(format!(
        "You are a bounded worker in a deterministic Elpis work graph.\n\
Graph ID: {graph_id}\n\
Task ID: {task_id}\n\
Task kind: {task_kind}\n\
Title: {title}\n\
Workspace: {workspace}\n\n\
Instruction:\n{instruction}\n\n\
Allowed write scopes:\n{scopes}\n\n\
Acceptance criteria:\n{criteria}\n\n\
Accepted prerequisite results:\n{dependencies_json}\n\n\
Authority limits:\n\
- Do not create, delete, reorder, or otherwise mutate the work graph.\n\
- Do not merge, rebase, push, or alter another task's branch/worktree.\n\
- Do not modify files outside the declared write scopes.\n\
- Do not delegate or spawn another agent.\n\
- Stop after one terminal report.\n\n\
Before stopping, call `report_agent_work_task` exactly once with graph_id `{graph_id}`, task_id `{task_id}`, outcome `succeeded` or `failed`, a concise summary, repository-relative changed_files, checks, concrete evidence, risks, edge_cases_considered, open_questions, what_i_did_not_check, and failure_reason when failed. A writable success without changed files, a success without evidence, or a report with out-of-scope files is rejected.",
        graph_id = task.graph_id,
        task_id = task.task_id,
        task_kind = task.kind.as_str(),
        title = task.title,
        workspace = task
            .workspace_path
            .as_deref()
            .unwrap_or("selected environment"),
        instruction = task.instruction,
    ))
}

fn task_environment_selection(
    turn: &TurnContext,
    environment_id: Option<&str>,
) -> anyhow::Result<Vec<TurnEnvironmentSelection>> {
    let selections = turn.environments.to_selections();
    let selected = environment_id.map_or_else(
        || selections.first(),
        |environment_id| {
            selections
                .iter()
                .find(|selection| selection.environment_id == environment_id)
        },
    );
    selected
        .cloned()
        .map(|selection| vec![selection])
        .ok_or_else(|| anyhow::anyhow!("selected work graph environment is no longer available"))
}

fn scoped_spawn_config(
    base: &Config,
    task: &codex_state::WorkGraphTask,
    environment: &TurnEnvironmentSelection,
) -> anyhow::Result<Config> {
    let cwd = environment.cwd.to_abs_path().map_err(|err| {
        anyhow::anyhow!(
            "task `{}` cannot enforce write scopes in a non-native environment: {err}",
            task.task_id
        )
    })?;
    validate_scope_resolution(&cwd, task.write_scopes.as_slice())?;
    let permission_profile = scoped_permission_profile(
        &cwd,
        task.write_scopes.as_slice(),
        base.permissions.permission_profile(),
    )?;
    let mut config = base.clone();
    config
        .permissions
        .set_permission_profile(permission_profile)
        .map_err(|err| {
            anyhow::anyhow!(
                "task `{}` cannot safely narrow the active permission profile: {err}",
                task.task_id
            )
        })?;
    config.permissions.set_workspace_roots(vec![cwd]);
    Ok(config)
}

fn scoped_permission_profile(
    cwd: &AbsolutePathBuf,
    write_scopes: &[String],
    parent: &PermissionProfile,
) -> anyhow::Result<PermissionProfile> {
    let (mut entries, glob_scan_max_depth) = match parent {
        PermissionProfile::Managed { file_system, .. } => {
            let policy = file_system.to_sandbox_policy();
            for scope in write_scopes {
                let path = cwd.join(scope);
                if !policy.can_write_path_with_cwd(path.as_path(), cwd.as_path()) {
                    return Err(anyhow::anyhow!(
                        "declared write scope `{scope}` exceeds the parent permission profile"
                    ));
                }
            }
            let entries = if policy.kind == FileSystemSandboxKind::Unrestricted {
                root_read_entries()
            } else {
                policy
                    .entries
                    .into_iter()
                    .map(|mut entry| {
                        if entry.access.can_write() {
                            entry.access = FileSystemAccessMode::Read;
                        }
                        entry
                    })
                    .collect()
            };
            (
                entries,
                policy
                    .glob_scan_max_depth
                    .and_then(std::num::NonZeroUsize::new),
            )
        }
        PermissionProfile::Disabled | PermissionProfile::External { .. } => {
            (root_read_entries(), None)
        }
    };
    entries.extend(write_scopes.iter().map(|scope| FileSystemSandboxEntry {
        path: FileSystemPath::Path {
            path: cwd.join(scope),
        },
        access: FileSystemAccessMode::Write,
    }));
    Ok(PermissionProfile::Managed {
        file_system: ManagedFileSystemPermissions::Restricted {
            entries,
            glob_scan_max_depth,
        },
        network: codex_protocol::permissions::NetworkSandboxPolicy::Restricted,
    })
}

fn root_read_entries() -> Vec<FileSystemSandboxEntry> {
    vec![FileSystemSandboxEntry {
        path: FileSystemPath::Special {
            value: FileSystemSpecialPath::Root,
        },
        access: FileSystemAccessMode::Read,
    }]
}

fn validate_scope_resolution(cwd: &AbsolutePathBuf, write_scopes: &[String]) -> anyhow::Result<()> {
    let canonical_cwd = std::fs::canonicalize(cwd.as_path())?;
    for scope in write_scopes {
        let mut probe = cwd.join(scope).as_path().to_path_buf();
        while !probe.exists() {
            if !probe.pop() {
                return Err(anyhow::anyhow!(
                    "cannot resolve declared write scope `{scope}`"
                ));
            }
        }
        let resolved = std::fs::canonicalize(probe)?;
        if !resolved.starts_with(canonical_cwd.as_path()) {
            return Err(anyhow::anyhow!(
                "declared write scope `{scope}` resolves outside the selected workspace"
            ));
        }
        if !cwd.join(scope).as_path().is_dir() {
            return Err(anyhow::anyhow!(
                "declared write scope `{scope}` must be an existing directory"
            ));
        }
    }
    Ok(())
}

fn resolve_task_environment<'a>(
    selections: &'a [TurnEnvironmentSelection],
    default_environment: &'a TurnEnvironmentSelection,
    environment_id: Option<&str>,
) -> Result<&'a TurnEnvironmentSelection, FunctionCallError> {
    environment_id.map_or(Ok(default_environment), |environment_id| {
        selections
            .iter()
            .find(|selection| selection.environment_id == environment_id)
            .ok_or_else(|| {
                FunctionCallError::RespondToModel(format!(
                    "unknown work graph environment_id `{environment_id}`"
                ))
            })
    })
}

fn normalize_scopes(scopes: &[String]) -> Result<Vec<String>, FunctionCallError> {
    scopes
        .iter()
        .map(|scope| normalize_repo_path(scope))
        .collect()
}

fn changed_files_outside_scopes(
    changed_files: &[String],
    scopes: &[String],
) -> Result<Vec<String>, FunctionCallError> {
    let changed_files = changed_files
        .iter()
        .map(|file| normalize_repo_path(file))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(changed_files
        .into_iter()
        .filter(|file| !scopes.iter().any(|scope| path_prefix(scope, file)))
        .collect())
}

fn snapshot_task_scopes(task: &codex_state::WorkGraphTask) -> anyhow::Result<Value> {
    let workspace = task
        .workspace_path
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("task has no native workspace path"))?;
    let root = Path::new(workspace);
    let mut files = BTreeMap::<String, String>::new();
    for scope in &task.write_scopes {
        let scoped_path = root.join(scope);
        if !scoped_path.exists() {
            continue;
        }
        snapshot_path(root, &scoped_path, &mut files)?;
    }
    Ok(serde_json::to_value(files)?)
}

fn snapshot_path(
    root: &Path,
    path: &Path,
    files: &mut BTreeMap<String, String>,
) -> anyhow::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path)? {
            snapshot_path(root, &entry?.path(), files)?;
        }
        return Ok(());
    }
    if !metadata.is_file() && !metadata.file_type().is_symlink() {
        return Ok(());
    }
    let relative = path
        .strip_prefix(root)?
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("workspace path is not valid UTF-8"))?
        .replace('\\', "/");
    let digest = if metadata.file_type().is_symlink() {
        Sha256::digest(std::fs::read_link(path)?.to_string_lossy().as_bytes()).to_vec()
    } else {
        let mut hasher = Sha256::new();
        let mut file = std::fs::File::open(path)?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        hasher.finalize().to_vec()
    };
    files.insert(
        relative,
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    );
    Ok(())
}

fn changed_paths(baseline: &Value, current: &Value) -> Result<BTreeSet<String>, FunctionCallError> {
    let baseline: BTreeMap<String, String> =
        serde_json::from_value(baseline.clone()).map_err(|err| {
            FunctionCallError::Fatal(format!("invalid persisted work graph baseline: {err}"))
        })?;
    let current: BTreeMap<String, String> =
        serde_json::from_value(current.clone()).map_err(|err| {
            FunctionCallError::Fatal(format!("invalid current work graph snapshot: {err}"))
        })?;
    Ok(baseline
        .keys()
        .chain(current.keys())
        .filter(|path| baseline.get(*path) != current.get(*path))
        .cloned()
        .collect())
}

fn normalize_repo_path(path: &str) -> Result<String, FunctionCallError> {
    let normalized = path.trim().trim_end_matches('/');
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains('\\')
        || normalized.contains(':')
        || normalized == ".git"
        || normalized.starts_with(".git/")
        || normalized == "."
        || normalized == ".."
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || part == ".git")
    {
        return Err(FunctionCallError::RespondToModel(format!(
            "invalid repository-relative path `{path}`"
        )));
    }
    Ok(normalized.to_string())
}

fn path_prefix(prefix: &str, path: &str) -> bool {
    prefix == path
        || path
            .strip_prefix(prefix)
            .is_some_and(|remainder| remainder.starts_with('/'))
}

async fn render_graph_result(
    db: Arc<codex_state::StateRuntime>,
    graph_id: &str,
) -> Result<FunctionToolOutput, FunctionCallError> {
    let graph = db
        .get_work_graph(graph_id)
        .await
        .map_err(storage_error)?
        .ok_or_else(|| FunctionCallError::Fatal("work graph disappeared".to_string()))?;
    let tasks = db
        .list_work_graph_tasks(graph_id)
        .await
        .map_err(storage_error)?;
    let events = db
        .list_work_graph_events(graph_id)
        .await
        .map_err(storage_error)?;
    tool_json(&WorkGraphToolResult {
        graph_id: graph.id,
        name: graph.name,
        status: graph.status.as_str().to_string(),
        max_concurrency: graph.max_concurrency,
        tasks: tasks
            .into_iter()
            .map(|task| WorkGraphTaskToolResult {
                id: task.task_id,
                kind: task.kind.as_str().to_string(),
                status: task.status.as_str().to_string(),
                assigned_thread_id: task.assigned_thread_id,
                workspace_path: task.workspace_path,
                attempt_count: task.attempt_count,
                result: task.result,
                evidence: task.evidence,
                failure_reason: task.failure_reason,
            })
            .collect(),
        event_count: events.len(),
        error: graph.last_error,
    })
}

fn required_state_db(
    session: &Arc<Session>,
) -> Result<Arc<codex_state::StateRuntime>, FunctionCallError> {
    session.state_db().ok_or_else(|| {
        FunctionCallError::Fatal("sqlite state db is unavailable for this session".to_string())
    })
}

fn storage_error(err: impl std::fmt::Display) -> FunctionCallError {
    FunctionCallError::RespondToModel(format!("work graph storage error: {err}"))
}

fn tool_json(value: &impl Serialize) -> Result<FunctionToolOutput, FunctionCallError> {
    serde_json::to_string(value)
        .map(|content| FunctionToolOutput::from_text(content, Some(true)))
        .map_err(|err| {
            FunctionCallError::Fatal(format!("failed to serialize work graph result: {err}"))
        })
}

#[cfg(test)]
#[path = "work_graphs_tests.rs"]
mod tests;
