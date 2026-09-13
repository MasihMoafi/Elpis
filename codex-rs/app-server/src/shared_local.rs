// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use codex_arg0::Arg0DispatchPaths;
use codex_config::LoaderOverrides;
use codex_protocol::protocol::SessionSource;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_cli::CliConfigOverrides;
use std::path::Path;

pub fn prepend_elpis_defaults(overrides: &mut CliConfigOverrides, home: &Path) {
    let memories = toml::Value::String(home.join("memories").to_string_lossy().into_owned());
    let state = toml::Value::String(home.join("state").to_string_lossy().into_owned());
    overrides.raw_overrides.splice(
        0..0,
        [
            "model_auto_compact_enabled=true".to_string(),
            "model_auto_compact_token_limit_scope=total".to_string(),
            "skills.default_enabled=false".to_string(),
            "skills.bundled.enabled=false".to_string(),
            format!("memories.root={memories}"),
            format!("memories.state_root={state}"),
        ],
    );
}

pub async fn serve(arg0_paths: Arg0DispatchPaths, home: &Path) -> std::io::Result<()> {
    let mut overrides = CliConfigOverrides::default();
    prepend_elpis_defaults(&mut overrides, home);
    crate::run_main_with_transport_options(
        arg0_paths,
        overrides,
        LoaderOverrides {
            project_config_dir_name: Some(".elpis".to_string()),
            ..LoaderOverrides::default()
        },
        false,
        crate::AppServerTransport::UnixSocket {
            socket_path: crate::app_server_control_socket_path(home)?,
        },
        SessionSource::Cli,
        Default::default(),
        Default::default(),
    )
    .await
}

#[cfg(unix)]
pub async fn ensure_started(home: &Path) -> std::io::Result<AbsolutePathBuf> {
    use std::io::ErrorKind;
    use std::process::Stdio;
    use tokio::net::UnixStream;
    use tokio::time::{Duration, Instant, sleep, timeout};

    let socket = crate::app_server_control_socket_path(home)?;
    let probe = || {
        timeout(
            Duration::from_secs(1),
            UnixStream::connect(socket.as_path()),
        )
    };
    match probe().await {
        Ok(Ok(_)) => return Ok(socket),
        Ok(Err(error))
            if matches!(
                error.kind(),
                ErrorKind::NotFound | ErrorKind::ConnectionRefused
            ) => {}
        Ok(Err(error)) => return Err(error),
        Err(_) => {
            return Err(std::io::Error::new(
                ErrorKind::TimedOut,
                "local Elpis server did not respond",
            ));
        }
    }
    let mut child = tokio::process::Command::new(std::env::current_exe()?)
        .arg("--serve-local")
        .env("CODEX_HOME", home)
        .env("ELPIS_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if matches!(probe().await, Ok(Ok(_))) {
            return Ok(socket);
        }
        if Instant::now() >= deadline {
            let _ = child.kill().await;
            return Err(std::io::Error::new(
                ErrorKind::TimedOut,
                "could not start the shared Elpis server",
            ));
        }
        // Concurrent launches are serialized by the server's existing socket lock.
        // A losing child can exit while the winning server is still starting.
        let _ = child.try_wait()?;
        sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(not(unix))]
pub async fn ensure_started(_home: &Path) -> std::io::Result<AbsolutePathBuf> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "shared local Elpis is currently supported on Unix only",
    ))
}
