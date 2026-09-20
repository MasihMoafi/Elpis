// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use clap::Parser;
use codex_app_server_client::shared_local;
use codex_app_server_client::shared_local::prepend_elpis_defaults as prepend_elpis_memories_defaults;
use codex_arg0::Arg0DispatchPaths;
use codex_arg0::arg0_dispatch_or_else;
use codex_config::LoaderOverrides;
use codex_model_provider_info::OPENROUTER_CLAUDE_COMPAT_ALIAS;
use codex_model_provider_info::OPENROUTER_CLAUDE_COMPAT_MODEL;
use codex_model_provider_info::OPENROUTER_GEMINI_COMPAT_ALIAS;
use codex_model_provider_info::OPENROUTER_GEMINI_COMPAT_MODEL;
use codex_model_provider_info::OPENROUTER_GEMINI_FLASH_COMPAT_ALIAS;
use codex_model_provider_info::OPENROUTER_GEMINI_FLASH_COMPAT_MODEL;
use codex_tui::AppExitInfo;
use codex_tui::Cli;
use codex_tui::ExitReason;
use codex_tui::run_main;
use codex_utils_cli::CliConfigOverrides;
use std::io::Write;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use supports_color::Stream;

mod elpis_migrate;
mod elpis_update;

fn format_exit_messages(exit_info: AppExitInfo, color_enabled: bool) -> Vec<String> {
    let is_fatal = matches!(&exit_info.exit_reason, ExitReason::Fatal(_));
    let AppExitInfo {
        token_usage,
        thread_id,
        resume_hint,
        ..
    } = exit_info;

    let mut lines = Vec::new();
    if !token_usage.is_zero() {
        lines.push(token_usage.to_string());
    }

    if let Some(resume_cmd) = resume_hint {
        let command = if color_enabled {
            format!("\u{1b}[36m{resume_cmd}\u{1b}[39m")
        } else {
            resume_cmd
        };
        lines.push(format!("To continue this session, run {command}"));
    } else if is_fatal && let Some(thread_id) = thread_id {
        lines.push(format!("Session ID: {thread_id}"));
    }

    lines
}

#[derive(Parser, Debug)]
#[command(name = "elpis")]
struct TopCli {
    #[arg(long, hide = true)]
    serve_local: bool,
    #[command(subcommand)]
    command: Option<ConversationCommand>,
    /// Update the user-local Elpis installation and exit.
    #[arg(long)]
    update: bool,

    /// Preview a selective, non-destructive migration from Codex state.
    #[arg(long)]
    migrate_from_codex: bool,

    /// Categories to copy when applying a Codex-state migration.
    #[arg(
        long = "migration-include",
        value_enum,
        value_delimiter = ',',
        requires = "migrate_from_codex"
    )]
    migration_categories: Vec<elpis_migrate::MigrationCategory>,

    /// Apply the selected migration categories after showing the preview.
    #[arg(long, requires = "migrate_from_codex")]
    apply_migration: bool,

    /// Select a direct Elpis provider or a curated OpenRouter compatibility route.
    #[arg(
        long,
        value_parser = [
            "openai",
            "openrouter",
            "anthropic",
            "google-gemini",
            "claude",
            "gemini",
            "gemini-flash",
            "amazon-bedrock",
            "ollama",
            "lmstudio",
        ]
    )]
    provider: Option<String>,

    /// Resume one exact native Elpis session by thread ID.
    #[arg(long = "resume", value_name = "SESSION_ID")]
    resume_session_id: Option<String>,

    /// Connect to an existing app-server, for example unix:///path/to/server.sock.
    #[arg(long, value_name = "URL")]
    remote: Option<String>,

    #[clap(flatten)]
    config_overrides: CliConfigOverrides,

    #[clap(flatten)]
    inner: Cli,
}

#[derive(clap::Subcommand, Debug)]
enum ConversationCommand {
    /// Resume one exact native Elpis session by thread ID.
    Resume {
        #[arg(value_parser = parse_thread_id)]
        session: String,
    },
    /// Permanently delete a conversation and its spawned descendants.
    Delete {
        #[arg(value_parser = parse_thread_id)]
        session: String,
        /// Skip confirmation for this explicit UUID.
        #[arg(long)]
        force: bool,
    },
    /// Hide a conversation from the resume list without deleting it.
    Archive {
        #[arg(value_parser = parse_thread_id)]
        session: String,
    },
    /// Restore an archived conversation to the resume list.
    Unarchive {
        #[arg(value_parser = parse_thread_id)]
        session: String,
    },
}

fn parse_thread_id(value: &str) -> Result<String, String> {
    codex_protocol::ThreadId::from_string(value)
        .map(|id| id.to_string())
        .map_err(|error| format!("expected a conversation UUID: {error}"))
}

fn route_conversation_command(
    command: Option<ConversationCommand>,
    cli: &mut Cli,
) -> anyhow::Result<Option<(codex_tui::SessionArchiveAction, String)>> {
    use codex_tui::DeleteConfirmation;
    use codex_tui::SessionArchiveAction;

    Ok(match command {
        Some(ConversationCommand::Resume { session }) => {
            if cli.resume_session_id.is_some() {
                anyhow::bail!("Use either `resume SESSION_ID` or `--resume SESSION_ID`, not both");
            }
            cli.resume_session_id = Some(session);
            None
        }
        Some(ConversationCommand::Delete { session, force }) => Some((
            SessionArchiveAction::Delete(if force {
                DeleteConfirmation::Skip
            } else {
                DeleteConfirmation::Prompt
            }),
            session,
        )),
        Some(ConversationCommand::Archive { session }) => {
            Some((SessionArchiveAction::Archive, session))
        }
        Some(ConversationCommand::Unarchive { session }) => {
            Some((SessionArchiveAction::Unarchive, session))
        }
        None => None,
    })
}

fn resolve_elpis_home() -> anyhow::Result<PathBuf> {
    let path = match std::env::var_os("ELPIS_HOME").filter(|value| !value.is_empty()) {
        Some(value) => PathBuf::from(value),
        None => dirs::home_dir()
            .ok_or_else(|| anyhow::anyhow!("could not determine the home directory"))?
            .join(".elpis"),
    };
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    };
    std::fs::create_dir_all(&path)?;
    Ok(path.canonicalize()?)
}

fn existing_codex_auth_home() -> anyhow::Result<PathBuf> {
    if let Some(value) = ["CODEX_AUTH_HOME", "CODEX_HOME"]
        .into_iter()
        .find_map(|key| std::env::var_os(key).filter(|value| !value.is_empty()))
    {
        let path = PathBuf::from(value);
        return Ok(if path.is_absolute() {
            path
        } else {
            std::env::current_dir()?.join(path)
        });
    }
    Ok(dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("could not determine the home directory"))?
        .join(".codex"))
}

fn prepare_elpis_environment() -> anyhow::Result<(PathBuf, PathBuf)> {
    let auth_home = existing_codex_auth_home()?;
    let elpis_home = resolve_elpis_home()?;
    // This runs before arg0 dispatch creates a Tokio runtime or any threads.
    unsafe {
        std::env::set_var("CODEX_AUTH_HOME", &auth_home);
        std::env::set_var("CODEX_HOME", &elpis_home);
        std::env::set_var("CODEX_PROJECT_CONFIG_DIR_NAME", ".elpis");
        std::env::remove_var("CODEX_SQLITE_HOME");
        std::env::remove_var("CODEX_TUI_SESSION_LOG_PATH");
    }
    Ok((elpis_home, auth_home))
}

fn push_string_override(config_overrides: &mut CliConfigOverrides, key: &str, value: &str) {
    let value = toml::Value::String(value.to_string());
    config_overrides
        .raw_overrides
        .push(format!("{key}={value}"));
}

fn append_provider_override(config_overrides: &mut CliConfigOverrides, provider: Option<&str>) {
    let Some(provider) = provider else {
        return;
    };

    match provider {
        OPENROUTER_CLAUDE_COMPAT_ALIAS => {
            push_string_override(config_overrides, "model_provider", "openrouter");
            push_string_override(config_overrides, "model", OPENROUTER_CLAUDE_COMPAT_MODEL);
        }
        OPENROUTER_GEMINI_COMPAT_ALIAS => {
            push_string_override(config_overrides, "model_provider", "openrouter");
            push_string_override(config_overrides, "model", OPENROUTER_GEMINI_COMPAT_MODEL);
        }
        OPENROUTER_GEMINI_FLASH_COMPAT_ALIAS => {
            push_string_override(config_overrides, "model_provider", "openrouter");
            push_string_override(
                config_overrides,
                "model",
                OPENROUTER_GEMINI_FLASH_COMPAT_MODEL,
            );
        }
        provider => push_string_override(config_overrides, "model_provider", provider),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn conversation_commands_require_explicit_ids_and_preserve_prompts() {
        use clap::Parser;
        let id = "00000000-0000-0000-0000-000000000001";
        assert!(matches!(
            super::TopCli::try_parse_from(["elpis", "delete", "--force", id])
                .unwrap()
                .command,
            Some(super::ConversationCommand::Delete { force: true, .. })
        ));
        assert!(matches!(
            super::TopCli::try_parse_from(["elpis", "delete", id])
                .unwrap()
                .command,
            Some(super::ConversationCommand::Delete { force: false, .. })
        ));
        for command in ["delete", "archive", "unarchive", "resume"] {
            assert!(super::TopCli::try_parse_from(["elpis", command, id]).is_ok());
            assert!(super::TopCli::try_parse_from(["elpis", command, "ambiguous title"]).is_err());
            assert!(super::TopCli::try_parse_from(["elpis", command]).is_err());
        }
        let prompt = super::TopCli::try_parse_from(["elpis", "explain this code"]).unwrap();
        assert!(prompt.command.is_none());
        assert_eq!(prompt.inner.prompt.as_deref(), Some("explain this code"));
    }
    use super::*;

    #[test]
    fn elpis_product_defaults_precede_user_config() {
        let mut overrides = CliConfigOverrides {
            raw_overrides: vec![
                "skills.default_enabled=true".to_string(),
                "skills.bundled.enabled=true".to_string(),
                "memories.root=\"/tmp/custom-memories\"".to_string(),
                "memories.state_root=\"/tmp/custom-state\"".to_string(),
            ],
        };

        prepend_elpis_memories_defaults(&mut overrides, Path::new("/tmp/home/.elpis"));

        assert_eq!(
            overrides.raw_overrides,
            vec![
                "model_auto_compact_enabled=true",
                "model_auto_compact_token_limit_scope=total",
                "skills.default_enabled=false",
                "skills.bundled.enabled=false",
                "memories.root=\"/tmp/home/.elpis/memories\"",
                "memories.state_root=\"/tmp/home/.elpis/state\"",
                "skills.default_enabled=true",
                "skills.bundled.enabled=true",
                "memories.root=\"/tmp/custom-memories\"",
                "memories.state_root=\"/tmp/custom-state\"",
            ]
        );
    }

    #[test]
    fn a_user_config_can_still_turn_the_compaction_backstop_off() {
        let mut overrides = CliConfigOverrides {
            raw_overrides: vec!["model_auto_compact_enabled=false".to_string()],
        };

        prepend_elpis_memories_defaults(&mut overrides, Path::new("/tmp/home/.elpis"));

        assert_eq!(
            overrides.raw_overrides.first().map(String::as_str),
            Some("model_auto_compact_enabled=true")
        );
        assert_eq!(
            overrides.raw_overrides.last().map(String::as_str),
            Some("model_auto_compact_enabled=false")
        );
    }

    #[test]
    fn provider_flag_becomes_a_config_override() {
        let parsed = TopCli::try_parse_from(["elpis", "--provider", "openrouter"])
            .expect("OpenRouter provider flag");
        let mut overrides = parsed.config_overrides;
        append_provider_override(&mut overrides, parsed.provider.as_deref());
        assert_eq!(
            overrides.raw_overrides,
            vec!["model_provider=\"openrouter\"".to_string()]
        );
    }

    #[test]
    fn update_flag_is_exposed_by_the_shipped_binary() {
        let parsed = TopCli::try_parse_from(["elpis", "--update"]).expect("update flag");
        assert!(parsed.update);
    }

    #[test]
    fn exact_resume_flag_is_exposed_by_the_shipped_binary() {
        let parsed =
            TopCli::try_parse_from(["elpis", "--resume", "thread-id"]).expect("exact resume flag");
        assert_eq!(parsed.resume_session_id.as_deref(), Some("thread-id"));
    }

    #[test]
    fn printed_resume_command_routes_to_the_exact_native_thread() {
        let id = "123e4567-e89b-12d3-a456-426614174000";
        let hint = codex_utils_cli::resume_command(
            None,
            Some(codex_protocol::ThreadId::from_string(id).unwrap()),
        )
        .unwrap();
        let mut parsed = TopCli::try_parse_from(hint.split_whitespace()).unwrap();
        assert!(
            route_conversation_command(parsed.command.take(), &mut parsed.inner)
                .unwrap()
                .is_none()
        );
        assert_eq!(parsed.inner.resume_session_id.as_deref(), Some(id));
        assert!(parsed.inner.prompt.is_none());
        assert!(!parsed.inner.resume_picker);
        assert!(!parsed.inner.resume_last);
    }

    #[test]
    fn conflicting_resume_forms_are_rejected_before_loading_history() {
        let id = "123e4567-e89b-12d3-a456-426614174000";
        let mut cli = Cli::try_parse_from(["elpis"]).unwrap();
        cli.resume_session_id = Some(id.to_string());
        assert!(
            route_conversation_command(
                Some(ConversationCommand::Resume {
                    session: id.to_string()
                }),
                &mut cli,
            )
            .is_err()
        );
        assert_eq!(cli.resume_session_id.as_deref(), Some(id));
    }

    #[test]
    fn model_family_aliases_select_openrouter_and_a_model() {
        for (provider, model) in [
            (
                OPENROUTER_CLAUDE_COMPAT_ALIAS,
                OPENROUTER_CLAUDE_COMPAT_MODEL,
            ),
            (
                OPENROUTER_GEMINI_COMPAT_ALIAS,
                OPENROUTER_GEMINI_COMPAT_MODEL,
            ),
            (
                OPENROUTER_GEMINI_FLASH_COMPAT_ALIAS,
                OPENROUTER_GEMINI_FLASH_COMPAT_MODEL,
            ),
        ] {
            let parsed = TopCli::try_parse_from(["elpis", "--provider", provider])
                .expect("curated OpenRouter family flag");
            let mut overrides = parsed.config_overrides;
            append_provider_override(&mut overrides, parsed.provider.as_deref());
            assert_eq!(
                overrides.raw_overrides,
                vec![
                    "model_provider=\"openrouter\"".to_string(),
                    format!("model=\"{model}\""),
                ]
            );
        }
    }

    #[test]
    fn native_provider_ids_never_select_openrouter() {
        for provider in ["anthropic", "google-gemini"] {
            let parsed = TopCli::try_parse_from(["elpis", "--provider", provider])
                .expect("native provider flag");
            let mut overrides = parsed.config_overrides;
            append_provider_override(&mut overrides, parsed.provider.as_deref());
            assert_eq!(
                overrides.raw_overrides,
                vec![format!("model_provider=\"{provider}\"")]
            );
            assert!(
                !overrides
                    .raw_overrides
                    .iter()
                    .any(|value| value.contains("openrouter"))
            );
        }
    }

    #[test]
    fn provider_flag_accepts_all_built_in_provider_ids() {
        for provider in [
            "openai",
            "openrouter",
            "anthropic",
            "google-gemini",
            "amazon-bedrock",
            "ollama",
            "lmstudio",
        ] {
            assert!(TopCli::try_parse_from(["elpis", "--provider", provider]).is_ok());
        }
        assert!(TopCli::try_parse_from(["elpis", "--provider", "unknown"]).is_err());
    }
}

fn main() -> anyhow::Result<()> {
    // First statement in the process: everything after this point is measurable.
    codex_tui::startup_timing::mark_process_start();
    let (elpis_home, codex_auth_home) = prepare_elpis_environment()?;
    codex_tui::startup_timing::record("elpis_environment");
    arg0_dispatch_or_else(move |arg0_paths: Arg0DispatchPaths| async move {
        let mut top_cli = TopCli::parse();
        if top_cli.serve_local {
            return shared_local::serve(arg0_paths, &elpis_home)
                .await
                .map_err(Into::into);
        }
        if top_cli.update {
            println!("{}", elpis_update::run().await?);
            return Ok(());
        }
        if top_cli.migrate_from_codex {
            let report = elpis_migrate::run(
                &codex_auth_home,
                &elpis_home,
                &top_cli.migration_categories,
                top_cli.apply_migration,
            )?;
            print!("{report}");
            return Ok(());
        }
        let provider = top_cli.provider.clone();
        let mut remote_endpoint = top_cli
            .remote
            .as_deref()
            .map(codex_tui::resolve_remote_addr)
            .transpose()
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        let resume_session_id = top_cli.resume_session_id.take();
        append_provider_override(&mut top_cli.config_overrides, provider.as_deref());
        let mut inner = top_cli.inner;
        inner.resume_session_id = resume_session_id;
        inner
            .config_overrides
            .raw_overrides
            .splice(0..0, top_cli.config_overrides.raw_overrides);
        let automatically_share = cfg!(unix)
            && remote_endpoint.is_none()
            && inner.config_overrides.raw_overrides.is_empty()
            && !inner.strict_config
            && !inner.bypass_hook_trust
            && inner.config_profile_v2.is_none();
        prepend_elpis_memories_defaults(&mut inner.config_overrides, &elpis_home);
        if let Some((action, target)) = route_conversation_command(top_cli.command, &mut inner)? {
            let result = codex_tui::run_session_archive_command(
                action,
                target,
                codex_tui::SessionArchiveCommandOptions {
                    cli: inner,
                    arg0_paths,
                    explicit_remote_endpoint: remote_endpoint,
                },
            )
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))?;
            println!("{result}");
            return Ok(());
        }
        if automatically_share {
            remote_endpoint = Some(
                codex_app_server_client::RemoteAppServerEndpoint::UnixSocket {
                    socket_path: shared_local::ensure_started(&elpis_home).await?,
                },
            );
        }
        let loader_overrides = LoaderOverrides {
            project_config_dir_name: Some(".elpis".to_string()),
            ..LoaderOverrides::default()
        };
        let exit_info = run_main(inner, arg0_paths, loader_overrides, remote_endpoint).await?;
        // Accepting the startup update prompt used to leave the process with
        // nowhere to send that answer, so the update silently did not happen.
        if exit_info.update_action.is_some() {
            println!("{}", elpis_update::run().await?);
            return Ok(());
        }
        let is_fatal = match &exit_info.exit_reason {
            ExitReason::Fatal(message) => {
                eprintln!("ERROR: {message}");
                true
            }
            ExitReason::UserRequested => false,
        };

        let color_enabled = supports_color::on(Stream::Stdout).is_some();
        for line in format_exit_messages(exit_info, color_enabled) {
            println!("{line}");
        }
        if is_fatal {
            std::io::stdout().flush()?;
            std::process::exit(1);
        }
        Ok(())
    })
}
