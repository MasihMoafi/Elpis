use anyhow::Result;
use codex_features::Feature;
use core_test_support::responses::ev_completed;
use core_test_support::responses::ev_function_call;
use core_test_support::responses::ev_response_created;
use core_test_support::responses::sse;
use core_test_support::responses::sse_response;
use core_test_support::responses::start_mock_server;
use core_test_support::test_codex::test_codex;
use regex_lite::Regex;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use wiremock::Mock;
use wiremock::Respond;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path_regex;

struct WorkGraphResponder {
    graph_args_json: String,
    fail_task: Option<String>,
    seen_main: AtomicBool,
    assignments: Arc<Mutex<Vec<(String, String)>>>,
}

struct SandboxEscapeResponder {
    graph_args_json: String,
    seen_main: AtomicBool,
    assignment: Arc<Mutex<Option<(String, String)>>>,
}

struct UnattributedChangeResponder {
    graph_args_json: String,
    seen_main: AtomicBool,
    assignment: Arc<Mutex<Option<(String, String)>>>,
    planted_path: std::path::PathBuf,
}

impl Respond for UnattributedChangeResponder {
    fn respond(&self, request: &wiremock::Request) -> ResponseTemplate {
        let body: Value =
            serde_json::from_slice(&decode_body_bytes(request)).unwrap_or(Value::Null);
        let body_text = body.to_string();

        if body_text.contains("call-worker-report") {
            return completed_response("resp-after-report");
        }
        if let Some((graph_id, task_id)) = extract_assignment(&body) {
            *self.assignment.lock().expect("assignment mutex") =
                Some((graph_id.clone(), task_id.clone()));
            std::fs::write(&self.planted_path, "planted-evidence")
                .expect("test fixture should plant the post-baseline change");
            let args = json!({
                "graph_id": graph_id,
                "task_id": task_id,
                "outcome": "succeeded",
                "summary": "claimed success without declaring the planted change",
                "changed_files": [],
                "checks": ["claimed check passed"],
                "evidence": ["claimed evidence exists"],
                "risks": [],
                "edge_cases_considered": [],
                "open_questions": [],
                "what_i_did_not_check": []
            });
            return sse_response(sse(vec![
                ev_response_created("resp-worker-report"),
                ev_function_call(
                    "call-worker-report",
                    "report_agent_work_task",
                    serde_json::to_string(&args)
                        .expect("report args should serialize")
                        .as_str(),
                ),
                ev_completed("resp-worker-report"),
            ]));
        }
        if has_function_call_output(&body) {
            return completed_response("resp-after-tool");
        }
        if !self.seen_main.swap(true, Ordering::SeqCst) {
            return sse_response(sse(vec![
                ev_response_created("resp-main-unattributed"),
                ev_function_call(
                    "call-work-graph-unattributed",
                    "run_agent_work_graph",
                    self.graph_args_json.as_str(),
                ),
                ev_completed("resp-main-unattributed"),
            ]));
        }
        completed_response("resp-default-unattributed")
    }
}

impl Respond for SandboxEscapeResponder {
    fn respond(&self, request: &wiremock::Request) -> ResponseTemplate {
        let body: Value =
            serde_json::from_slice(&decode_body_bytes(request)).unwrap_or(Value::Null);
        if has_function_call_output(&body) {
            return completed_response("resp-after-tool");
        }
        if let Some((graph_id, task_id)) = extract_assignment(&body) {
            *self.assignment.lock().expect("assignment mutex") = Some((graph_id, task_id));
            let args = json!({ "cmd": "printf forbidden > outside.txt" });
            return sse_response(sse(vec![
                ev_response_created("resp-worker-escape"),
                ev_function_call(
                    "call-worker-escape",
                    "exec_command",
                    serde_json::to_string(&args)
                        .expect("exec args should serialize")
                        .as_str(),
                ),
                ev_completed("resp-worker-escape"),
            ]));
        }
        if !self.seen_main.swap(true, Ordering::SeqCst) {
            return sse_response(sse(vec![
                ev_response_created("resp-main-escape"),
                ev_function_call(
                    "call-work-graph-escape",
                    "run_agent_work_graph",
                    self.graph_args_json.as_str(),
                ),
                ev_completed("resp-main-escape"),
            ]));
        }
        completed_response("resp-default-escape")
    }
}

impl WorkGraphResponder {
    fn new(
        graph_args_json: String,
        fail_task: Option<&str>,
        assignments: Arc<Mutex<Vec<(String, String)>>>,
    ) -> Self {
        Self {
            graph_args_json,
            fail_task: fail_task.map(str::to_string),
            seen_main: AtomicBool::new(false),
            assignments,
        }
    }
}

impl Respond for WorkGraphResponder {
    fn respond(&self, request: &wiremock::Request) -> ResponseTemplate {
        let body: Value =
            serde_json::from_slice(&decode_body_bytes(request)).unwrap_or(Value::Null);
        if has_function_call_output(&body) {
            return completed_response("resp-tool");
        }

        if let Some((graph_id, task_id)) = extract_assignment(&body) {
            self.assignments
                .lock()
                .expect("assignment mutex")
                .push((graph_id.clone(), task_id.clone()));
            let should_fail = self.fail_task.as_deref() == Some(task_id.as_str());
            let args = if should_fail {
                json!({
                    "graph_id": graph_id,
                    "task_id": task_id,
                    "outcome": "failed",
                    "summary": "deliberate negative case",
                    "changed_files": [],
                    "checks": ["negative path exercised"],
                    "evidence": [],
                    "risks": [],
                    "edge_cases_considered": [],
                    "open_questions": [],
                    "what_i_did_not_check": [],
                    "failure_reason": "deliberate worker failure"
                })
            } else {
                json!({
                    "graph_id": graph_id,
                    "task_id": task_id,
                    "outcome": "succeeded",
                    "summary": "task complete",
                    "changed_files": [],
                    "checks": ["focused check passed"],
                    "evidence": ["worker-only marker delivered"],
                    "risks": [],
                    "edge_cases_considered": [],
                    "open_questions": [],
                    "what_i_did_not_check": []
                })
            };
            return sse_response(sse(vec![
                ev_response_created("resp-worker"),
                ev_function_call(
                    format!("call-report-{task_id}").as_str(),
                    "report_agent_work_task",
                    serde_json::to_string(&args)
                        .expect("report args should serialize")
                        .as_str(),
                ),
                ev_completed("resp-worker"),
            ]));
        }

        if !self.seen_main.swap(true, Ordering::SeqCst) {
            return sse_response(sse(vec![
                ev_response_created("resp-main"),
                ev_function_call(
                    "call-work-graph",
                    "run_agent_work_graph",
                    self.graph_args_json.as_str(),
                ),
                ev_completed("resp-main"),
            ]));
        }
        completed_response("resp-default")
    }
}

fn completed_response(id: &str) -> ResponseTemplate {
    sse_response(sse(vec![ev_response_created(id), ev_completed(id)]))
}

fn decode_body_bytes(request: &wiremock::Request) -> Vec<u8> {
    let compressed = request
        .headers
        .get("content-encoding")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|entry| entry.trim().eq_ignore_ascii_case("zstd"))
        });
    if compressed {
        zstd::stream::decode_all(std::io::Cursor::new(&request.body))
            .unwrap_or_else(|_| request.body.clone())
    } else {
        request.body.clone()
    }
}

fn has_function_call_output(body: &Value) -> bool {
    body.get("input")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("type").and_then(Value::as_str) == Some("function_call_output")
            })
        })
}

fn extract_assignment(body: &Value) -> Option<(String, String)> {
    let text = worker_prompt(body)?;
    Some((
        prompt_field(&text, "Graph ID")?,
        prompt_field(&text, "Task ID")?,
    ))
}

/// The folder the worker's task runs in.
fn extract_workspace(body: &Value) -> Option<String> {
    prompt_field(&worker_prompt(body)?, "Workspace")
}

fn prompt_field(text: &str, name: &str) -> Option<String> {
    Regex::new(format!(r"{name}:\s*([^\n]+)").as_str())
        .ok()?
        .captures(text)?
        .get(1)
        .map(|value| value.as_str().trim().to_string())
}

fn worker_prompt(body: &Value) -> Option<String> {
    let mut text = body
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|span| span.get("type").and_then(Value::as_str) == Some("input_text"))
        .filter_map(|span| span.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if let Some(instructions) = body.get("instructions").and_then(Value::as_str) {
        text.push('\n');
        text.push_str(instructions);
    }
    text.contains("bounded worker in a deterministic Elpis work graph")
        .then_some(text)
}

fn graph_args() -> Value {
    json!({
        "name": "dependency proof",
        "max_concurrency": 2,
        "max_runtime_seconds": 30,
        "tasks": [
            {
                "id": "foundation",
                "kind": "explore",
                "title": "Foundation",
                "instruction": "Return the planted marker.",
                "depends_on": [],
                "write_scopes": [],
                "acceptance_criteria": ["worker-only marker arrives"]
            },
            {
                "id": "dependent",
                "kind": "explore",
                "title": "Dependent",
                "instruction": "Use accepted prerequisite evidence.",
                "depends_on": ["foundation"],
                "write_scopes": [],
                "acceptance_criteria": ["runs after foundation"]
            }
        ]
    })
}

async fn test_runtime(
    responder: WorkGraphResponder,
) -> Result<(
    core_test_support::test_codex::TestCodex,
    Arc<Mutex<Vec<(String, String)>>>,
    wiremock::MockServer,
)> {
    let assignments = Arc::clone(&responder.assignments);
    let server = start_mock_server().await;
    let mut builder = test_codex().with_config(|config| {
        config
            .features
            .enable(Feature::SpawnCsv)
            .expect("fanout feature should enable");
        config
            .features
            .enable(Feature::Collab)
            .expect("subagents should enable");
        config
            .features
            .enable(Feature::Sqlite)
            .expect("sqlite feature should enable");
    });
    let test = builder.build(&server).await?;
    Mock::given(method("POST"))
        .and(path_regex(".*/responses$"))
        .respond_with(responder)
        .mount(&server)
        .await;
    Ok((test, assignments, server))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn work_graph_runs_dependency_after_accepted_evidence() -> Result<()> {
    let assignments = Arc::new(Mutex::new(Vec::new()));
    let responder = WorkGraphResponder::new(
        serde_json::to_string(&graph_args())?,
        None,
        Arc::clone(&assignments),
    );
    let (test, assignments, _server) = test_runtime(responder).await?;
    test.submit_turn("run the work graph").await?;

    let assignments = assignments.lock().expect("assignment mutex").clone();
    assert_eq!(
        assignments
            .iter()
            .map(|(_, task_id)| task_id.as_str())
            .collect::<Vec<_>>(),
        vec!["foundation", "dependent"]
    );
    let graph_id = assignments[0].0.as_str();
    let db = test.codex.state_db().expect("state db");
    let graph = db.get_work_graph(graph_id).await?.expect("work graph");
    assert_eq!(graph.status, codex_state::WorkGraphStatus::Succeeded);
    let tasks = db.list_work_graph_tasks(graph_id).await?;
    assert!(
        tasks
            .iter()
            .all(|task| task.status == codex_state::WorkGraphTaskStatus::Succeeded)
    );
    assert_eq!(tasks[0].evidence, vec!["worker-only marker delivered"]);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn work_graph_failure_blocks_dependent_without_spawning_it() -> Result<()> {
    let assignments = Arc::new(Mutex::new(Vec::new()));
    let responder = WorkGraphResponder::new(
        serde_json::to_string(&graph_args())?,
        Some("foundation"),
        Arc::clone(&assignments),
    );
    let (test, assignments, _server) = test_runtime(responder).await?;
    test.submit_turn("run the failing work graph").await?;

    let assignments = assignments.lock().expect("assignment mutex").clone();
    assert_eq!(assignments.len(), 1);
    assert_eq!(assignments[0].1, "foundation");
    let graph_id = assignments[0].0.as_str();
    let db = test.codex.state_db().expect("state db");
    let tasks = db.list_work_graph_tasks(graph_id).await?;
    assert_eq!(tasks[0].status, codex_state::WorkGraphTaskStatus::Failed);
    assert_eq!(tasks[1].status, codex_state::WorkGraphTaskStatus::Blocked);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn work_graph_rejects_a_real_change_omitted_from_the_worker_report() -> Result<()> {
    let server = start_mock_server().await;
    let assignment = Arc::new(Mutex::new(None));
    let args = json!({
        "name": "unattributed change negative proof",
        "max_concurrency": 1,
        "max_runtime_seconds": 30,
        "tasks": [{
            "id": "plant",
            "kind": "implement",
            "title": "Plant evidence",
            "instruction": "Write the planted marker, then report the task.",
            "depends_on": [],
            "write_scopes": ["evidence"],
            "acceptance_criteria": ["planted marker is attributable to this task"]
        }, {
            "id": "verify-plant",
            "kind": "verify",
            "title": "Verify planted evidence",
            "instruction": "Independently verify the planted marker and attribution.",
            "depends_on": ["plant"],
            "write_scopes": [],
            "acceptance_criteria": ["marker and attribution are independently checked"]
        }]
    });
    let mut builder = test_codex().with_config(|config| {
        config
            .features
            .enable(Feature::SpawnCsv)
            .expect("fanout feature should enable");
        config
            .features
            .enable(Feature::Sqlite)
            .expect("sqlite feature should enable");
    });
    let test = builder.build(&server).await?;
    std::fs::create_dir(test.cwd_path().join("evidence"))?;
    std::fs::write(test.cwd_path().join("evidence/planted.txt"), "")?;
    let responder = UnattributedChangeResponder {
        graph_args_json: serde_json::to_string(&args)?,
        seen_main: AtomicBool::new(false),
        assignment: Arc::clone(&assignment),
        planted_path: test.cwd_path().join("evidence/planted.txt"),
    };
    Mock::given(method("POST"))
        .and(path_regex(".*/responses$"))
        .respond_with(responder)
        .mount(&server)
        .await;

    test.submit_turn("run the unattributed change graph")
        .await?;
    let (graph_id, _) = assignment
        .lock()
        .expect("assignment mutex")
        .clone()
        .expect("worker assignment");
    let db = test.codex.state_db().expect("state db");
    let graph = db
        .get_work_graph(graph_id.as_str())
        .await?
        .expect("work graph");
    let tasks = db.list_work_graph_tasks(graph_id.as_str()).await?;
    assert_eq!(
        std::fs::read_to_string(test.cwd_path().join("evidence/planted.txt"))?,
        "planted-evidence",
        "the real worker path must write the planted marker before accountability is evaluated"
    );
    assert_eq!(
        graph.status,
        codex_state::WorkGraphStatus::Failed,
        "a graph must not succeed when the worker omits a real change"
    );
    assert_eq!(tasks[0].status, codex_state::WorkGraphTaskStatus::Failed);
    Ok(())
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn work_graph_worker_cannot_write_outside_declared_scope() -> Result<()> {
    let server = start_mock_server().await;
    let assignment = Arc::new(Mutex::new(None));
    let args = json!({
        "name": "sandbox negative proof",
        "max_concurrency": 1,
        "max_runtime_seconds": 30,
        "tasks": [{
            "id": "escape",
            "kind": "implement",
            "title": "Attempt escape",
            "instruction": "Try the requested write.",
            "depends_on": [],
            "write_scopes": ["allowed"],
            "acceptance_criteria": ["outside write is denied"]
        }, {
            "id": "verify-escape",
            "kind": "verify",
            "title": "Verify sandbox",
            "instruction": "Independently verify the sandbox result.",
            "depends_on": ["escape"],
            "write_scopes": [],
            "acceptance_criteria": ["sandbox result is independently checked"]
        }]
    });
    let responder = SandboxEscapeResponder {
        graph_args_json: serde_json::to_string(&args)?,
        seen_main: AtomicBool::new(false),
        assignment: Arc::clone(&assignment),
    };
    let mut builder = test_codex().with_config(|config| {
        config
            .features
            .enable(Feature::SpawnCsv)
            .expect("fanout feature should enable");
        config
            .features
            .enable(Feature::Sqlite)
            .expect("sqlite feature should enable");
    });
    let test = builder.build(&server).await?;
    std::fs::create_dir(test.cwd_path().join("allowed"))?;
    Mock::given(method("POST"))
        .and(path_regex(".*/responses$"))
        .respond_with(responder)
        .mount(&server)
        .await;

    test.submit_turn("run the sandbox escape graph").await?;
    assert!(
        !test.cwd_path().join("outside.txt").exists(),
        "worker must not create an out-of-scope file"
    );
    let (graph_id, _) = assignment
        .lock()
        .expect("assignment mutex")
        .clone()
        .expect("worker assignment");
    let db = test.codex.state_db().expect("state db");
    let tasks = db.list_work_graph_tasks(graph_id.as_str()).await?;
    assert_eq!(tasks[0].status, codex_state::WorkGraphTaskStatus::Failed);
    Ok(())
}

/// Answers the coordinator with a one-task graph and never answers its worker, so the graph is
/// still running when the coordinator's turn is interrupted.
struct HangingWorkerResponder {
    graph_args_json: String,
    seen_main: AtomicBool,
    assignment: Arc<Mutex<Option<(String, String)>>>,
}

impl Respond for HangingWorkerResponder {
    fn respond(&self, request: &wiremock::Request) -> ResponseTemplate {
        let body: Value =
            serde_json::from_slice(&decode_body_bytes(request)).unwrap_or(Value::Null);
        if let Some(assignment) = extract_assignment(&body) {
            *self.assignment.lock().expect("assignment mutex") = Some(assignment);
            return completed_response("resp-worker-hangs")
                .set_delay(std::time::Duration::from_secs(600));
        }
        if !self.seen_main.swap(true, Ordering::SeqCst) {
            return sse_response(sse(vec![
                ev_response_created("resp-main-hang"),
                ev_function_call(
                    "call-work-graph-hang",
                    "run_agent_work_graph",
                    self.graph_args_json.as_str(),
                ),
                ev_completed("resp-main-hang"),
            ]));
        }
        completed_response("resp-default-hang")
    }
}

// Elpis: Codex aborts a running tool on Esc; the graph must not leave its workers running.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupting_the_coordinator_cancels_the_graph_and_stops_its_workers() -> Result<()> {
    let mut args = graph_args();
    args["tasks"] = json!([args["tasks"][0].clone()]);
    let assignment = Arc::new(Mutex::new(None));
    let server = start_mock_server().await;
    let test = test_codex()
        .with_config(|config| {
            for feature in [Feature::SpawnCsv, Feature::Collab] {
                config
                    .features
                    .enable(feature)
                    .expect("feature should enable");
            }
        })
        .build(&server)
        .await?;
    Mock::given(method("POST"))
        .and(path_regex(".*/responses$"))
        .respond_with(HangingWorkerResponder {
            graph_args_json: serde_json::to_string(&args)?,
            seen_main: AtomicBool::new(false),
            assignment: Arc::clone(&assignment),
        })
        .mount(&server)
        .await;

    test.codex
        .start_or_steer_turn(codex_protocol::turn_input::TurnInputRequest::user_input(
            vec![codex_protocol::user_input::UserInput::Text {
                text: "run the work graph".into(),
                text_elements: vec![],
            }],
        ))
        .await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    let (graph_id, task_id) = loop {
        if let Some(assignment) = assignment.lock().expect("assignment mutex").clone() {
            break assignment;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "worker never started"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    let db = test.codex.state_db().expect("state db");
    let worker = loop {
        let task = db
            .list_work_graph_tasks(graph_id.as_str())
            .await?
            .into_iter()
            .find(|task| task.task_id == task_id)
            .expect("task");
        if let Some(thread_id) = task.assigned_thread_id {
            break codex_protocol::ThreadId::from_string(&thread_id)?;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "worker never assigned"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert!(
        test.thread_manager
            .list_thread_ids()
            .await
            .contains(&worker)
    );

    test.codex
        .submit(codex_protocol::protocol::Op::Interrupt)
        .await?;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let graph = db.get_work_graph(graph_id.as_str()).await?.expect("graph");
        let worker_gone = !test
            .thread_manager
            .list_thread_ids()
            .await
            .contains(&worker);
        if graph.status == codex_state::WorkGraphStatus::Cancelled && worker_gone {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "graph status {:?}, worker still loaded: {}",
            graph.status,
            !worker_gone
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let tasks = db.list_work_graph_tasks(graph_id.as_str()).await?;
    assert_eq!(tasks[0].status, codex_state::WorkGraphTaskStatus::Cancelled);
    Ok(())
}

/// Answers each worker of an isolated graph: a writer writes its planned file in the workspace
/// its prompt names and reports it; a verifier reports a check. Records every workspace.
struct IsolationResponder {
    graph_args_json: String,
    seen_main: AtomicBool,
    edits: std::collections::HashMap<String, (String, String)>,
    workspaces: Arc<Mutex<Vec<(String, String, String)>>>,
}

impl Respond for IsolationResponder {
    fn respond(&self, request: &wiremock::Request) -> ResponseTemplate {
        let body: Value =
            serde_json::from_slice(&decode_body_bytes(request)).unwrap_or(Value::Null);
        if has_function_call_output(&body) {
            return completed_response("resp-isolated-tool");
        }
        if let Some((graph_id, task_id)) = extract_assignment(&body) {
            let workspace = extract_workspace(&body).expect("worker prompt names its workspace");
            let changed_files = match self.edits.get(&task_id) {
                Some((path, text)) => {
                    std::fs::write(std::path::Path::new(&workspace).join(path), text)
                        .expect("writer edits its workspace");
                    vec![path.clone()]
                }
                None => Vec::new(),
            };
            self.workspaces.lock().expect("workspaces mutex").push((
                graph_id.clone(),
                task_id.clone(),
                workspace,
            ));
            let args = json!({
                "graph_id": graph_id,
                "task_id": task_id,
                "outcome": "succeeded",
                "summary": "task complete",
                "changed_files": changed_files,
                "checks": ["file contents checked"],
                "evidence": ["the planned text is in place"],
                "risks": [],
                "edge_cases_considered": [],
                "open_questions": [],
                "what_i_did_not_check": []
            });
            return sse_response(sse(vec![
                ev_response_created("resp-isolated-worker"),
                ev_function_call(
                    format!("call-isolated-report-{task_id}").as_str(),
                    "report_agent_work_task",
                    serde_json::to_string(&args)
                        .expect("report args should serialize")
                        .as_str(),
                ),
                ev_completed("resp-isolated-worker"),
            ]));
        }
        if !self.seen_main.swap(true, Ordering::SeqCst) {
            return sse_response(sse(vec![
                ev_response_created("resp-isolated-main"),
                ev_function_call(
                    "call-isolated-graph",
                    "run_agent_work_graph",
                    self.graph_args_json.as_str(),
                ),
                ev_completed("resp-isolated-main"),
            ]));
        }
        completed_response("resp-isolated-default")
    }
}

/// Two writers, `left` (scope `a`) and `right` (scope `right_scope`), each with its verifier.
fn isolated_graph_args(right_scope: &str) -> Value {
    let writer = |id: &str, scope: &str| {
        json!({
            "id": id, "kind": "implement", "title": format!("Edit {id}"),
            "instruction": "Write the planned text.", "depends_on": [],
            "write_scopes": [scope], "acceptance_criteria": ["planned text written"]
        })
    };
    let verifier = |id: &str| {
        json!({
            "id": format!("verify-{id}"), "kind": "verify", "title": format!("Verify {id}"),
            "instruction": "Check the planned text.", "depends_on": [id],
            "write_scopes": [], "acceptance_criteria": ["planned text checked"]
        })
    };
    json!({
        "name": "isolated writers",
        "isolation": "worktree",
        "max_concurrency": 2,
        "max_runtime_seconds": 60,
        "tasks": [writer("left", "a"), verifier("left"), writer("right", right_scope), verifier("right")]
    })
}

fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
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

struct IsolatedRun {
    test: core_test_support::test_codex::TestCodex,
    graph: codex_state::WorkGraph,
    /// (task id, workspace) for every worker, in assignment order.
    workspaces: Vec<(String, String)>,
    worktree_root: std::path::PathBuf,
    initial_head: String,
    _server: wiremock::MockServer,
}

impl IsolatedRun {
    fn repo(&self) -> &std::path::Path {
        self.test.cwd_path()
    }

    fn workspace(&self, task_id: &str) -> std::path::PathBuf {
        self.workspaces
            .iter()
            .find(|(id, _)| id == task_id)
            .map(|(_, workspace)| std::path::PathBuf::from(workspace))
            .unwrap_or_else(|| panic!("task `{task_id}` never ran: {:?}", self.workspaces))
    }

    fn elpis_branches(&self) -> String {
        git(
            self.repo(),
            &["branch", "--list", "--format=%(refname:short)", "elpis/*"],
        )
    }
}

/// Runs `isolated_graph_args(right_scope)` on a repository holding `files`, with the desktop's
/// worktree root configured inside the test's home. `before_run` may dirty the repository.
async fn run_isolated_graph(
    files: &[(&str, &str)],
    right_scope: &str,
    edits: &[(&str, &str, &str)],
    before_run: impl FnOnce(&std::path::Path),
) -> Result<IsolatedRun> {
    let home = Arc::new(tempfile::TempDir::new()?);
    let worktree_root = home.path().join("worktrees");
    std::fs::write(
        home.path().join("config.toml"),
        format!(
            "[desktop]\ngit-worktree-root = {}\n",
            toml::Value::String(worktree_root.display().to_string())
        ),
    )?;
    let server = start_mock_server().await;
    let test = test_codex()
        .with_home(home)
        .with_config(|config| {
            for feature in [Feature::SpawnCsv, Feature::Collab, Feature::Sqlite] {
                config
                    .features
                    .enable(feature)
                    .expect("feature should enable");
            }
            // The desktop's default: writers may only write in their workspace.
            config
                .permissions
                .set_permission_profile(
                    codex_protocol::models::PermissionProfile::workspace_write(),
                )
                .expect("workspace-write permissions");
        })
        .build(&server)
        .await?;
    let repo = test.cwd_path();
    git(repo, &["init", "-q", "-b", "main"]);
    for (path, text) in files {
        let path = repo.join(path);
        std::fs::create_dir_all(path.parent().expect("parent"))?;
        std::fs::write(path, text)?;
    }
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-q", "-m", "initial"]);
    let initial_head = git(repo, &["rev-parse", "HEAD"]);
    before_run(repo);

    let workspaces = Arc::new(Mutex::new(Vec::new()));
    Mock::given(method("POST"))
        .and(path_regex(".*/responses$"))
        .respond_with(IsolationResponder {
            graph_args_json: serde_json::to_string(&isolated_graph_args(right_scope))?,
            seen_main: AtomicBool::new(false),
            edits: edits
                .iter()
                .map(|(task, path, text)| {
                    (
                        (*task).to_string(),
                        ((*path).to_string(), (*text).to_string()),
                    )
                })
                .collect(),
            workspaces: Arc::clone(&workspaces),
        })
        .mount(&server)
        .await;
    test.submit_turn("run the isolated work graph").await?;

    let workspaces = workspaces.lock().expect("workspaces mutex").clone();
    let graph_id = workspaces.first().expect("a worker ran").0.clone();
    let graph = test
        .codex
        .state_db()
        .expect("state db")
        .get_work_graph(graph_id.as_str())
        .await?
        .expect("work graph");
    Ok(IsolatedRun {
        test,
        graph,
        workspaces: workspaces
            .into_iter()
            .map(|(_, task, workspace)| (task, workspace))
            .collect(),
        worktree_root,
        initial_head,
        _server: server,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn isolated_parallel_writers_merge_into_the_root_branch() -> Result<()> {
    let run = run_isolated_graph(
        &[("a/one.txt", "a\n"), ("b/two.txt", "b\n")],
        "b",
        &[
            ("left", "a/one.txt", "left\n"),
            ("right", "b/two.txt", "right\n"),
        ],
        |_| {},
    )
    .await?;

    assert_eq!(
        run.graph.status,
        codex_state::WorkGraphStatus::Succeeded,
        "{:?}",
        run.graph.last_error
    );
    let (left, right) = (run.workspace("left"), run.workspace("right"));
    assert_ne!(left, right, "each writer has its own worktree");
    for workspace in [&left, &right] {
        assert!(
            workspace.starts_with(&run.worktree_root),
            "{} is outside the configured worktree root",
            workspace.display()
        );
        assert!(
            !workspace.exists(),
            "merged worktree {} remains",
            workspace.display()
        );
    }
    assert_eq!(
        run.workspace("verify-left"),
        left,
        "a verifier checks its writer's worktree"
    );
    assert_eq!(git(run.repo(), &["show", "HEAD:a/one.txt"]), "left");
    assert_eq!(git(run.repo(), &["show", "HEAD:b/two.txt"]), "right");
    assert_eq!(git(run.repo(), &["branch", "--show-current"]), "main");
    assert_eq!(git(run.repo(), &["status", "--porcelain"]), "");
    assert_eq!(run.elpis_branches(), "");
    let events = run
        .test
        .codex
        .state_db()
        .expect("state db")
        .list_work_graph_events(run.graph.id.as_str())
        .await?;
    let report = events
        .iter()
        .rev()
        .find(|event| event.event_type == "worktree_report")
        .and_then(|event| event.payload.as_ref())
        .and_then(|payload| payload["text"].as_str())
        .expect("the graph records its worktree report")
        .to_string();
    for expected in [
        format!("elpis/{}/left", run.graph.id),
        format!("elpis/{}/right", run.graph.id),
        "main".to_string(),
    ] {
        assert!(
            report.contains(&expected),
            "{expected} missing from: {report}"
        );
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn isolated_writers_editing_the_same_line_fail_the_graph_listing_the_file() -> Result<()> {
    let run = run_isolated_graph(
        &[("a/notes.txt", "shared\n")],
        "a",
        &[
            ("left", "a/notes.txt", "left\n"),
            ("right", "a/notes.txt", "right\n"),
        ],
        |_| {},
    )
    .await?;

    assert_eq!(run.graph.status, codex_state::WorkGraphStatus::Failed);
    let error = run.graph.last_error.clone().unwrap_or_default();
    assert!(error.contains("a/notes.txt"), "{error}");
    assert_eq!(git(run.repo(), &["rev-parse", "HEAD"]), run.initial_head);
    assert_eq!(git(run.repo(), &["status", "--porcelain"]), "");
    assert_eq!(
        run.elpis_branches(),
        format!("elpis/{0}/left\nelpis/{0}/right", run.graph.id)
    );
    for writer in ["left", "right"] {
        assert!(
            run.workspace(writer).exists(),
            "{writer}'s worktree was not kept"
        );
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uncommitted_root_changes_in_a_merged_file_stop_the_merge() -> Result<()> {
    let run = run_isolated_graph(
        &[("a/one.txt", "a\n"), ("b/two.txt", "b\n")],
        "b",
        &[
            ("left", "a/one.txt", "left\n"),
            ("right", "b/two.txt", "right\n"),
        ],
        |repo| std::fs::write(repo.join("a/one.txt"), "uncommitted\n").expect("dirty the root"),
    )
    .await?;

    assert_eq!(run.graph.status, codex_state::WorkGraphStatus::Failed);
    let error = run.graph.last_error.clone().unwrap_or_default();
    assert!(error.contains("a/one.txt"), "{error}");
    assert_eq!(git(run.repo(), &["rev-parse", "HEAD"]), run.initial_head);
    assert_eq!(
        std::fs::read_to_string(run.repo().join("a/one.txt"))?,
        "uncommitted\n"
    );
    assert!(
        run.workspace("left").exists(),
        "left's worktree was not kept"
    );
    Ok(())
}
