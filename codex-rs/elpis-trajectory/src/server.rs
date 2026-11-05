//! Serves the Trajectory page and its JSON on 127.0.0.1.
//!
//! The page is the static build in `apps/elpis-trajectory/dist`, embedded at compile time.
//! `GET /api/trajectory` re-reads the rollout on every request, so a live chat stays current.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::http::Uri;
use axum::http::header;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use include_dir::Dir;
use include_dir::include_dir;

static PAGE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../apps/elpis-trajectory/dist");

/// A running Trajectory server for one rollout.
pub struct TrajectoryServer {
    pub address: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl TrajectoryServer {
    /// The page's address, to open in a browser.
    pub fn url(&self) -> String {
        format!("http://{}/", self.address)
    }
}

impl Drop for TrajectoryServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Starts serving `rollout` on a free loopback port. The server stops when the handle drops.
pub async fn serve(rollout: PathBuf) -> std::io::Result<TrajectoryServer> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let address = listener.local_addr()?;
    let app = Router::new()
        .route("/api/trajectory", get(document))
        .fallback(get(asset))
        .with_state(Arc::new(rollout));
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(TrajectoryServer { address, task })
}

async fn document(State(rollout): State<Arc<PathBuf>>) -> Response {
    match tokio::fs::read_to_string(rollout.as_path()).await {
        Ok(text) => Json(crate::project(&text)).into_response(),
        Err(error) => (
            StatusCode::NOT_FOUND,
            format!("This chat's record could not be read: {error}"),
        )
            .into_response(),
    }
}

async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let file = PAGE
        .get_file(if path.is_empty() { "index.html" } else { path })
        .or_else(|| PAGE.get_file("index.html"));
    match file {
        Some(file) => {
            let mime = mime_guess::from_path(file.path()).first_or_octet_stream();
            (
                [(header::CONTENT_TYPE, mime.as_ref().to_string())],
                file.contents(),
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "The Trajectory page is not built.").into_response(),
    }
}
