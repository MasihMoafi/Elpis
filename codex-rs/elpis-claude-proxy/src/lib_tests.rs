use super::*;
use pretty_assertions::assert_eq;
use serde_json::json;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;

const NEEDLE: &str = "NEEDLE: deploy key rotates on 2026-11-04";
const LOGIN: &str = "Bearer sk-ant-oat01-test-login";

/// Answers each request with `reply`, and counts the requests.
struct FakeOptimizer {
    reply: Box<dyn Fn(&str) -> anyhow::Result<String> + Send + Sync>,
    calls: AtomicUsize,
}

impl Optimizer for FakeOptimizer {
    fn decide(&self, input: String) -> BoxFuture<'_, anyhow::Result<OptimizerReply>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let reply = (self.reply)(&input);
        async move {
            Ok(OptimizerReply {
                raw_response: reply?,
                model_slug: "fake".to_string(),
            })
        }
        .boxed()
    }
}

/// Compacts each item to the needle line.
fn compacting() -> Arc<FakeOptimizer> {
    Arc::new(FakeOptimizer {
        reply: Box::new(|input| {
            let input: Value = serde_json::from_str(input)?;
            let items = input["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| json!({"call_id": item["call_id"], "decision": "compact", "content": NEEDLE}))
                .collect::<Vec<_>>();
            Ok(json!({ "items": items }).to_string())
        }),
        calls: AtomicUsize::new(0),
    })
}

fn tool_output() -> String {
    format!(
        "{}{NEEDLE}\n",
        "warning: unused variable in generated code\n".repeat(2000)
    )
}

fn first_turn() -> Value {
    json!({
        "model": "claude-test",
        "stream": true,
        "messages": [
            {"role": "user", "content": "When does the deploy key rotate?"},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "cat build.log"}},
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": tool_output()},
            ]},
        ],
    })
}

fn second_turn() -> Value {
    let mut body = first_turn();
    let messages = body["messages"].as_array_mut().expect("messages");
    messages.push(
        json!({"role": "assistant", "content": [{"type": "text", "text": "On 2026-11-04."}]}),
    );
    messages.push(json!({"role": "user", "content": "Thanks. And the next step?"}));
    body
}

struct Harness {
    upstream: MockServer,
    proxy: ProxyHandle,
    log_dir: tempfile::TempDir,
}

async fn harness(prune: bool, optimizer: Arc<dyn Optimizer>) -> Harness {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string("event: message_stop\ndata: {}\n\n"),
        )
        .mount(&upstream)
        .await;
    let log_dir = tempfile::tempdir().expect("tempdir");
    let proxy = start(
        ProxyOptions {
            upstream: upstream.uri(),
            log_dir: log_dir.path().to_path_buf(),
            prune,
        },
        optimizer,
    )
    .await
    .expect("proxy");
    Harness {
        upstream,
        proxy,
        log_dir,
    }
}

impl Harness {
    /// Sends `body` through the proxy and returns the response text.
    async fn send(&self, body: &[u8]) -> String {
        let response = reqwest::Client::new()
            .post(format!("{}/v1/messages", self.proxy.origin()))
            .header("authorization", LOGIN)
            .header("content-type", "application/json")
            .body(body.to_vec())
            .send()
            .await
            .expect("send");
        assert_eq!(response.status(), 200);
        response.text().await.expect("text")
    }

    /// The bodies that the upstream received, in order.
    async fn received(&self) -> Vec<Vec<u8>> {
        self.upstream
            .received_requests()
            .await
            .expect("recording")
            .into_iter()
            .map(|request| request.body)
            .collect()
    }

    fn records(&self) -> Vec<Value> {
        std::fs::read_dir(self.log_dir.path())
            .expect("log dir")
            .flatten()
            .map(|entry| {
                serde_json::from_slice(&std::fs::read(entry.path()).expect("read")).expect("json")
            })
            .collect()
    }
}

fn tool_result(body: &[u8]) -> Value {
    let body: Value = serde_json::from_slice(body).expect("json");
    body["messages"][2]["content"][0].clone()
}

#[tokio::test]
async fn pruning_off_forwards_each_byte_and_the_stream() {
    let optimizer = compacting();
    let harness = harness(false, optimizer.clone()).await;
    // Odd spacing proves that the proxy does not parse and write the body again.
    let sent = format!("  {}  ", first_turn()).into_bytes();
    let reply = harness.send(&sent).await;
    assert_eq!(reply, "event: message_stop\ndata: {}\n\n");
    assert_eq!(harness.received().await, vec![sent]);
    assert_eq!(optimizer.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn pruning_on_without_candidates_forwards_each_byte() {
    let optimizer = compacting();
    let harness = harness(true, optimizer.clone()).await;
    let sent = format!(
        "  {}  ",
        json!({"messages": [{"role": "user", "content": "hi"}]})
    )
    .into_bytes();
    harness.send(&sent).await;
    assert_eq!(harness.received().await, vec![sent]);
    assert_eq!(optimizer.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_new_tool_result_is_compacted_and_recorded() {
    let harness = harness(true, compacting()).await;
    let sent = first_turn().to_string().into_bytes();
    harness.send(&sent).await;
    let received = harness.received().await;
    let forwarded = tool_result(&received[0]);
    let text = forwarded["content"].as_str().expect("text");
    assert!(text.starts_with(NEEDLE), "{text}");
    assert!(text.contains("[ELPIS SMART PRUNE]"));
    assert!(
        received[0].len() * 4 < sent.len(),
        "the body must be much smaller"
    );
    let records = harness.records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["items"][0]["tool_use_id"], json!("toolu_1"));
    assert_eq!(records[0]["items"][0]["admitted"], forwarded["content"]);
}

#[tokio::test]
async fn a_compacted_block_is_identical_in_each_later_request() {
    let optimizer = compacting();
    let harness = harness(true, optimizer.clone()).await;
    harness.send(first_turn().to_string().as_bytes()).await;
    harness.send(second_turn().to_string().as_bytes()).await;
    let received = harness.received().await;
    assert_eq!(tool_result(&received[1]), tool_result(&received[0]));
    assert_eq!(optimizer.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_new_proxy_loads_the_recorded_forms() {
    let first = harness(true, compacting()).await;
    first.send(first_turn().to_string().as_bytes()).await;
    let admitted = tool_result(&first.received().await[0]);

    let optimizer = compacting();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&upstream)
        .await;
    let second = Harness {
        proxy: start(
            ProxyOptions {
                upstream: upstream.uri(),
                log_dir: first.log_dir.path().to_path_buf(),
                prune: true,
            },
            optimizer.clone(),
        )
        .await
        .expect("proxy"),
        upstream,
        log_dir: tempfile::tempdir().expect("tempdir"),
    };
    second.send(second_turn().to_string().as_bytes()).await;
    assert_eq!(tool_result(&second.received().await[0]), admitted);
    assert_eq!(optimizer.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_optimizer_error_or_a_bad_reply_forwards_the_source() {
    for reply in [
        Box::new(|_: &str| Err(anyhow::anyhow!("timeout"))) as Box<dyn Fn(&str) -> _ + Send + Sync>,
        Box::new(|_: &str| Ok("not a manifest".to_string())),
    ] {
        let optimizer = Arc::new(FakeOptimizer {
            reply,
            calls: AtomicUsize::new(0),
        });
        let harness = harness(true, optimizer.clone()).await;
        let sent = first_turn().to_string().into_bytes();
        harness.send(&sent).await;
        // A second request does not ask again about a block that already went out.
        harness.send(second_turn().to_string().as_bytes()).await;
        let received = harness.received().await;
        assert_eq!(received[0], sent);
        assert_eq!(tool_result(&received[1]), tool_result(&sent));
        assert_eq!(optimizer.calls.load(Ordering::SeqCst), 1);
        let records = harness.records();
        assert_eq!(records.len(), 1);
        assert_ne!(records[0]["status"], json!("decided"));
        assert!(records[0]["error"].is_string());
        assert_eq!(records[0]["items"][0]["admitted"], Value::Null);
    }
}

#[tokio::test]
async fn the_login_reaches_the_upstream_and_no_record() {
    let harness = harness(true, compacting()).await;
    harness.send(first_turn().to_string().as_bytes()).await;
    let requests = harness
        .upstream
        .received_requests()
        .await
        .expect("recording");
    assert_eq!(
        requests[0]
            .headers
            .get("authorization")
            .map(|value| value.to_str().expect("ascii")),
        Some(LOGIN)
    );
    assert!(!harness.records().is_empty());
    for record in harness.records() {
        assert!(!record.to_string().contains("sk-ant-oat"));
    }
}
