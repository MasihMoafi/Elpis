# App Server Test Client
Quickstart for running and hitting `codex app-server`.

## Quickstart

Run from `<reporoot>/codex-rs`.

```bash
# 1) Build debug codex binary
cargo build -p codex-cli --bin codex

# 2) Start websocket app-server in background
cargo run -p codex-app-server-test-client -- \
  --codex-bin ./target/debug/codex \
  serve --listen ws://127.0.0.1:4222 --kill

# 3) Call app-server (defaults to ws://127.0.0.1:4222)
cargo run -p codex-app-server-test-client -- model-list
```

`send-message` and `send-message-v2` handle `request_user_input` server requests interactively.
When Codex asks a question, choose a numbered option (or `o` for a free-form answer when offered)
and the client will send the response and continue streaming the same turn.

## Testing Codex-managed Amazon Bedrock login

`test-login --amazon-bedrock` initializes the experimental app-server API, sends an
`account/login/start` request with an Amazon Bedrock API key, and waits for the
`account/login/completed` and `account/updated` notifications. Login replaces the current primary
credential and sets `model_provider = "amazon-bedrock"`, so use an isolated `CODEX_HOME` when
testing.

```bash
export CODEX_HOME="$(mktemp -d)"
printf 'cli_auth_credentials_store = "file"\n' > "$CODEX_HOME/config.toml"

cargo build -p codex-cli --bin codex
cargo run -p codex-app-server-test-client -- \
  --codex-bin ./target/debug/codex \
  test-login \
  --amazon-bedrock \
  --api-key "<BEDROCK_API_KEY>" \
  --region us-west-2
```

The test client redacts `apiKey` from its outbound request log. After login, start a fresh Codex
process with the same `CODEX_HOME` to verify that it uses the persisted managed credential.

## Testing logout

`test-logout` initializes the app-server, sends an `account/logout` request, and waits for the
resulting `account/updated` notification. It uses the active `CODEX_HOME`, so point it at an
isolated directory when testing credential cleanup.

```bash
cargo run -p codex-app-server-test-client -- \
  --codex-bin ./target/debug/codex \
  test-logout
```

## Testing remote plugin uninstall

`plugin-remote-uninstall` is a manually invoked live command. It contacts the
configured remote plugin API and changes the active account's installed-plugin
state, so it is not run by `cargo test` or CI. `--remote-plugin-id` takes the
backend ID, such as `plugins~Plugin_...`, not the local
`<plugin>@<marketplace>` ID.

```bash
cargo run -p codex-app-server-test-client -- \
  --codex-bin ./target/debug/codex \
  plugin-remote-uninstall \
  --remote-plugin-id <REMOTE_PLUGIN_ID> \
  --confirm-account-mutation
```

## Watching Raw Inbound Traffic

Initialize a connection, then print every inbound JSON-RPC message until you stop it with
`Ctrl+C`:

```bash
cargo run -p codex-app-server-test-client -- watch
```

## Testing Thread Rejoin Behavior

Build and start an app server using commands above. The app-server log is written to `/tmp/codex-app-server-test-client/app-server.log`

### 1) Get a thread id

Create at least one thread, then list threads:

```bash
cargo run -p codex-app-server-test-client -- send-message-v2 "seed thread for rejoin test"
cargo run -p codex-app-server-test-client -- thread-list --limit 5
```

Copy a thread id from the `thread-list` output.

### 2) Rejoin while a turn is in progress (two terminals)

Terminal A:

```bash
cargo run --bin codex-app-server-test-client -- \
  resume-message-v2 <THREAD_ID> "respond with thorough docs on the rust core"
```

Terminal B (while Terminal A is still streaming):

```bash
cargo run --bin codex-app-server-test-client -- thread-resume <THREAD_ID>
```
