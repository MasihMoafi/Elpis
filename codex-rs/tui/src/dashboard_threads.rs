//! Capability-scoped, read-only transcript pages for threads in the current agent map.

use super::DashboardLink;
use super::DashboardResponse;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::SessionSource;
use codex_app_server_protocol::SortDirection;
use codex_app_server_protocol::ThreadItemsListCursor;
use codex_app_server_protocol::ThreadItemsListParams;
use codex_app_server_protocol::ThreadItemsListResponse;
use codex_app_server_protocol::ThreadReadParams;
use codex_app_server_protocol::ThreadReadResponse;
use codex_protocol::ThreadId;
use codex_protocol::protocol::SubAgentSource;
use std::time::Duration;
use tiny_http::Method;
use tiny_http::Request;
use uuid::Uuid;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

struct Page {
    thread_id: ThreadId,
    cursor: Option<String>,
    limit: u32,
}

fn parse_page(
    request: &Request,
    port: u16,
    known: impl FnOnce(&str) -> bool,
) -> Result<Page, DashboardResponse> {
    let path = super::capability_path(request, port, "/threads/")?;
    if request.method() != &Method::Get {
        return Err(super::plain(405, "Use GET"));
    }
    let (id, query) = path.split_once('?').unwrap_or((path, ""));
    let thread_id =
        ThreadId::from_string(id).map_err(|_| super::plain(400, "Invalid thread ID"))?;
    if !known(&thread_id.to_string()) {
        return Err(super::plain(404, "Thread is not in this dashboard"));
    }
    if query.len() > 8192 {
        return Err(super::plain(400, "Query is too long"));
    }
    let mut cursor = None;
    let mut limit = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "cursor" if cursor.is_none() && !value.is_empty() && value.len() <= 4096 => {
                cursor = Some(value.into_owned());
            }
            "limit" if limit.is_none() => {
                let count = value
                    .parse::<u32>()
                    .ok()
                    .filter(|count| (1..=50).contains(count));
                limit = Some(count.ok_or_else(|| super::plain(400, "Limit must be 1 through 50"))?);
            }
            _ => return Err(super::plain(400, "Invalid or repeated query parameter")),
        }
    }
    Ok(Page {
        thread_id,
        cursor,
        limit: limit.unwrap_or(20),
    })
}

pub(super) fn route(
    request: &Request,
    port: u16,
    link: Option<&DashboardLink>,
) -> DashboardResponse {
    let page = match parse_page(request, port, |id| {
        super::DASHBOARD_AGENTS
            .lock()
            .is_ok_and(|agents| agents.iter().any(|agent| agent.id == id))
    }) {
        Ok(page) => page,
        Err(response) => return response,
    };
    let Some((runtime, client)) =
        link.and_then(|link| link.runtime.as_ref().zip(link.app_server.as_ref()))
    else {
        return super::plain(503, "Open the dashboard from an active session first");
    };
    let result = runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(15), async {
            let metadata = client
                .request_typed::<ThreadReadResponse>(ClientRequest::ThreadRead {
                    request_id: RequestId::String(Uuid::new_v4().to_string()),
                    params: ThreadReadParams {
                        thread_id: page.thread_id.to_string(),
                        include_turns: false,
                    },
                })
                .await?;
            let items = client
                .request_typed::<ThreadItemsListResponse>(ClientRequest::ThreadItemsList {
                    request_id: RequestId::String(Uuid::new_v4().to_string()),
                    params: ThreadItemsListParams {
                        thread_id: page.thread_id.to_string(),
                        turn_id: None,
                        cursor: page.cursor.map(ThreadItemsListCursor::Opaque),
                        limit: Some(page.limit),
                        sort_direction: Some(SortDirection::Desc),
                    },
                })
                .await?;
            Ok::<_, codex_app_server_client::TypedRequestError>((metadata.thread, items))
        })
        .await
    });
    let (thread, items) = match result {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            tracing::warn!(%error, "dashboard transcript read failed");
            return super::plain(502, "Could not read this transcript from the app server");
        }
        Err(_) => return super::plain(504, "Transcript read timed out"),
    };
    let parent = thread.parent_thread_id.or_else(|| match thread.source {
        SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
            parent_thread_id, ..
        }) => Some(parent_thread_id.to_string()),
        _ => None,
    });
    let body = serde_json::json!({
        "thread": {
            "id": thread.id, "name": thread.name, "preview": thread.preview,
            "model": thread.model, "modelProvider": thread.model_provider,
            "parentThreadId": parent, "agentNickname": thread.agent_nickname,
            "status": thread.status,
        },
        "data": items.data,
        "nextCursor": items.next_cursor,
        "backwardsCursor": items.backwards_cursor,
    });
    match serde_json::to_vec(&body) {
        Ok(bytes) if bytes.len() <= MAX_RESPONSE_BYTES => {
            super::response(200, "application/json; charset=utf-8", bytes)
        }
        Ok(_) => super::plain(413, "Transcript page is too large; request a smaller limit"),
        Err(_) => super::plain(500, "Could not encode transcript"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiny_http::Header;
    use tiny_http::TestRequest;

    #[test]
    fn transcript_pages_require_capability_membership_and_bounded_pagination() {
        let token = super::super::evidence::dashboard_fragment()
            .trim_start_matches("#evidence=")
            .to_owned();
        let id = ThreadId::from_u128(71).to_string();
        let request = |path: &str| -> Request {
            TestRequest::new()
                .with_method(Method::Get)
                .with_path(path)
                .with_header("Host: 127.0.0.1:43123".parse::<Header>().unwrap())
                .into()
        };
        let path = format!("/threads/{token}/{id}?limit=5&cursor=next%2Bpage");
        let page = parse_page(&request(&path), 43123, |candidate| candidate == id)
            .ok()
            .unwrap();
        assert_eq!(page.limit, 5);
        assert_eq!(page.cursor.as_deref(), Some("next+page"));
        assert_eq!(page.thread_id.to_string(), id);
        for (path, known, status) in [
            (format!("/threads/wrong/{id}"), true, 403),
            (format!("/threads/{id}"), true, 403),
            (format!("/threads/{token}/invalid"), true, 400),
            (format!("/threads/{token}/{id}"), false, 404),
            (format!("/threads/{token}/{id}?limit=51"), true, 400),
            (format!("/threads/{token}/{id}?limit=1&limit=2"), true, 400),
        ] {
            assert_eq!(
                parse_page(&request(&path), 43123, |_| known)
                    .err()
                    .unwrap()
                    .status_code()
                    .0,
                status
            );
        }
        assert_eq!(
            parse_page(&request(&path), 43124, |_| true)
                .err()
                .unwrap()
                .status_code()
                .0,
            403
        );
    }
}
