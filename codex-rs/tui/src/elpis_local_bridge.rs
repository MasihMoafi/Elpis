//! Explicit local provider transport. Ordinary remote endpoints remain remote.

use crate::AppServerTarget;
use codex_app_server_client::RemoteAppServerEndpoint;

pub(crate) fn select(target: AppServerTarget, enabled: bool) -> std::io::Result<AppServerTarget> {
    if !enabled {
        return Ok(target);
    }
    let AppServerTarget::Remote { endpoint } = target else {
        return Err(std::io::Error::other(
            "--elpis-local-bridge requires --remote with a private local Unix socket",
        ));
    };
    validate(&endpoint)?;
    Ok(AppServerTarget::LocalBridge { endpoint })
}

pub(crate) fn validate(endpoint: &RemoteAppServerEndpoint) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        use std::os::unix::fs::MetadataExt;
        let RemoteAppServerEndpoint::UnixSocket { socket_path } = endpoint else {
            return Err(std::io::Error::other(
                "the local bridge requires a Unix socket",
            ));
        };
        let path = socket_path.as_path();
        let parent = path
            .parent()
            .ok_or_else(|| std::io::Error::other("missing socket directory"))?;
        let directory = std::fs::symlink_metadata(parent)?;
        let socket = std::fs::symlink_metadata(path)?;
        // The launcher creates a private directory and socket for this effective user.
        let uid = unsafe { libc::geteuid() };
        if !directory.is_dir()
            || directory.uid() != uid
            || directory.mode() & 0o077 != 0
            || !socket.file_type().is_socket()
            || socket.uid() != uid
            || socket.mode() & 0o077 != 0
        {
            return Err(std::io::Error::other(
                "the local bridge socket and its directory must be private and owned by this user",
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = endpoint;
        Err(std::io::Error::other(
            "the local bridge requires Unix socket ownership checks",
        ))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::app_server_session::ThreadParamsMode;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    fn fixture() -> anyhow::Result<(tempfile::TempDir, UnixListener, RemoteAppServerEndpoint)> {
        let dir = tempfile::tempdir()?;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
        let socket = dir.path().join("bridge.sock");
        let listener = UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        Ok((
            dir,
            listener,
            RemoteAppServerEndpoint::UnixSocket {
                socket_path: AbsolutePathBuf::from_absolute_path_checked(socket)?,
            },
        ))
    }

    #[test]
    fn explicit_private_bridge_has_native_workspace_and_thread_parameters() -> anyhow::Result<()> {
        let (_dir, _listener, endpoint) = fixture()?;
        let target = select(
            AppServerTarget::Remote {
                endpoint: endpoint.clone(),
            },
            true,
        )?;
        assert!(!target.uses_remote_workspace());
        assert!(target.serves_local_agents());
        assert_eq!(target.thread_params_mode(), ThreadParamsMode::Embedded);
        let remote = select(AppServerTarget::Remote { endpoint }, false)?;
        assert!(
            remote.uses_remote_workspace(),
            "an unmarked Unix endpoint stays remote"
        );
        assert_eq!(remote.thread_params_mode(), ThreadParamsMode::Remote);
        Ok(())
    }

    #[test]
    fn local_bridge_rejects_tcp_missing_socket_and_non_private_paths() -> anyhow::Result<()> {
        assert!(select(AppServerTarget::Embedded, true).is_err());
        assert!(
            validate(&RemoteAppServerEndpoint::WebSocket {
                websocket_url: "ws://127.0.0.1:12345".to_string(),
                auth_token: None,
            })
            .is_err()
        );
        let (dir, _listener, endpoint) = fixture()?;
        let socket = dir.path().join("bridge.sock");
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o666))?;
        assert!(validate(&endpoint).is_err());
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755))?;
        assert!(validate(&endpoint).is_err());
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
        let link = dir.path().join("link.sock");
        std::os::unix::fs::symlink(&socket, &link)?;
        assert!(
            validate(&RemoteAppServerEndpoint::UnixSocket {
                socket_path: AbsolutePathBuf::from_absolute_path_checked(link)?,
            })
            .is_err()
        );
        assert!(
            validate(&RemoteAppServerEndpoint::UnixSocket {
                socket_path: AbsolutePathBuf::from_absolute_path_checked(
                    dir.path().join("missing.sock")
                )?,
            })
            .is_err()
        );
        Ok(())
    }

    #[tokio::test]
    async fn reconnect_rechecks_socket_permissions_before_connecting() -> anyhow::Result<()> {
        let (dir, _listener, endpoint) = fixture()?;
        let target = select(AppServerTarget::Remote { endpoint }, true)?;
        std::fs::set_permissions(
            dir.path().join("bridge.sock"),
            std::fs::Permissions::from_mode(0o666),
        )?;
        assert!(
            crate::app_server_connection::connect(&target)
                .await
                .is_err()
        );
        Ok(())
    }
}
