use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use reqwest::Client;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use std::io::IsTerminal;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;
use tempfile::NamedTempFile;

const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/MasihMoafi/Elpis/releases/latest";
const MAX_BINARY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CHECKSUM_BYTES: usize = 16 * 1024;
const PROGRESS_BAR_WIDTH: usize = 28;
const PROGRESS_REDRAW_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
}

struct UpdateConfig {
    latest_release_url: String,
    install_path: PathBuf,
    current_executable: PathBuf,
    current_version: String,
    os: String,
    arch: String,
    persist: fn(NamedTempFile, &Path) -> Result<()>,
    progress: Box<dyn UpdateProgress>,
}

/// Sink for the human-facing account of an update: status notes plus the
/// download's byte-by-byte advance.
trait UpdateProgress {
    fn note(&mut self, message: &str);
    fn start(&mut self, label: &str, total: Option<u64>);
    fn advance(&mut self, downloaded: u64);
    fn finish(&mut self, downloaded: u64);
}

/// Used when stderr is not a terminal, and by the tests.
struct SilentProgress;

impl UpdateProgress for SilentProgress {
    fn note(&mut self, _message: &str) {}
    fn start(&mut self, _label: &str, _total: Option<u64>) {}
    fn advance(&mut self, _downloaded: u64) {}
    fn finish(&mut self, _downloaded: u64) {}
}

struct TerminalProgress {
    total: Option<u64>,
    started: Instant,
    last_redraw: Option<Instant>,
}

impl TerminalProgress {
    fn new() -> Self {
        Self {
            total: None,
            started: Instant::now(),
            last_redraw: None,
        }
    }

    fn line(&self, downloaded: u64, elapsed: f64) -> String {
        let rate = if elapsed > 0.0 {
            format!("{}/s", format_bytes(((downloaded as f64) / elapsed) as u64))
        } else {
            "--".to_string()
        };
        match self.total {
            Some(total) if total > 0 => {
                let fraction = (downloaded as f64 / total as f64).clamp(0.0, 1.0);
                let filled = (fraction * PROGRESS_BAR_WIDTH as f64).round() as usize;
                let bar = format!(
                    "{}{}",
                    "█".repeat(filled),
                    "░".repeat(PROGRESS_BAR_WIDTH - filled)
                );
                format!(
                    "  {bar} {:>3}%  {} / {}  {rate}",
                    (fraction * 100.0).round() as u64,
                    format_bytes(downloaded),
                    format_bytes(total),
                )
            }
            // No Content-Length: report what has landed so far.
            _ => format!("  {} downloaded  {rate}", format_bytes(downloaded)),
        }
    }

    fn redraw(&self, downloaded: u64) {
        let line = self.line(downloaded, self.started.elapsed().as_secs_f64());
        let mut stderr = std::io::stderr();
        let _ = write!(stderr, "\r\u{1b}[K{line}");
        let _ = stderr.flush();
    }
}

impl UpdateProgress for TerminalProgress {
    fn note(&mut self, message: &str) {
        eprintln!("{message}");
    }

    fn start(&mut self, label: &str, total: Option<u64>) {
        eprintln!("{label}");
        self.total = total;
        self.started = Instant::now();
        self.last_redraw = None;
        self.redraw(0);
    }

    fn advance(&mut self, downloaded: u64) {
        let now = Instant::now();
        if self
            .last_redraw
            .is_some_and(|last| now.duration_since(last) < PROGRESS_REDRAW_INTERVAL)
        {
            return;
        }
        self.last_redraw = Some(now);
        self.redraw(downloaded);
    }

    fn finish(&mut self, downloaded: u64) {
        self.redraw(downloaded);
        eprintln!();
    }
}

fn format_bytes(bytes: u64) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    const KIB: f64 = 1024.0;
    let bytes = bytes as f64;
    if bytes >= MIB {
        format!("{:.1} MiB", bytes / MIB)
    } else if bytes >= KIB {
        format!("{:.0} KiB", bytes / KIB)
    } else {
        format!("{bytes:.0} B")
    }
}

/// Debug builds only: lets a local build rehearse the update against a fake
/// release without pointing at the real one or touching the real install.
/// Release builds ignore these entirely.
fn debug_override(key: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(key).ok()
    } else {
        None
    }
}

pub(crate) async fn run() -> Result<String> {
    let home = dirs::home_dir().context("cannot find the home directory")?;
    let progress: Box<dyn UpdateProgress> = if std::io::stderr().is_terminal() {
        Box::new(TerminalProgress::new())
    } else {
        Box::new(SilentProgress)
    };
    let config = UpdateConfig {
        latest_release_url: debug_override("ELPIS_UPDATE_RELEASE_URL")
            .unwrap_or_else(|| LATEST_RELEASE_URL.to_string()),
        install_path: debug_override("ELPIS_UPDATE_INSTALL_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/bin/elpis")),
        current_executable: std::env::current_exe()
            .context("cannot locate the running Elpis binary")?,
        current_version: debug_override("ELPIS_UPDATE_CURRENT_VERSION")
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        persist: persist_update,
        progress,
    };
    run_with_config(config).await
}

async fn run_with_config(mut config: UpdateConfig) -> Result<String> {
    let asset_name = platform_asset_name(&config.os, &config.arch)?;
    require_user_local_install(&config.current_executable, &config.install_path)?;

    config.progress.note("Checking for a newer Elpis release…");
    let client = Client::builder()
        .user_agent(format!("elpis-updater/{}", config.current_version))
        .build()
        .context("cannot create the Elpis update client")?;
    let release = client
        .get(&config.latest_release_url)
        .send()
        .await
        .context("cannot check the latest Elpis release")?
        .error_for_status()
        .context("cannot check the latest Elpis release")?
        .json::<Release>()
        .await
        .context("latest Elpis release metadata is invalid")?;
    let latest_version = release_version(&release.tag_name)?;

    if !is_newer(&latest_version, &config.current_version)? {
        return Ok(format!(
            "Elpis {} is already current (latest: {}).",
            config.current_version, latest_version
        ));
    }

    let binary_url = release_asset_url(&release, asset_name)?;
    let checksum_name = format!("{asset_name}.sha256");
    let checksum_url = release_asset_url(&release, &checksum_name)?;
    let expected_checksum = fetch_checksum(&client, checksum_url, asset_name).await?;

    let parent = config
        .install_path
        .parent()
        .context("Elpis install path has no parent directory")?;
    let mut staged = NamedTempFile::new_in(parent)
        .with_context(|| format!("cannot stage the update in {}", parent.display()))?;
    let actual_checksum = download_binary(
        &client,
        binary_url,
        &mut staged,
        &format!("Downloading Elpis {latest_version} ({asset_name})"),
        config.progress.as_mut(),
    )
    .await?;
    if actual_checksum != expected_checksum {
        bail!(
            "Elpis update checksum mismatch: expected {expected_checksum}, got {actual_checksum}"
        );
    }

    make_executable(&staged)?;
    staged
        .as_file()
        .sync_all()
        .context("cannot flush the staged Elpis update")?;
    (config.persist)(staged, &config.install_path)?;

    Ok(format!(
        "Updated Elpis from {} to {} at {}.",
        config.current_version,
        latest_version,
        config.install_path.display()
    ))
}

fn platform_asset_name(os: &str, arch: &str) -> Result<&'static str> {
    match (os, arch) {
        ("linux", "x86_64") => Ok("elpis-linux-x86_64"),
        _ => bail!("Elpis self-update currently supports Linux x86_64 only"),
    }
}

fn require_user_local_install(current_executable: &Path, install_path: &Path) -> Result<()> {
    let current_executable = current_executable
        .canonicalize()
        .with_context(|| format!("cannot resolve {}", current_executable.display()))?;
    let install_path = install_path
        .canonicalize()
        .with_context(|| format!("cannot resolve {}", install_path.display()))?;
    if current_executable != install_path {
        bail!(
            "self-update is available only for the user-local installation at {}",
            install_path.display()
        );
    }
    Ok(())
}

fn release_version(tag: &str) -> Result<String> {
    let version = tag
        .strip_prefix('v')
        .context("latest Elpis release tag must begin with 'v'")?;
    parse_version(version)?;
    Ok(version.to_string())
}

fn is_newer(latest: &str, current: &str) -> Result<bool> {
    Ok(parse_version(latest)? > parse_version(current)?)
}

fn parse_version(version: &str) -> Result<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let major = parts
        .next()
        .context("missing major version")?
        .parse()
        .context("invalid major version")?;
    let minor = parts
        .next()
        .context("missing minor version")?
        .parse()
        .context("invalid minor version")?;
    let patch = parts
        .next()
        .context("missing patch version")?
        .parse()
        .context("invalid patch version")?;
    if parts.next().is_some() {
        bail!("invalid Elpis release version '{version}'");
    }
    Ok((major, minor, patch))
}

fn release_asset_url<'a>(release: &'a Release, name: &str) -> Result<&'a str> {
    release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .map(|asset| asset.browser_download_url.as_str())
        .with_context(|| format!("latest Elpis release is missing asset '{name}'"))
}

async fn fetch_checksum(client: &Client, url: &str, asset_name: &str) -> Result<String> {
    let bytes = client
        .get(url)
        .send()
        .await
        .context("cannot download the Elpis checksum")?
        .error_for_status()
        .context("cannot download the Elpis checksum")?
        .bytes()
        .await
        .context("cannot read the Elpis checksum")?;
    if bytes.len() > MAX_CHECKSUM_BYTES {
        bail!("Elpis checksum file is unexpectedly large");
    }
    let checksum = std::str::from_utf8(&bytes).context("Elpis checksum is not UTF-8")?;
    parse_checksum(checksum, asset_name)
}

fn parse_checksum(contents: &str, asset_name: &str) -> Result<String> {
    let mut fields = contents.split_whitespace();
    let checksum = fields.next().context("Elpis checksum file is empty")?;
    let named_asset = fields
        .next()
        .context("Elpis checksum file does not name its asset")?
        .trim_start_matches('*')
        .trim_start_matches("./");
    if named_asset != asset_name {
        bail!("Elpis checksum names '{named_asset}' instead of '{asset_name}'");
    }
    if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("Elpis checksum is not a valid SHA-256 digest");
    }
    Ok(checksum.to_ascii_lowercase())
}

async fn download_binary(
    client: &Client,
    url: &str,
    destination: &mut NamedTempFile,
    label: &str,
    progress: &mut dyn UpdateProgress,
) -> Result<String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .context("cannot download the Elpis update")?
        .error_for_status()
        .context("cannot download the Elpis update")?;
    let expected_length = response.content_length();
    if expected_length.is_some_and(|length| length > MAX_BINARY_BYTES) {
        bail!("Elpis update is unexpectedly large");
    }
    progress.start(label, expected_length);

    let mut total = 0_u64;
    let mut hasher = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("cannot read the Elpis update")?
    {
        total = total
            .checked_add(chunk.len() as u64)
            .context("Elpis update size overflow")?;
        if total > MAX_BINARY_BYTES {
            bail!("Elpis update is unexpectedly large");
        }
        hasher.update(&chunk);
        destination
            .write_all(&chunk)
            .context("cannot write the staged Elpis update")?;
        progress.advance(total);
    }
    progress.finish(total);
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(unix)]
fn make_executable(staged: &NamedTempFile) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    staged
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o755))
        .context("cannot make the staged Elpis update executable")
}

#[cfg(not(unix))]
fn make_executable(_staged: &NamedTempFile) -> Result<()> {
    Ok(())
}

fn persist_update(staged: NamedTempFile, install_path: &Path) -> Result<()> {
    staged
        .persist(install_path)
        .map_err(|error| error.error)
        .with_context(|| {
            format!(
                "cannot atomically replace the Elpis binary at {}",
                install_path.display()
            )
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    use std::fs;
    use std::sync::Arc;
    use std::sync::Mutex;
    use tempfile::TempDir;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;
    use wiremock::matchers::method;
    use wiremock::matchers::path;

    struct Fixture {
        _directory: TempDir,
        install_path: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().expect("temporary directory");
            let install_path = directory.path().join("elpis");
            fs::write(&install_path, b"old elpis").expect("write installed fixture");
            Self {
                _directory: directory,
                install_path,
            }
        }

        fn config(&self, server: &MockServer, current_version: &str) -> UpdateConfig {
            UpdateConfig {
                latest_release_url: format!("{}/latest", server.uri()),
                install_path: self.install_path.clone(),
                current_executable: self.install_path.clone(),
                current_version: current_version.to_string(),
                os: "linux".to_string(),
                arch: "x86_64".to_string(),
                persist: persist_update,
                progress: Box::new(SilentProgress),
            }
        }
    }

    #[derive(Default)]
    struct RecordedProgress {
        started: Option<(String, Option<u64>)>,
        advances: Vec<u64>,
        finished: Option<u64>,
    }

    #[derive(Clone, Default)]
    struct RecordingProgress(Arc<Mutex<RecordedProgress>>);

    impl RecordingProgress {
        fn recorded(&self) -> std::sync::MutexGuard<'_, RecordedProgress> {
            self.0.lock().expect("progress lock")
        }
    }

    impl UpdateProgress for RecordingProgress {
        fn note(&mut self, _message: &str) {}

        fn start(&mut self, label: &str, total: Option<u64>) {
            self.recorded().started = Some((label.to_string(), total));
        }

        fn advance(&mut self, downloaded: u64) {
            self.recorded().advances.push(downloaded);
        }

        fn finish(&mut self, downloaded: u64) {
            self.recorded().finished = Some(downloaded);
        }
    }

    async fn mount_release(server: &MockServer, binary: &[u8], checksum: &str) {
        let release = serde_json::json!({
            "tag_name": "v0.1.2",
            "assets": [
                {
                    "name": "elpis-linux-x86_64",
                    "browser_download_url": format!("{}/binary", server.uri())
                },
                {
                    "name": "elpis-linux-x86_64.sha256",
                    "browser_download_url": format!("{}/checksum", server.uri())
                }
            ]
        });
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(release))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/binary"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(binary))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/checksum"))
            .respond_with(ResponseTemplate::new(200).set_body_string(checksum))
            .mount(server)
            .await;
    }

    fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[tokio::test]
    async fn verified_update_atomically_replaces_the_fixture_binary() {
        let server = MockServer::start().await;
        let fixture = Fixture::new();
        let binary = b"new elpis";
        mount_release(
            &server,
            binary,
            &format!("{}  elpis-linux-x86_64\n", sha256(binary)),
        )
        .await;

        let message = run_with_config(fixture.config(&server, "0.1.1"))
            .await
            .expect("successful update");

        assert_eq!(fs::read(&fixture.install_path).unwrap(), binary);
        assert!(message.contains("Updated Elpis from 0.1.1 to 0.1.2"));
    }

    #[tokio::test]
    async fn checksum_mismatch_preserves_the_fixture_binary() {
        let server = MockServer::start().await;
        let fixture = Fixture::new();
        mount_release(
            &server,
            b"new elpis",
            &format!("{}  elpis-linux-x86_64\n", "0".repeat(64)),
        )
        .await;

        let error = run_with_config(fixture.config(&server, "0.1.1"))
            .await
            .expect_err("checksum mismatch");

        assert!(error.to_string().contains("checksum mismatch"));
        assert_eq!(fs::read(&fixture.install_path).unwrap(), b"old elpis");
    }

    #[tokio::test]
    async fn download_failure_preserves_the_fixture_binary() {
        let server = MockServer::start().await;
        let fixture = Fixture::new();
        let release = serde_json::json!({
            "tag_name": "v0.1.2",
            "assets": [
                {
                    "name": "elpis-linux-x86_64",
                    "browser_download_url": format!("{}/missing-binary", server.uri())
                },
                {
                    "name": "elpis-linux-x86_64.sha256",
                    "browser_download_url": format!("{}/missing-checksum", server.uri())
                }
            ]
        });
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(release))
            .mount(&server)
            .await;

        let error = run_with_config(fixture.config(&server, "0.1.1"))
            .await
            .expect_err("download failure");

        assert!(
            error
                .to_string()
                .contains("cannot download the Elpis checksum")
        );
        assert_eq!(fs::read(&fixture.install_path).unwrap(), b"old elpis");
    }

    #[tokio::test]
    async fn replacement_failure_preserves_the_fixture_binary() {
        fn fail_replace(_staged: NamedTempFile, _install_path: &Path) -> Result<()> {
            bail!("simulated replacement failure")
        }

        let server = MockServer::start().await;
        let fixture = Fixture::new();
        let binary = b"new elpis";
        mount_release(
            &server,
            binary,
            &format!("{}  elpis-linux-x86_64\n", sha256(binary)),
        )
        .await;
        let mut config = fixture.config(&server, "0.1.1");
        config.persist = fail_replace;

        let error = run_with_config(config)
            .await
            .expect_err("replacement failure");

        assert!(error.to_string().contains("simulated replacement failure"));
        assert_eq!(fs::read(&fixture.install_path).unwrap(), b"old elpis");
    }

    #[tokio::test]
    async fn already_current_skips_asset_download_and_replacement() {
        let server = MockServer::start().await;
        let fixture = Fixture::new();
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"tag_name": "v0.1.1", "assets": []})),
            )
            .mount(&server)
            .await;

        let message = run_with_config(fixture.config(&server, "0.1.1"))
            .await
            .expect("already current");

        assert!(message.contains("already current"));
        assert_eq!(fs::read(&fixture.install_path).unwrap(), b"old elpis");
    }

    #[tokio::test]
    async fn download_reports_its_size_and_completion_to_the_progress_sink() {
        let server = MockServer::start().await;
        let fixture = Fixture::new();
        let binary = vec![7_u8; 4096];
        mount_release(
            &server,
            &binary,
            &format!("{}  elpis-linux-x86_64\n", sha256(&binary)),
        )
        .await;
        let recorder = RecordingProgress::default();
        let mut config = fixture.config(&server, "0.1.1");
        config.progress = Box::new(recorder.clone());

        run_with_config(config).await.expect("successful update");

        let recorded = recorder.recorded();
        let (label, total) = recorded.started.clone().expect("download started");
        assert!(label.contains("Downloading Elpis 0.1.2"));
        assert_eq!(total, Some(binary.len() as u64));
        assert_eq!(recorded.finished, Some(binary.len() as u64));
        assert_eq!(recorded.advances.last(), Some(&(binary.len() as u64)));
    }

    #[test]
    fn progress_line_renders_percentage_when_the_size_is_known() {
        let mut bar = TerminalProgress::new();
        bar.total = Some(4 * 1024 * 1024);

        let line = bar.line(1024 * 1024, 2.0);

        assert!(line.contains(" 25%"), "{line}");
        assert!(line.contains("1.0 MiB / 4.0 MiB"), "{line}");
        assert!(line.contains("512 KiB/s"), "{line}");
        assert_eq!(line.matches('█').count(), PROGRESS_BAR_WIDTH / 4);
        assert_eq!(
            line.matches('█').count() + line.matches('░').count(),
            PROGRESS_BAR_WIDTH
        );
    }

    #[test]
    fn progress_line_falls_back_to_bytes_when_the_size_is_unknown() {
        let bar = TerminalProgress::new();

        let line = bar.line(2 * 1024 * 1024, 1.0);

        assert!(!line.contains('█'), "{line}");
        assert!(line.contains("2.0 MiB downloaded"), "{line}");
    }

    #[test]
    fn unsupported_platform_is_rejected() {
        assert!(
            platform_asset_name("macos", "aarch64")
                .unwrap_err()
                .to_string()
                .contains("Linux x86_64 only")
        );
    }

    #[test]
    fn checksum_must_name_the_release_asset() {
        let error = parse_checksum(
            &format!("{}  another-file\n", "0".repeat(64)),
            "elpis-linux-x86_64",
        )
        .unwrap_err();
        assert!(error.to_string().contains("instead of"));
    }
}
