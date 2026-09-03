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
    if !text.contains("bounded worker in a deterministic Elpis work graph") {
        return None;
    }
    let graph_id = Regex::new(r"Graph ID:\s*([^\n]+)")
        .ok()?
        .captures(text.as_str())?
        .get(1)?
        .as_str()
        .trim()
        .to_string();
    let task_id = Regex::new(r"Task ID:\s*([^\n]+)")
        .ok()?
        .captures(text.as_str())?
        .get(1)?
        .as_str()
        .trim()
        .to_string();
    Some((graph_id, task_id))
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
