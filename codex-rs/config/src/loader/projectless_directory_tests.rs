//! Projectless classification requires completed discovery without project inputs.

use crate::ConfigLayerStack;
use crate::LoaderOverrides;
use crate::NoopThreadConfigLoader;
use crate::loader::find_project_root;
use crate::loader::load_config_layers_state;
use crate::loader::project_trust_key;
use crate::loader::tests::TestFileSystem;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_absolute_path::AbsolutePathBufGuard;
use pretty_assertions::assert_eq;
use tempfile::TempDir;
use toml::Value as TomlValue;

struct Fixture {
    _temp: TempDir,
    home: AbsolutePathBuf,
    cwd: AbsolutePathBuf,
    overrides: LoaderOverrides,
}

impl Fixture {
    fn new() -> anyhow::Result<Self> {
        let temp = tempfile::tempdir()?;
        let root = AbsolutePathBuf::from_absolute_path(temp.path().canonicalize()?)?;
        let home = root.join("home");
        let cwd = root.join("workspace");
        std::fs::create_dir_all(&home)?;
        std::fs::create_dir_all(&cwd)?;
        Ok(Self {
            _temp: temp,
            home,
            cwd,
            overrides: LoaderOverrides::without_managed_config_for_tests(),
        })
    }

    async fn load(&self) -> anyhow::Result<ConfigLayerStack> {
        Ok(load_config_layers_state(
            &TestFileSystem,
            self.home.as_path(),
            Some(self.cwd.clone()),
            &[],
            self.overrides.clone(),
            &NoopThreadConfigLoader,
        )
        .await?)
    }

    fn load_with_user_home(&self, user_home: &std::path::Path) -> anyhow::Result<ConfigLayerStack> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        // The thread-local override stays on this thread until both loads finish.
        AbsolutePathBufGuard::with_home_directory(user_home, || {
            runtime.block_on(async {
                let stack = self.load().await?;
                let local = super::local::load_local_config_layers_with_overrides(
                    &TestFileSystem,
                    self.home.as_path(),
                    &self.cwd,
                    &self.overrides,
                )
                .await?;
                let expected: Vec<_> = stack
                    .layers_low_to_high()
                    .filter(|layer| matches!(layer.name, crate::ConfigLayerSource::Project { .. }))
                    .map(|layer| &layer.name)
                    .collect();
                let actual: Vec<_> = local
                    .config
                    .layers
                    .iter()
                    .filter(|layer| {
                        matches!(layer.source, crate::ConfigLayerSource::Project { .. })
                    })
                    .map(|layer| &layer.source)
                    .collect();
                assert_eq!(actual, expected);
                Ok(stack)
            })
        })
    }
}

#[tokio::test]
async fn project_root_lookup_preserves_cwd_fallback() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    let markers = vec![".company-root".to_string()];
    for markers in [&[][..], markers.as_slice()] {
        assert_eq!(
            find_project_root(&TestFileSystem, &fixture.cwd, markers).await?,
            fixture.cwd,
        );
    }

    std::fs::create_dir(fixture.cwd.join(".company-root"))?;
    let nested = fixture.cwd.join("nested");
    std::fs::create_dir(&nested)?;
    assert_eq!(
        find_project_root(&TestFileSystem, &nested, &markers).await?,
        fixture.cwd,
    );
    Ok(())
}

#[tokio::test]
async fn unmarked_directory_is_projectless_even_with_saved_trust() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    assert!(fixture.load().await?.is_projectless());
    let key = TomlValue::String(project_trust_key(fixture.cwd.as_path()));
    for level in ["trusted", "untrusted"] {
        std::fs::write(
            fixture.home.join("config.toml"),
            format!("[projects.{key}]\ntrust_level = \"{level}\"\n"),
        )?;
        assert!(fixture.load().await?.is_projectless(), "{level}");
    }
    Ok(())
}

#[tokio::test]
async fn skipped_discovery_does_not_claim_projectless() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    for (cwd, ignore_project_config) in [(None, false), (Some(fixture.cwd.clone()), true)] {
        let layers = load_config_layers_state(
            &TestFileSystem,
            fixture.home.as_path(),
            cwd,
            &[],
            LoaderOverrides {
                ignore_project_config,
                ..fixture.overrides.clone()
            },
            &NoopThreadConfigLoader,
        )
        .await?;
        assert!(!layers.is_projectless());
    }
    Ok(())
}

#[tokio::test]
async fn project_markers_and_local_layers_prevent_projectless_classification() -> anyhow::Result<()>
{
    for (marker, config, child) in [
        (".git", "", ""),
        (".git", "", "nested"),
        (".git", "project_root_markers = []", "nested"),
        (".codex", "", ""),
        (".codex", "project_root_markers = ['.codex']", "nested"),
        (
            ".company-root",
            "project_root_markers = ['.company-root']",
            "",
        ),
        (
            ".company-root",
            "project_root_markers = ['.company-root']",
            "nested",
        ),
    ] {
        let mut fixture = Fixture::new()?;
        std::fs::create_dir(fixture.cwd.join(marker))?;
        if marker == ".git" {
            std::fs::write(fixture.cwd.join(".git/HEAD"), "ref: refs/heads/main\n")?;
        }
        std::fs::write(fixture.home.join("config.toml"), config)?;
        fixture.cwd = fixture.cwd.join(child);
        std::fs::create_dir_all(&fixture.cwd)?;
        assert!(
            !fixture.load().await?.is_projectless(),
            "marker={marker}, config={config}, child={child}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn user_codex_home_is_not_a_project_layer() -> anyhow::Result<()> {
    let mut fixture = Fixture::new()?;
    fixture.home = fixture.cwd.join(".codex");
    std::fs::create_dir(&fixture.home)?;
    std::fs::write(fixture.home.join("config.toml"), "model = 'user-model'\n")?;
    assert!(fixture.load().await?.is_projectless());
    Ok(())
}

#[test]
fn elpis_separate_codex_user_home_is_not_project_input() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    let codex_home = fixture.cwd.join(".codex");
    std::fs::create_dir(&codex_home)?;
    let trust_key = TomlValue::String(project_trust_key(fixture.cwd.as_path()));
    for trust in ["trusted", "untrusted"] {
        std::fs::write(
            fixture.home.join("config.toml"),
            format!("model = 'elpis-model'\n[projects.{trust_key}]\ntrust_level = '{trust}'\n"),
        )?;
        for contents in [
            "model = 'codex-user-model'\n[otel]\nexporter = 'none'\n",
            "broken = [",
        ] {
            std::fs::write(codex_home.join("config.toml"), contents)?;
            let stack = fixture.load_with_user_home(fixture.cwd.as_path())?;
            assert!(stack.is_projectless());
            assert_eq!(
                stack.effective_config()["model"].as_str(),
                Some("elpis-model")
            );
            assert_eq!(stack.startup_warnings(), Some([].as_slice()));
            assert_eq!(
                std::fs::read_to_string(codex_home.join("config.toml"))?,
                contents
            );
        }
    }
    Ok(())
}

#[test]
fn elpis_real_project_config_and_restrictions_remain() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    let project_config = fixture.cwd.join(".codex");
    std::fs::create_dir(&project_config)?;
    std::fs::write(
        project_config.join("config.toml"),
        "model = 'project-model'\n[otel]\nexporter = 'none'\n",
    )?;
    let trust_key = TomlValue::String(project_trust_key(fixture.cwd.as_path()));
    std::fs::write(
        fixture.home.join("config.toml"),
        format!("model = 'elpis-model'\n[projects.{trust_key}]\ntrust_level = 'trusted'\n"),
    )?;
    let stack = fixture.load_with_user_home(fixture._temp.path())?;
    assert!(!stack.is_projectless());
    assert_eq!(
        stack.effective_config()["model"].as_str(),
        Some("project-model")
    );
    let warnings = stack.startup_warnings().expect("discovery finished");
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("otel"));
    assert!(warnings[0].contains(&project_config.as_path().display().to_string()));
    Ok(())
}

#[cfg(unix)]
#[test]
fn elpis_symlink_to_codex_user_home_is_not_project_input() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    let user_home = fixture._temp.path().join("user-home");
    let codex_home = user_home.join(".codex");
    std::fs::create_dir_all(&codex_home)?;
    std::fs::write(codex_home.join("config.toml"), "broken = [")?;
    std::os::unix::fs::symlink(&codex_home, fixture.cwd.join(".codex"))?;
    let trust_key = TomlValue::String(project_trust_key(fixture.cwd.as_path()));
    std::fs::write(
        fixture.home.join("config.toml"),
        format!("[projects.{trust_key}]\ntrust_level = 'trusted'\n"),
    )?;
    let stack = fixture.load_with_user_home(&user_home)?;
    assert!(stack.is_projectless());
    assert_eq!(stack.startup_warnings(), Some([].as_slice()));
    Ok(())
}

#[tokio::test]
async fn managed_root_markers_control_projectless_classification() -> anyhow::Result<()> {
    let mut fixture = Fixture::new()?;
    std::fs::create_dir(fixture.cwd.join(".company-root"))?;
    fixture.cwd = fixture.cwd.join("nested");
    std::fs::create_dir(&fixture.cwd)?;
    std::fs::write(
        fixture.home.join("config.toml"),
        "project_root_markers = []",
    )?;
    let managed = fixture.home.join("managed_config.toml");
    fixture.overrides = LoaderOverrides::with_managed_config_path_for_tests(managed.to_path_buf());
    for (markers, expected) in [("['.company-root']", false), ("[]", true)] {
        std::fs::write(&managed, format!("project_root_markers = {markers}\n"))?;
        assert_eq!(
            fixture.load().await?.is_projectless(),
            expected,
            "{markers}"
        );
    }
    Ok(())
}
