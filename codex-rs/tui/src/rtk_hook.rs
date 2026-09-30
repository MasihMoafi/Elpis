// Elpis: layer 1 of the pruning pipeline rewrites supported shell commands through RTK
// before their output reaches the model. The rewrite only happens if a `PreToolUse` hook
// invoking RTK is registered, so a fresh install has no layer 1 until one is written.
// This provisions that hook once, when RTK is installed and the user has no hooks file.
use std::path::Path;

/// Hook definition written to `<codex_home>/hooks.json` on a first run that finds RTK.
const RTK_HOOKS_JSON: &str = r#"{
  "description": "Use RTK to reduce shell-command output before it enters agent context.",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "rtk hook claude",
            "timeout": 5,
            "statusMessage": "compressing shell output with RTK"
          }
        ]
      }
    ]
  }
}
"#;

/// Register RTK's `PreToolUse` hook when the user has no hooks file of their own.
///
/// Does nothing when `hooks.json` already exists — an empty `{"hooks":{}}` is therefore
/// how a user opts out permanently — or when RTK is not on `PATH`. The hook still passes
/// through the normal startup trust review before it can run.
pub(crate) fn ensure_rtk_hook(codex_home: &Path) {
    ensure_rtk_hook_with(codex_home, || which::which("rtk").is_ok());
}

fn ensure_rtk_hook_with(codex_home: &Path, rtk_is_installed: impl FnOnce() -> bool) {
    let hooks_path = codex_home.join("hooks.json");
    if hooks_path.exists() || !rtk_is_installed() {
        return;
    }
    if let Err(err) = std::fs::create_dir_all(codex_home)
        .and_then(|()| std::fs::write(&hooks_path, RTK_HOOKS_JSON))
    {
        tracing::warn!("failed to register the RTK hook at {hooks_path:?}: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn writes_the_hook_when_rtk_is_installed_and_no_hooks_file_exists() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");

        ensure_rtk_hook_with(&home, || true);

        let written = fs::read_to_string(home.join("hooks.json")).expect("hooks.json written");
        assert!(written.contains("rtk hook claude"));
        let parsed: serde_json::Value = serde_json::from_str(&written).expect("valid json");
        assert_eq!(parsed["hooks"]["PreToolUse"][0]["matcher"], "^Bash$");
    }

    #[test]
    fn leaves_an_existing_hooks_file_untouched() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        fs::create_dir_all(&home).expect("create home");
        fs::write(home.join("hooks.json"), "{\"hooks\":{}}").expect("write user hooks");

        ensure_rtk_hook_with(&home, || true);

        let written = fs::read_to_string(home.join("hooks.json")).expect("read hooks.json");
        assert_eq!(written, "{\"hooks\":{}}");
    }

    #[test]
    fn writes_nothing_when_rtk_is_not_installed() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");

        ensure_rtk_hook_with(&home, || false);

        assert!(!home.join("hooks.json").exists());
    }
}
