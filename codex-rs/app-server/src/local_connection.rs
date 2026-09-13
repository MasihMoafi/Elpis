// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use std::path::Path;

#[cfg(unix)]
pub async fn run(socket_path: &Path) -> anyhow::Result<()> {
    use anyhow::Context;
    use futures::SinkExt;
    use futures::StreamExt;
    use tokio::io::AsyncBufReadExt;
    use tokio::io::AsyncWriteExt;
    use tokio::io::BufReader;
    use tokio::net::UnixStream;
    use tokio::time::Duration;
    use tokio::time::timeout;
    use tokio_tungstenite::client_async_with_config;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

    let mut socket = timeout(Duration::from_secs(5), async {
        let stream = UnixStream::connect(socket_path).await?;
        let config = WebSocketConfig::default()
            .max_frame_size(Some(128 << 20))
            .max_message_size(Some(128 << 20));
        let (socket, _) =
            client_async_with_config("ws://localhost/rpc", stream, Some(config)).await?;
        anyhow::Ok(socket)
    })
    .await
    .context("local app-server connection timed out")?
    .context("could not connect to the local app-server")?;

    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    loop {
        tokio::select! {
            line = input.next_line() => {
                match line? {
                    Some(line) => socket.send(Message::Text(line.into())).await?,
                    None => return Ok(()),
                }
            }
            frame = socket.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        output.write_all(text.as_bytes()).await?;
                        output.write_all(b"\n").await?;
                        output.flush().await?;
                    }
                    Some(Ok(Message::Ping(payload))) => socket.send(Message::Pong(payload)).await?,
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Ok(Message::Pong(_))) => {},
                    Some(Ok(_)) => anyhow::bail!("unexpected non-text local app-server message"),
                    Some(Err(error)) => return Err(error.into()),
                }
            }
        }
    }
}

#[cfg(not(unix))]
pub async fn run(_socket_path: &Path) -> anyhow::Result<()> {
    anyhow::bail!("local app-server connections are currently supported on Unix only")
}
