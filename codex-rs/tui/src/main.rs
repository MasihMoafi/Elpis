// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use clap::Parser;
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

    #[clap(flatten)]
    config_overrides: CliConfigOverrides,

    #[clap(flatten)]
    inner: Cli,
}

#[derive(clap::Subcommand, Debug)]
enum ConversationCommand {
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

fn prepend_elpis_memories_defaults(config_overrides: &mut CliConfigOverrides, elpis_home: &Path) {
    let memories_root = elpis_home.join("memories");
    let state_root = elpis_home.join("state");
    let memories_value = toml::Value::String(memories_root.to_string_lossy().into_owned());
    let state_value = toml::Value::String(state_root.to_string_lossy().into_owned());
    config_overrides.raw_overrides.splice(
        0..0,
        [
            // Native automatic compaction is the context-window backstop. Prepended, so a
            // user config file can still turn it off deliberately.
            "model_auto_compact_enabled=true".to_string(),
            // The native threshold is measured against the whole active context.
            "model_auto_compact_token_limit_scope=total".to_string(),
            // Elpis starts from an explicitly curated skill set; user config can re-enable
            // skills through later overrides.
            "skills.default_enabled=false".to_string(),
            "skills.bundled.enabled=false".to_string(),
            format!("memories.root={memories_value}"),
            format!("memories.state_root={state_value}"),
        ],
    );
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
    if let Some(value) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
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
        for command in ["delete", "archive", "unarchive"] {
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
        let resume_session_id = top_cli.resume_session_id.take();
        append_provider_override(&mut top_cli.config_overrides, provider.as_deref());
        let mut inner = top_cli.inner;
        inner.resume_session_id = resume_session_id;
        inner
            .config_overrides
            .raw_overrides
            .splice(0..0, top_cli.config_overrides.raw_overrides);
        prepend_elpis_memories_defaults(&mut inner.config_overrides, &elpis_home);
        if let Some(command) = top_cli.command {
            use codex_tui::DeleteConfirmation;
            use codex_tui::SessionArchiveAction;
            let (action, target) = match command {
                ConversationCommand::Delete { session, force } => (
                    SessionArchiveAction::Delete(if force {
                        DeleteConfirmation::Skip
                    } else {
                        DeleteConfirmation::Prompt
                    }),
                    session,
                ),
                ConversationCommand::Archive { session } => {
                    (SessionArchiveAction::Archive, session)
                }
                ConversationCommand::Unarchive { session } => {
                    (SessionArchiveAction::Unarchive, session)
                }
            };
            let result = codex_tui::run_session_archive_command(
                action,
                target,
                codex_tui::SessionArchiveCommandOptions {
                    cli: inner,
                    arg0_paths,
                    explicit_remote_endpoint: None,
                },
            )
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))?;
            println!("{result}");
            return Ok(());
        }
        let loader_overrides = LoaderOverrides {
            project_config_dir_name: Some(".elpis".to_string()),
            ..LoaderOverrides::default()
        };
        let exit_info = run_main(
            inner,
            arg0_paths,
            loader_overrides,
            /*explicit_remote_endpoint*/ None,
        )
        .await?;
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
