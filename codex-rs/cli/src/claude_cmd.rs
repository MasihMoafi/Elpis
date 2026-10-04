//! Elpis: `elpis claude` starts Claude Code behind the Smart Prune proxy.
//!
//! Claude Code keeps its own login. The proxy forwards that login unchanged and runs
//! Smart Prune with the optimizer that `/pruner-model` selects.

use std::sync::Arc;

use anyhow::Context;
use codex_core::StandaloneOptimizer;
use codex_core::config::Config;
use codex_elpis_claude_proxy::ANTHROPIC_ORIGIN;
use codex_elpis_claude_proxy::ProxyOptions;

#[derive(Debug, clap::Parser)]
pub struct ClaudeCommand {
    /// Forward each request unchanged. Use it to compare costs with pruning off.
    #[arg(long)]
    pub no_prune: bool,

    /// Do not open the session page in the browser. Elpis still prints its link.
    #[arg(long)]
    pub no_browser: bool,

    /// Arguments for `claude`.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    pub args: Vec<String>,
}

impl ClaudeCommand {
    pub async fn run(self, overrides: Vec<(String, toml::Value)>) -> anyhow::Result<()> {
        let config = Arc::new(
            Config::load_with_cli_overrides(overrides)
                .await
                .context("failed to load configuration")?,
        );
        let auth_manager = crate::plugin_cmd::load_cli_auth_manager(&config).await?;
        let optimizer = Arc::new(StandaloneOptimizer::new(Arc::clone(&config), auth_manager));
        let proxy = codex_elpis_claude_proxy::start(
            ProxyOptions {
                upstream: ANTHROPIC_ORIGIN.to_string(),
                log_dir: config
                    .codex_home
                    .join("logs")
                    .join("claude-proxy")
                    .to_path_buf(),
                prune: !self.no_prune,
            },
            optimizer,
        )
        .await
        .context("failed to start the Smart Prune proxy")?;
        let page = proxy.page_url();
        eprintln!("Elpis · Smart Prune for this Claude Code session: {page}");
        if !self.no_browser
            && let Err(error) = webbrowser::open(&page)
        {
            eprintln!("Elpis · could not open the browser: {error}");
        }
        // Claude Code handles Ctrl-C itself. Elpis must stay alive, or the proxy stops.
        tokio::spawn(async { while tokio::signal::ctrl_c().await.is_ok() {} });
        // `prepare_elpis_environment` already put the loopback hosts in NO_PROXY.
        let status = tokio::process::Command::new("claude")
            .args(&self.args)
            .env("ANTHROPIC_BASE_URL", proxy.origin())
            .status()
            .await
            .context("failed to start `claude`. Is Claude Code installed?")?;
        std::process::exit(status.code().unwrap_or(1));
    }
}
