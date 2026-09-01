use codex_utils_absolute_path::AbsolutePathBuf;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fmt;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

const MAX_GOAL_CHARS: usize = 6_000;
const MAX_CHECKPOINT_CHARS: usize = 8_000;
const MAX_RULE_CHARS: usize = 8_000;
pub const MANUAL_MEMORY_LIMIT_CHARS: usize = 8_000;
pub const ELPIS_CONTINUITY_PROMPT_PREFIX: &str = "## Elpis Admitted Context\n\n\
    These are the user-visible sources Elpis admitted for this workspace. They are not a full\n\
    transcript. Verify mutable repository state before acting, and prefer the current user\n\
    message when it changes the task.\n\n";
const ADMISSION_FILE: &str = "admission.toml";
const MANUAL_MEMORY_FILE: &str = "MEMORY.md";
const MANUAL_MEMORY_TEMPLATE: &str = "# Elpis Memory\n";
const MANUAL_MEMORY_ADD_GUIDANCE: &str =
    "MEMORY.md is managed by the Memory row; use the Memory row";
const INVALID_ADMISSION_MESSAGE: &str = "admission record is invalid";

const GLOBAL_RULES: &str = "Global AGENTS.md";
const PROJECT_RULES: &str = "Project AGENTS.md";
const DEV_SOURCE_PREFIX: &str = "dev/";

/// Whether an optional ledger row is admitted before the user has said anything about it.
/// A file existing on disk is not consent to spend the model's context window on it.
const DEFAULT_OPTIONAL_ADMISSION: bool = false;
const DEFAULT_DEV_RULE_ADMISSION: bool = true;

/// Which context sources the user has admitted for this workspace.
///
/// Every non-development-rule field defaults to off: an unset row means the user has not
/// asked for that file, not that Elpis may spend context on it. Development rules are
/// admitted by default; rows the user has never touched are absent from the stored maps.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(default)]
struct ContinuityAdmission {
    global_rules: bool,
    project_rules: bool,
    goal: bool,
    checkpoint: bool,
    memory: bool,
    /// Per-file admission for `skills/dev/*.md`, keyed by file name.
    dev_sources: BTreeMap<String, bool>,
    custom_sources: BTreeMap<String, bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct StoredContinuityAdmission {
    global_rules: Option<bool>,
    project_rules: Option<bool>,
    goal: Option<bool>,
    checkpoint: Option<bool>,
    memory: Option<bool>,
    dev_sources: Option<BTreeMap<String, bool>>,
    custom_sources: Option<BTreeMap<String, bool>>,
}

#[derive(Debug, Default)]
struct LegacyContinuityAdmission {
    global_rules: Option<bool>,
    project_rules: Option<bool>,
    goal: Option<bool>,
    checkpoint: Option<bool>,
    memory: Option<bool>,
    dev_sources: BTreeMap<String, bool>,
}

impl ContinuityAdmission {
    /// Whether the named ledger row is admitted. Development-rule rows are admitted by
    /// default; all other optional rows require an explicit user choice.
    fn admits_row(&self, name: &str) -> bool {
        match name {
            GLOBAL_RULES => self.global_rules,
            PROJECT_RULES => self.project_rules,
            "GOAL.md" => self.goal,
            "ES.md" => self.checkpoint,
            "MEMORY.md" => self.memory,
            name if name.starts_with(DEV_SOURCE_PREFIX) => self
                .dev_sources
                .get(&name[DEV_SOURCE_PREFIX.len()..])
                .copied()
                .unwrap_or(DEFAULT_DEV_RULE_ADMISSION),
            name => self
                .custom_sources
                .get(name)
                .copied()
                .unwrap_or(DEFAULT_OPTIONAL_ADMISSION),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManualMemoryAdmissionState {
    Missing,
    AvailableNotAdmitted,
    Admitted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManualMemoryUnavailableReason {
    AdmissionUnavailable,
    MemoryUnreadable,
    InvalidUtf8,
    MemoryPathNotFile,
}

#[derive(Debug)]
pub struct ManualMemoryStatusError {
    pub reason: ManualMemoryUnavailableReason,
    source: std::io::Error,
}

impl ManualMemoryStatusError {
    fn new(reason: ManualMemoryUnavailableReason, source: std::io::Error) -> Self {
        Self { reason, source }
    }

    fn into_io_error(self) -> std::io::Error {
        let kind = self.source.kind();
        std::io::Error::new(kind, self)
    }
}

impl fmt::Display for ManualMemoryStatusError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.reason {
            ManualMemoryUnavailableReason::AdmissionUnavailable => {
                "manual memory admission is unavailable"
            }
            ManualMemoryUnavailableReason::MemoryUnreadable => "manual memory is unreadable",
            ManualMemoryUnavailableReason::InvalidUtf8 => "manual memory is not valid UTF-8",
            ManualMemoryUnavailableReason::MemoryPathNotFile => {
                "manual memory path is not a file"
            }
        })
    }
}

impl std::error::Error for ManualMemoryStatusError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManualMemoryStatus {
    pub state: ManualMemoryAdmissionState,
    pub bytes: u64,
    pub request_chars_if_admitted: usize,
    pub eligible_chars_now: usize,
    pub limit_chars: usize,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InjectedPersistenceFailure {
    AdmissionRead,
    AdmissionTempCreate,
    AdmissionTempWrite,
    AdmissionTempSync,
    AdmissionRename,
    AdmissionDirectorySync,
    MemoryPostReadAdmission,
    TemplateWrite,
    TemplateSync,
}

#[cfg(test)]
std::thread_local! {
    static INJECTED_PERSISTENCE_FAILURE: std::cell::Cell<Option<InjectedPersistenceFailure>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub(crate) struct InjectedPersistenceFailureGuard(Option<InjectedPersistenceFailure>);

#[cfg(test)]
impl Drop for InjectedPersistenceFailureGuard {
    fn drop(&mut self) {
        INJECTED_PERSISTENCE_FAILURE.with(|failure| failure.set(self.0));
    }
}

#[cfg(test)]
fn inject_persistence_failure(
    stage: InjectedPersistenceFailure,
) -> InjectedPersistenceFailureGuard {
    let previous = INJECTED_PERSISTENCE_FAILURE.with(|failure| failure.replace(Some(stage)));
    InjectedPersistenceFailureGuard(previous)
}

#[cfg(test)]
pub(crate) fn inject_admission_read_failure() -> InjectedPersistenceFailureGuard {
    inject_persistence_failure(InjectedPersistenceFailure::AdmissionRead)
}

fn fail_if_injected(stage: InjectedPersistenceFailure) -> std::io::Result<()> {
    #[cfg(test)]
    if INJECTED_PERSISTENCE_FAILURE.with(|failure| {
        if failure.get() == Some(stage) {
            failure.set(None);
            true
        } else {
            false
        }
    }) {
        return Err(std::io::Error::other(format!(
            "injected persistence failure at {stage:?}"
        )));
    }
    #[cfg(not(test))]
    let _ = stage;
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContinuitySource {
    pub name: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub estimated_tokens: u64,
    pub category: ContinuitySourceCategory,
    pub origin: &'static str,
    pub lifetime: &'static str,
    pub reason: &'static str,
    pub admitted: bool,
    pub selectable: bool,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ContinuitySourceCategory {
    Files,
    Memory,
    Instructions,
}

impl ContinuitySourceCategory {
    pub const ALL: [Self; 3] = [Self::Files, Self::Memory, Self::Instructions];

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Files => "SESSION CONTINUITY",
            Self::Memory => "DURABLE MEMORY",
            Self::Instructions => "INSTRUCTIONS",
        }
    }
}

/// True when `GOAL.md` records a finished objective. The status line is written by the
/// goal writer itself, so this needs no database lookup.
fn goal_is_complete(goal_path: &Path) -> bool {
    let Ok(contents) = std::fs::read_to_string(goal_path) else {
        return false;
    };
    contents
        .lines()
        .take(12)
        .filter_map(|line| line.trim().strip_prefix("- Status:"))
        .any(|status| {
            let status = status.trim();
            status.eq_ignore_ascii_case("complete") || status.eq_ignore_ascii_case("completed")
        })
}

/// True when `ES.md` records a finished or failed session checkpoint.
fn checkpoint_is_complete(checkpoint_path: &Path) -> bool {
    let Ok(contents) = std::fs::read_to_string(checkpoint_path) else {
        return false;
    };
    contents
        .lines()
        .take(12)
        .filter_map(|line| line.trim().strip_prefix("- Status:"))
        .any(|status| {
            let status = status.trim();
            status.eq_ignore_ascii_case("complete")
                || status.eq_ignore_ascii_case("completed")
                || status.eq_ignore_ascii_case("failed")
                || status.eq_ignore_ascii_case("abandoned")
        })
}

pub fn workspace_context_dir(memories_root: Option<&Path>, cwd: &Path) -> Option<PathBuf> {
    let elpis_home = memories_root?.parent()?;
    Some(
        elpis_home
            .join("context")
            .join("workspaces")
            .join(workspace_key(cwd)),
    )
}

/// Returns the two stable paths that identify manual-memory storage for a workspace.
/// Neither path has to exist yet.
pub fn manual_memory_storage_paths(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> Option<(PathBuf, PathBuf)> {
    let memories_root = memories_root?;
    Some((
        workspace_context_dir(Some(memories_root), cwd)?.join(ADMISSION_FILE),
        memories_root.join(MANUAL_MEMORY_FILE),
    ))
}

pub fn manual_memory_status(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> Result<Option<ManualMemoryStatus>, ManualMemoryStatusError> {
    let Some(memories_root) = memories_root else {
        return Ok(None);
    };
    let workspace_dir = workspace_context_dir(Some(memories_root), cwd).ok_or_else(|| {
        ManualMemoryStatusError::new(
            ManualMemoryUnavailableReason::AdmissionUnavailable,
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "manual memory admission directory is unavailable",
            ),
        )
    })?;
    let admission = read_admission(&workspace_dir).map_err(|error| {
        ManualMemoryStatusError::new(
            ManualMemoryUnavailableReason::AdmissionUnavailable,
            error,
        )
    })?;
    manual_memory_status_with_admission(memories_root, admission.memory).map(Some)
}

fn manual_memory_status_with_admission(
    memories_root: &Path,
    admitted: bool,
) -> Result<ManualMemoryStatus, ManualMemoryStatusError> {
    let path = memories_root.join(MANUAL_MEMORY_FILE);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ManualMemoryStatus {
                state: ManualMemoryAdmissionState::Missing,
                bytes: 0,
                request_chars_if_admitted: 0,
                eligible_chars_now: 0,
                limit_chars: MANUAL_MEMORY_LIMIT_CHARS,
                truncated: false,
            });
        }
        Err(error) => {
            return Err(ManualMemoryStatusError::new(
                ManualMemoryUnavailableReason::MemoryUnreadable,
                error,
            ));
        }
    };
    if !metadata.is_file() {
        return Err(ManualMemoryStatusError::new(
            ManualMemoryUnavailableReason::MemoryPathNotFile,
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "manual memory path is not a regular file",
            ),
        ));
    }
    let bytes = std::fs::read(&path).map_err(|error| {
        ManualMemoryStatusError::new(ManualMemoryUnavailableReason::MemoryUnreadable, error)
    })?;
    let byte_count = bytes.len() as u64;
    let content = String::from_utf8(bytes).map_err(|error| {
        ManualMemoryStatusError::new(
            ManualMemoryUnavailableReason::InvalidUtf8,
            std::io::Error::new(std::io::ErrorKind::InvalidData, error),
        )
    })?;
    let trimmed = content.trim();
    let trimmed_chars = trimmed.chars().count();
    let request_chars_if_admitted =
        truncate_chars(trimmed, MANUAL_MEMORY_LIMIT_CHARS).chars().count();
    let state = if admitted {
        ManualMemoryAdmissionState::Admitted
    } else {
        ManualMemoryAdmissionState::AvailableNotAdmitted
    };
    Ok(ManualMemoryStatus {
        state,
        bytes: byte_count,
        request_chars_if_admitted,
        eligible_chars_now: if admitted {
            request_chars_if_admitted
        } else {
            0
        },
        limit_chars: MANUAL_MEMORY_LIMIT_CHARS,
        truncated: trimmed_chars > MANUAL_MEMORY_LIMIT_CHARS,
    })
}

pub fn create_manual_memory(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> std::io::Result<ManualMemoryStatus> {
    let Some(memories_root) = memories_root else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "manual memory storage is unavailable",
        ));
    };
    std::fs::create_dir_all(memories_root)?;
    let path = memories_root.join(MANUAL_MEMORY_FILE);
    let mut memory_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;

    if let Err(error) = set_continuity_source_admitted(
        Some(memories_root),
        cwd,
        MANUAL_MEMORY_FILE,
        false,
    ) {
        return Err(std::io::Error::new(
            error.kind(),
            format!("empty memory file reserved; no template written: {error}"),
        ));
    }

    fail_if_injected(InjectedPersistenceFailure::TemplateWrite).map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("memory reserved and admission disabled; template write failed: {error}"),
        )
    })?;
    memory_file
        .write_all(MANUAL_MEMORY_TEMPLATE.as_bytes())
        .map_err(|error| {
            std::io::Error::new(
                error.kind(),
                format!(
                    "memory reserved and admission disabled; template write was partial: {error}"
                ),
            )
        })?;
    fail_if_injected(InjectedPersistenceFailure::TemplateSync).map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("memory template written but not synced; admission remains disabled: {error}"),
        )
    })?;
    memory_file.sync_all().map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("memory template written but not synced; admission remains disabled: {error}"),
        )
    })?;

    manual_memory_status(Some(memories_root), cwd)
        .map_err(ManualMemoryStatusError::into_io_error)?
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "manual memory storage is unavailable",
            )
        })
}

pub async fn build_continuity_prompt(memories_root: Option<&Path>, cwd: &Path) -> Option<String> {
    build_continuity_prompt_with_dev_rule_roots(memories_root, cwd, &[]).await
}

pub async fn build_continuity_prompt_with_dev_rule_roots(
    memories_root: Option<&Path>,
    cwd: &Path,
    dev_rule_roots: &[AbsolutePathBuf],
) -> Option<String> {
    let mut sections = Vec::new();
    // Global/project AGENTS.md are deliberately NOT injected here: the app server
    // already sends them natively as instructions, and re-reading them into this prompt
    // double-sent every rule file on every turn. `continuity_sources` still auto-discovers
    // them on disk when given an empty instruction list (other callers, like the Context
    // Ledger, rely on that fallback), so they're skipped explicitly by name here instead.
    // `skills/dev/*.md` rows, by contrast, come from `continuity_sources`'s own on-disk
    // discovery (the server never reports them), so they DO get read and injected below —
    // that discovery is the only way they reach the model at all. Every other skill stays
    // out: the skills service advertises compact metadata and loads a selected skill
    // through its native path rather than admitting a whole library as always-on context.
    let Ok(sources) =
        continuity_sources_with_dev_rule_roots(memories_root, cwd, &[], dev_rule_roots)
    else {
        return None;
    };
    for source in sources {
        if !source.admitted || source.name == GLOBAL_RULES || source.name == PROJECT_RULES {
            continue;
        }
        if let Some(section) =
            read_continuity_source_section(&source, memories_root, cwd).await
        {
            sections.push(section);
        }
    }
    if sections.is_empty() {
        return None;
    }
    Some(format!("{ELPIS_CONTINUITY_PROMPT_PREFIX}{}", sections.join("\n\n")))
}

async fn read_continuity_source_section(
    source: &ContinuitySource,
    memories_root: Option<&Path>,
    cwd: &Path,
) -> Option<String> {
    let content = tokio::fs::read_to_string(&source.path).await.ok()?;
    let content = truncate_chars(content.trim(), source_char_limit(&source.name));
    if content.is_empty() {
        return None;
    }
    if source.name == MANUAL_MEMORY_FILE {
        let workspace_dir = workspace_context_dir(memories_root, cwd)?;
        let admission = fail_if_injected(InjectedPersistenceFailure::MemoryPostReadAdmission)
            .and_then(|()| read_admission(&workspace_dir))
            .ok()?;
        if !admission.memory {
            return None;
        }
    }
    Some(format!(
        "### Source: {} ({} characters)\n\n{}",
        source.path.display(),
        content.chars().count(),
        content
    ))
}

/// Lists every source the ledger and `/status` must agree on. Instruction rows come
/// from `instruction_source_paths` — the paths the app server actually loaded and
/// sends natively — never from guessed filesystem locations, so the two surfaces
/// can no longer disagree. A manually `/add`-ed file whose canonical path is already
/// covered by another row is skipped (dedupe).
pub fn continuity_sources(
    memories_root: Option<&Path>,
    cwd: &Path,
    instruction_source_paths: &[PathBuf],
) -> std::io::Result<Vec<ContinuitySource>> {
    continuity_sources_with_dev_rule_roots(memories_root, cwd, instruction_source_paths, &[])
}

pub fn continuity_sources_with_dev_rule_roots(
    memories_root: Option<&Path>,
    cwd: &Path,
    instruction_source_paths: &[PathBuf],
    dev_rule_roots: &[AbsolutePathBuf],
) -> std::io::Result<Vec<ContinuitySource>> {
    let Some(memories_root) = memories_root else {
        return Ok(Vec::new());
    };
    let Some(workspace_dir) = workspace_context_dir(Some(memories_root), cwd) else {
        return Ok(Vec::new());
    };
    let admission = read_admission(&workspace_dir)?;
    let manual_memory = manual_memory_status_with_admission(memories_root, admission.memory)
        .map_err(ManualMemoryStatusError::into_io_error)?;
    continuity_sources_with_state(
        memories_root,
        cwd,
        instruction_source_paths,
        dev_rule_roots,
        &admission,
        Some(&manual_memory),
        &workspace_dir,
    )
}

pub fn continuity_sources_from_manual_memory_status(
    memories_root: Option<&Path>,
    cwd: &Path,
    instruction_source_paths: &[PathBuf],
    dev_rule_roots: &[AbsolutePathBuf],
    manual_memory: Option<&ManualMemoryStatus>,
) -> std::io::Result<Vec<ContinuitySource>> {
    let Some(memories_root) = memories_root else {
        return Ok(Vec::new());
    };
    let Some(workspace_dir) = workspace_context_dir(Some(memories_root), cwd) else {
        return Ok(Vec::new());
    };
    let admission = read_admission(&workspace_dir)?;
    continuity_sources_with_state(
        memories_root,
        cwd,
        instruction_source_paths,
        dev_rule_roots,
        &admission,
        manual_memory,
        &workspace_dir,
    )
}

fn continuity_sources_with_state(
    memories_root: &Path,
    cwd: &Path,
    instruction_source_paths: &[PathBuf],
    dev_rule_roots: &[AbsolutePathBuf],
    admission: &ContinuityAdmission,
    manual_memory: Option<&ManualMemoryStatus>,
    workspace_dir: &Path,
) -> std::io::Result<Vec<ContinuitySource>> {
    let mut sources = Vec::new();
    let mut canonical_paths = std::collections::HashSet::new();

    let runtime_instruction_paths = !instruction_source_paths.is_empty();
    let mut instruction_paths: Vec<PathBuf> = instruction_source_paths.to_vec();
    if !runtime_instruction_paths {
        let proj_agents = cwd.join("AGENTS.md");
        if proj_agents.exists() {
            instruction_paths.push(proj_agents);
        }
    }

    // Dev rules are on by default and can be switched off per file in the ledger.
    // Elpis installs one portable canonical set under its own home. Machine-specific
    // additions are opt-in through ELPIS_DEV_SKILLS_DIRS. A project-sibling folder is
    // deliberately not scanned: on a development checkout it is usually the source of
    // the installed rules and listing both copies produced duplicate context.
    let (dev_dirs, dev_origin): (Vec<PathBuf>, &'static str) = if dev_rule_roots.is_empty() {
        let mut dirs = Vec::new();
        if let Some(elpis_home) = memories_root.parent() {
            dirs.push(elpis_home.join("skills/dev"));
        }
        dirs.extend(
            std::env::var_os("ELPIS_DEV_SKILLS_DIRS")
                .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
                .unwrap_or_default(),
        );
        (dirs, "managed development rules")
    } else {
        (
            dev_rule_roots
                .iter()
                .map(|root| root.as_path().to_path_buf())
                .collect(),
            "configured development rules",
        )
    };

    let mut already_listed: std::collections::HashSet<PathBuf> = instruction_paths
        .iter()
        .filter_map(|path| path.canonicalize().ok())
        .collect();

    let mut seen_dev_file_names = std::collections::HashSet::new();
    let mut dev_files = Vec::new();
    for dev_dir in &dev_dirs {
        if let Ok(entries) = std::fs::read_dir(dev_dir) {
            let mut root_files: Vec<(PathBuf, PathBuf)> = entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
                .filter(|path| {
                    matches!(
                        std::fs::metadata(path),
                        Ok(metadata) if metadata.is_file() && metadata.len() > 0
                    )
                })
                .filter_map(|path| path.canonicalize().ok().map(|canonical| (path, canonical)))
                .collect();
            root_files.sort_by(|(left, _), (right, _)| left.cmp(right));
            for (path, canonical) in root_files {
                let Some(file_name) = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(ToOwned::to_owned)
                else {
                    continue;
                };
                if already_listed.contains(&canonical) || seen_dev_file_names.contains(&file_name)
                {
                    continue;
                }
                already_listed.insert(canonical.clone());
                seen_dev_file_names.insert(file_name);
                dev_files.push((path, canonical));
            }
        }
    }

    for path in &instruction_paths {
        let (name, reason) = instruction_source_row(path, cwd);
        let admitted = admission.admits_row(&name);
        if let Some(source) = existing_file_source(
            name,
            path.clone(),
            ContinuitySourceCategory::Instructions,
            if runtime_instruction_paths {
                "runtime instructions"
            } else {
                "workspace discovery"
            },
            reason,
            admitted,
        ) {
            if let Ok(canonical) = path.canonicalize() {
                canonical_paths.insert(canonical);
            }
            sources.push(source);
        }
    }

    for (path, canonical) in dev_files {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let name = format!("{DEV_SOURCE_PREFIX}{file_name}");
        let admitted = admission.admits_row(&name);
        if let Some(source) = existing_file_source(
            name,
            path,
            ContinuitySourceCategory::Instructions,
            dev_origin,
            dev_origin,
            admitted,
        ) {
            canonical_paths.insert(canonical);
            sources.push(source);
        }
    }

    let goal_path = workspace_dir.join("GOAL.md");
    // A finished goal is history, not working context. It stays listed so it can be
    // switched back on deliberately, but a completed objective no longer occupies the
    // window just because its file is still on disk.
    let goal_admitted = admission.goal && !goal_is_complete(&goal_path);
    if let Some(source) = existing_file_source(
        "GOAL.md".to_string(),
        goal_path.clone(),
        ContinuitySourceCategory::Files,
        "Elpis workspace state",
        "active workspace goal",
        goal_admitted,
    ) {
        if let Ok(canonical) = goal_path.canonicalize() {
            canonical_paths.insert(canonical);
        }
        sources.push(source);
    }
    let checkpoint_path = workspace_dir.join("ES.md");
    // ES.md sits with GOAL.md, not under evidence. Both exist to carry the session
    // forward; neither is a tool observation, which is what the evidence category means.
    let checkpoint_admitted = admission.checkpoint && !checkpoint_is_complete(&checkpoint_path);
    if let Some(source) = existing_file_source(
        "ES.md".to_string(),
        checkpoint_path.clone(),
        ContinuitySourceCategory::Files,
        "Elpis workspace state",
        "lean session checkpoint",
        checkpoint_admitted,
    ) {
        if let Ok(canonical) = checkpoint_path.canonicalize() {
            canonical_paths.insert(canonical);
        }
        sources.push(source);
    }
    // Durable memory is listed like the goal and the checkpoint: visible in the ledger from
    // the start, and switchable there. Memory that rewrites itself in the background without
    // appearing anywhere is the failure mode this row exists to prevent.
    let memory_path = memories_root.join(MANUAL_MEMORY_FILE);
    if let Some(status) = manual_memory {
        let source = ContinuitySource {
            name: MANUAL_MEMORY_FILE.to_string(),
            path: memory_path.clone(),
            bytes: status.bytes,
            estimated_tokens: (status.request_chars_if_admitted as u64).div_ceil(4),
            category: ContinuitySourceCategory::Memory,
            origin: "Elpis durable memory",
            lifetime: "every turn",
            reason: "durable memory",
            admitted: status.state == ManualMemoryAdmissionState::Admitted,
            selectable: true,
        };
        if let Ok(canonical) = memory_path.canonicalize() {
            canonical_paths.insert(canonical);
        }
        sources.push(source);
    }
    // Custom sources are stored canonicalized, so the memories root has to be resolved
    // the same way before comparing them. Where the root reaches the file through a
    // symlink — macOS puts every temporary directory behind one, and a symlinked home
    // does it anywhere — a raw prefix test files durable memory under Files instead.
    let memories_root_canonical = memories_root
        .canonicalize()
        .unwrap_or_else(|_| memories_root.to_path_buf());
    sources.extend(
        admission
            .custom_sources
            .iter()
            .filter_map(|(path, admitted)| {
                let path = PathBuf::from(path);
                if path_refers_to_manual_memory(&path, &memory_path).unwrap_or(true) {
                    return None;
                }
                let canonical_path = path.canonicalize();
                if let Ok(canonical) = &canonical_path
                    && canonical_paths.contains(canonical)
                {
                    return None;
                }
                let is_memory = canonical_path
                    .as_deref()
                    .unwrap_or(path.as_path())
                    .starts_with(&memories_root_canonical);
                let metadata = std::fs::metadata(&path).ok()?;
                (metadata.is_file() && metadata.len() > 0).then_some(ContinuitySource {
                    name: path.display().to_string(),
                    estimated_tokens: estimate_tokens(&path, metadata.len(), MAX_RULE_CHARS),
                    category: if is_memory {
                        ContinuitySourceCategory::Memory
                    } else {
                        ContinuitySourceCategory::Files
                    },
                    path,
                    bytes: metadata.len(),
                    origin: "manual addition",
                    lifetime: "every turn",
                    reason: "manually added file",
                    admitted: *admitted,
                    selectable: true,
                })
            }),
    );
    Ok(sources)
}

/// Maps an instruction file to the Context Ledger row that governs it, together with the
/// reason shown beside that row. Admission and the ledger listing must agree on this
/// naming or a row would govern a file the model never sees, or miss one it does.
///
/// Project docs are grouped by where they are, not by what they are called. Codex reaches
/// the same instructions through `AGENTS.md`, `AGENTS.override.md`, and any configured
/// `project_doc_fallback_filenames`; giving each filename its own row would mean rows that
/// `set_continuity_source_admitted` cannot switch, so an override file could be listed and
/// never admitted.
fn instruction_source_row(path: &Path, cwd: &Path) -> (String, &'static str) {
    let is_dev_source = path.to_string_lossy().contains("skills/dev")
        || path.to_string_lossy().contains("/dev/")
        || path
            .parent()
            .is_some_and(|dir| dir.ends_with("skills/dev") || dir.ends_with("dev"));
    if is_dev_source {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        (
            format!("{DEV_SOURCE_PREFIX}{file_name}"),
            "configured development rules",
        )
    } else if path.starts_with(cwd) {
        (PROJECT_RULES.to_string(), "applicable project rules")
    } else {
        (GLOBAL_RULES.to_string(), "applicable global rules")
    }
}

/// Whether the Context Ledger currently admits this instruction file into model context.
///
/// This is the single authority. The native instruction path used to assemble global and
/// project AGENTS.md without consulting the ledger at all, which left those two rows
/// decorative: switching them off changed the display and nothing else.
///
/// A host with no Elpis context storage has no ledger to consult, so the gate stays open
/// rather than silently swallowing every instruction file.
pub fn instruction_source_admitted(
    memories_root: Option<&Path>,
    cwd: &Path,
    path: &Path,
) -> std::io::Result<bool> {
    let Some(workspace_dir) = workspace_context_dir(memories_root, cwd) else {
        return Ok(true);
    };
    let (name, _) = instruction_source_row(path, cwd);
    Ok(read_admission(&workspace_dir)?.admits_row(&name))
}

/// Cheap identity of the stored admission state, used to invalidate cached instruction
/// assembly so a toggle takes effect on the very next request instead of the next time
/// the environment selection happens to change.
pub fn admission_fingerprint(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> std::io::Result<Option<String>> {
    let Some(workspace_dir) = workspace_context_dir(memories_root, cwd) else {
        return Ok(None);
    };
    let path = workspace_dir.join(ADMISSION_FILE);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "admission path is not a regular file",
        ));
    }
    let content = std::fs::read_to_string(path)?;
    parse_admission(&content)?;
    Ok(Some(content))
}

fn existing_file_source(
    name: String,
    path: PathBuf,
    category: ContinuitySourceCategory,
    origin: &'static str,
    reason: &'static str,
    admitted: bool,
) -> Option<ContinuitySource> {
    let metadata = std::fs::metadata(&path).ok()?;
    (metadata.is_file() && metadata.len() > 0).then_some(ContinuitySource {
        estimated_tokens: estimate_tokens(&path, metadata.len(), source_char_limit(&name)),
        name,
        path,
        bytes: metadata.len(),
        category,
        origin,
        lifetime: "every turn",
        reason,
        admitted,
        selectable: true,
    })
}

fn estimate_tokens(path: &Path, bytes: u64, max_chars: usize) -> u64 {
    std::fs::read_to_string(path).map_or_else(
        |_| bytes.min(max_chars as u64).div_ceil(4),
        |content| (content.trim().chars().count().min(max_chars) as u64).div_ceil(4),
    )
}

/// The same token estimate the context ledger uses for instruction/rule sources,
/// exposed so `/status` can report a number that means the same thing for the same
/// files instead of a raw byte count the ledger doesn't show.
pub fn estimate_rule_tokens(path: &Path, bytes: u64) -> u64 {
    estimate_tokens(path, bytes, MAX_RULE_CHARS)
}

pub fn set_continuity_source_admitted(
    memories_root: Option<&Path>,
    cwd: &Path,
    source_name: &str,
    admitted: bool,
) -> std::io::Result<()> {
    let workspace_dir = match workspace_context_dir(memories_root, cwd) {
        Some(workspace_dir) => workspace_dir,
        None if source_name == MANUAL_MEMORY_FILE && admitted => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "manual memory storage is unavailable",
            ));
        }
        None => return Ok(()),
    };
    let mut selection = read_admission(&workspace_dir)?;
    if source_name == MANUAL_MEMORY_FILE && admitted {
        let Some(memories_root) = memories_root else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "manual memory storage is unavailable",
            ));
        };
        let path = memories_root.join(MANUAL_MEMORY_FILE);
        let metadata = std::fs::metadata(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "manual memory file is missing; create it from the Memory row",
                )
            } else {
                error
            }
        })?;
        if !metadata.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "manual memory path is not a regular file",
            ));
        }
    }
    match source_name {
        GLOBAL_RULES => selection.global_rules = admitted,
        PROJECT_RULES => selection.project_rules = admitted,
        "GOAL.md" => selection.goal = admitted,
        "ES.md" => selection.checkpoint = admitted,
        MANUAL_MEMORY_FILE => selection.memory = admitted,
        name if name.starts_with(DEV_SOURCE_PREFIX) => {
            selection
                .dev_sources
                .insert(name[DEV_SOURCE_PREFIX.len()..].to_string(), admitted);
        }
        _ => {
            let source_path = PathBuf::from(source_name);
            let canonical = source_path.canonicalize()?;
            if !selection
                .custom_sources
                .contains_key(&canonical.to_string_lossy().to_string())
            {
                return Ok(());
            }
            selection
                .custom_sources
                .insert(canonical.to_string_lossy().to_string(), admitted);
        }
    }
    write_admission(&workspace_dir, &selection)
}

/// Drops a manually added file from the ledger entirely, rather than merely
/// excluding it. Only custom sources can be removed: discovered rules, the goal, and
/// the checkpoint come back on the next scan, so removing them would be a lie.
/// Returns whether an entry was actually removed.
pub fn remove_continuity_source(
    memories_root: Option<&Path>,
    cwd: &Path,
    source_name: &str,
) -> std::io::Result<bool> {
    let Some(workspace_dir) = workspace_context_dir(memories_root, cwd) else {
        return Ok(false);
    };
    let mut selection = read_admission(&workspace_dir)?;
    // Match the stored key directly first: a deleted file can no longer be
    // canonicalized, and those are exactly the rows a user most wants gone.
    let key = if selection.custom_sources.contains_key(source_name) {
        source_name.to_string()
    } else {
        let Ok(canonical) = PathBuf::from(source_name).canonicalize() else {
            return Ok(false);
        };
        canonical.to_string_lossy().to_string()
    };
    if selection.custom_sources.remove(&key).is_none() {
        return Ok(false);
    }
    write_admission(&workspace_dir, &selection)?;
    Ok(true)
}

pub fn add_continuity_source(
    memories_root: Option<&Path>,
    cwd: &Path,
    requested_path: &Path,
) -> std::io::Result<PathBuf> {
    let mut paths = add_continuity_sources(memories_root, cwd, requested_path)?;
    paths.pop().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "context source must be a non-empty file",
        )
    })
}

/// Safety valve: refuse to bulk-admit unreasonably large directories.
const MAX_DIRECTORY_ADD_FILES: usize = 200;

/// Adds one file — or every non-empty file under a directory, recursively — to the
/// ledger's custom sources. Hidden entries and dependency/build folders are skipped.
/// Returns the admitted paths, sorted.
pub fn add_continuity_sources(
    memories_root: Option<&Path>,
    cwd: &Path,
    requested_path: &Path,
) -> std::io::Result<Vec<PathBuf>> {
    let Some(memories_root) = memories_root else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Elpis context storage is unavailable",
        ));
    };
    let Some(workspace_dir) = workspace_context_dir(Some(memories_root), cwd) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Elpis context storage is unavailable",
        ));
    };
    let path = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        cwd.join(requested_path)
    };
    let path = path.canonicalize()?;
    let metadata = std::fs::metadata(&path)?;
    let memory_path = memories_root.join(MANUAL_MEMORY_FILE);
    let canonical_memory = memory_path.canonicalize().ok();
    if path_refers_to_manual_memory(&path, &memory_path)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            MANUAL_MEMORY_ADD_GUIDANCE,
        ));
    }
    let mut files = Vec::new();
    if metadata.is_dir() {
        collect_context_files(&path, &mut files)?;
        let mut excluded_memory = false;
        let mut eligible_files = Vec::with_capacity(files.len());
        for file in files {
            if path_refers_to_manual_memory(&file, &memory_path)? {
                excluded_memory = true;
                continue;
            }
            let metadata = std::fs::metadata(&file)?;
            if metadata.is_file() && metadata.len() > 0 {
                eligible_files.push(file.canonicalize()?);
            }
        }
        eligible_files.sort();
        eligible_files.dedup();
        files = eligible_files;
        excluded_memory |= canonical_memory
            .as_ref()
            .is_some_and(|memory| memory.starts_with(&path));
        if files.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                if excluded_memory {
                    MANUAL_MEMORY_ADD_GUIDANCE
                } else {
                    "directory contains no non-empty files"
                },
            ));
        }
        if files.len() > MAX_DIRECTORY_ADD_FILES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "directory contains {} files (limit {MAX_DIRECTORY_ADD_FILES}); add a smaller directory",
                    files.len()
                ),
            ));
        }
    } else if metadata.is_file() && metadata.len() > 0 {
        files.push(path);
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "context source must be a non-empty file or a directory",
        ));
    }
    let mut selection = read_admission(&workspace_dir)?;
    for file in &files {
        selection
            .custom_sources
            .insert(file.to_string_lossy().to_string(), true);
    }
    write_admission(&workspace_dir, &selection)?;
    Ok(files)
}

fn collect_context_files(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if matches!(name.as_ref(), "node_modules" | "target" | "__pycache__") {
                continue;
            }
            collect_context_files(&entry.path(), files)?;
        } else if file_type.is_file()
            || (file_type.is_symlink()
                && std::fs::metadata(entry.path()).is_ok_and(|metadata| metadata.is_file()))
        {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn path_refers_to_manual_memory(candidate: &Path, memory: &Path) -> std::io::Result<bool> {
    match std::fs::metadata(memory) {
        Ok(_) => same_file::is_same_file(candidate, memory),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn write_admission(workspace_dir: &Path, selection: &ContinuityAdmission) -> std::io::Result<()> {
    std::fs::create_dir_all(workspace_dir)?;
    let path = workspace_dir.join(ADMISSION_FILE);
    let contents = toml::to_string_pretty(selection)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    fail_if_injected(InjectedPersistenceFailure::AdmissionTempCreate)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".admission.toml.")
        .tempfile_in(workspace_dir)?;
    fail_if_injected(InjectedPersistenceFailure::AdmissionTempWrite)?;
    temporary.as_file_mut().write_all(contents.as_bytes())?;
    fail_if_injected(InjectedPersistenceFailure::AdmissionTempSync)?;
    temporary.as_file().sync_all()?;
    fail_if_injected(InjectedPersistenceFailure::AdmissionRename)?;
    temporary
        .persist(&path)
        .map_err(|error| error.error)?;
    let directory = std::fs::File::open(workspace_dir)?;
    fail_if_injected(InjectedPersistenceFailure::AdmissionDirectorySync)?;
    directory.sync_all()
}

fn read_admission(workspace_dir: &Path) -> std::io::Result<ContinuityAdmission> {
    fail_if_injected(InjectedPersistenceFailure::AdmissionRead)?;
    let path = workspace_dir.join(ADMISSION_FILE);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ContinuityAdmission::default());
        }
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "admission path is not a regular file",
        ));
    }
    parse_admission(&std::fs::read_to_string(path)?)
}

fn parse_admission(content: &str) -> std::io::Result<ContinuityAdmission> {
    let mut canonical = String::with_capacity(content.len());
    let mut legacy = LegacyContinuityAdmission::default();
    let mut at_root = true;
    for line in content.split_inclusive('\n') {
        let trimmed = line.trim();
        if !trimmed.starts_with('#') && trimmed.starts_with('[') {
            at_root = false;
        }
        if at_root
            && !trimmed.starts_with('#')
            && let Some((key, value)) = trimmed.split_once('=')
        {
            let key = key.trim();
            if is_legacy_admission_key(key) {
                let value = value
                    .split_once('#')
                    .map_or(value, |(value, _comment)| value)
                    .trim();
                let admitted = match value {
                    "true" => true,
                    "false" => false,
                    _ => return Err(invalid_admission()),
                };
                set_legacy_admission(&mut legacy, key, admitted)?;
                if line.ends_with('\n') {
                    canonical.push('\n');
                }
                continue;
            }
        }
        canonical.push_str(line);
    }

    let stored = if canonical.trim().is_empty() {
        StoredContinuityAdmission::default()
    } else {
        toml::from_str::<StoredContinuityAdmission>(&canonical)
            .map_err(|_| invalid_admission())?
    };
    let defaults = ContinuityAdmission::default();
    let mut dev_sources = stored.dev_sources.unwrap_or_default();
    for (name, admitted) in legacy.dev_sources {
        dev_sources.entry(name).or_insert(admitted);
    }
    Ok(ContinuityAdmission {
        global_rules: stored
            .global_rules
            .or(legacy.global_rules)
            .unwrap_or(defaults.global_rules),
        project_rules: stored
            .project_rules
            .or(legacy.project_rules)
            .unwrap_or(defaults.project_rules),
        goal: stored.goal.or(legacy.goal).unwrap_or(defaults.goal),
        checkpoint: stored
            .checkpoint
            .or(legacy.checkpoint)
            .unwrap_or(defaults.checkpoint),
        memory: stored
            .memory
            .or(legacy.memory)
            .unwrap_or(defaults.memory),
        dev_sources,
        custom_sources: stored.custom_sources.unwrap_or_default(),
    })
}

fn is_legacy_admission_key(key: &str) -> bool {
    matches!(
        key,
        GLOBAL_RULES | PROJECT_RULES | "GOAL.md" | "ES.md" | MANUAL_MEMORY_FILE
    ) || key
        .strip_prefix(DEV_SOURCE_PREFIX)
        .is_some_and(|name| !name.is_empty())
}

fn set_legacy_admission(
    legacy: &mut LegacyContinuityAdmission,
    key: &str,
    admitted: bool,
) -> std::io::Result<()> {
    let slot = match key {
        GLOBAL_RULES => Some(&mut legacy.global_rules),
        PROJECT_RULES => Some(&mut legacy.project_rules),
        "GOAL.md" => Some(&mut legacy.goal),
        "ES.md" => Some(&mut legacy.checkpoint),
        MANUAL_MEMORY_FILE => Some(&mut legacy.memory),
        _ => None,
    };
    if let Some(slot) = slot {
        if slot.replace(admitted).is_some() {
            return Err(invalid_admission());
        }
        return Ok(());
    }

    let name = key
        .strip_prefix(DEV_SOURCE_PREFIX)
        .filter(|name| !name.is_empty())
        .ok_or_else(invalid_admission)?;
    if legacy
        .dev_sources
        .insert(name.to_string(), admitted)
        .is_some()
    {
        return Err(invalid_admission());
    }
    Ok(())
}

fn invalid_admission() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, INVALID_ADMISSION_MESSAGE)
}

fn source_char_limit(name: &str) -> usize {
    match name {
        "GOAL.md" => MAX_GOAL_CHARS,
        "ES.md" => MAX_CHECKPOINT_CHARS,
        MANUAL_MEMORY_FILE => MANUAL_MEMORY_LIMIT_CHARS,
        _ => MAX_RULE_CHARS,
    }
}

pub async fn sync_continuity_before_compaction(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> std::io::Result<()> {
    let Some(workspace_dir) = workspace_context_dir(memories_root, cwd) else {
        return Ok(());
    };
    for name in ["GOAL.md", "ES.md"] {
        let path = workspace_dir.join(name);
        match tokio::fs::OpenOptions::new().read(true).open(&path).await {
            Ok(file) => file.sync_all().await?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn workspace_key(cwd: &Path) -> String {
    let slug = cwd
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .take(40)
        .collect::<String>();
    let slug = if slug.is_empty() { "workspace" } else { &slug };
    let digest = Sha256::digest(cwd.to_string_lossy().as_bytes());
    let suffix = digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{slug}-{suffix}")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn admission_path(memories_root: &Path, cwd: &Path) -> PathBuf {
        workspace_context_dir(Some(memories_root), cwd)
            .expect("workspace path")
            .join(ADMISSION_FILE)
    }

    fn write_admission_fixture(
        memories_root: &Path,
        cwd: &Path,
        contents: &[u8],
    ) -> std::io::Result<PathBuf> {
        let path = admission_path(memories_root, cwd);
        std::fs::create_dir_all(path.parent().expect("admission parent"))?;
        std::fs::write(&path, contents)?;
        Ok(path)
    }

    /// Optional rows are off until asked for, so a test about what reaches the model
    /// must explicitly admit those rows.
    fn admit_all(memories_root: Option<&Path>, cwd: &Path, names: &[&str]) -> std::io::Result<()> {
        for name in names {
            set_continuity_source_admitted(memories_root, cwd, name, true)?;
        }
        Ok(())
    }

    #[test]
    fn workspace_path_is_stable_readable_and_path_specific() {
        let memories = Path::new("/tmp/home/.elpis/memories");
        let first = workspace_context_dir(Some(memories), Path::new("/tmp/My Project"))
            .expect("workspace path");
        assert_eq!(
            first,
            workspace_context_dir(Some(memories), Path::new("/tmp/My Project"))
                .expect("workspace path")
        );
        assert!(
            first
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("My-Project-"))
        );
        assert_ne!(
            workspace_context_dir(Some(memories), Path::new("/a/project")),
            workspace_context_dir(Some(memories), Path::new("/b/project"))
        );
    }

    #[test]
    fn manual_memory_missing_is_not_eligible_for_next_request() {
        let memories = tempdir().expect("memories");
        let cwd = tempdir().expect("cwd");

        let status = manual_memory_status(Some(memories.path()), cwd.path())
            .unwrap()
            .unwrap();

        assert_eq!(status.state, ManualMemoryAdmissionState::Missing);
        assert_eq!(status.request_chars_if_admitted, 0);
        assert_eq!(status.eligible_chars_now, 0);
        assert_eq!(status.limit_chars, MANUAL_MEMORY_LIMIT_CHARS);
        assert!(!status.truncated);
    }

    #[test]
    fn manual_memory_requires_a_configured_root() {
        let cwd = tempdir().expect("cwd");
        assert!(manual_memory_status(None, cwd.path()).unwrap().is_none());
        assert!(matches!(
            create_manual_memory(None, cwd.path()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        ));
        assert!(matches!(
            set_continuity_source_admitted(None, cwd.path(), MANUAL_MEMORY_FILE, true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        ));
    }

    #[test]
    fn missing_memory_remains_a_zero_cost_selectable_source() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;

        let sources = continuity_sources(Some(memories.path()), cwd.path(), &[])?;
        let memory = sources
            .iter()
            .find(|source| source.name == "MEMORY.md")
            .expect("missing memory row");
        assert_eq!(memory.bytes, 0);
        assert_eq!(memory.estimated_tokens, 0);
        assert!(!memory.admitted);
        assert!(memory.selectable);
        Ok(())
    }

    #[test]
    fn create_manual_memory_is_exclusive_and_leaves_memory_unadmitted() {
        let memories = tempdir().expect("memories");
        let cwd = tempdir().expect("cwd");

        let created = create_manual_memory(Some(memories.path()), cwd.path()).unwrap();
        assert_eq!(
            created.state,
            ManualMemoryAdmissionState::AvailableNotAdmitted
        );
        assert_eq!(created.request_chars_if_admitted, 14);
        assert_eq!(created.eligible_chars_now, 0);
        let path = memories.path().join("MEMORY.md");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "# Elpis Memory\n"
        );
        set_continuity_source_admitted(
            Some(memories.path()),
            cwd.path(),
            "MEMORY.md",
            true,
        )
        .unwrap();
        let admitted_template = manual_memory_status(Some(memories.path()), cwd.path())
            .unwrap()
            .unwrap();
        assert_eq!(admitted_template.state, ManualMemoryAdmissionState::Admitted);
        assert_eq!(admitted_template.request_chars_if_admitted, 14);
        assert_eq!(admitted_template.eligible_chars_now, 14);
        std::fs::write(&path, "user content").unwrap();
        assert!(matches!(
            create_manual_memory(Some(memories.path()), cwd.path()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists
        ));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "user content");
        assert_eq!(
            manual_memory_status(Some(memories.path()), cwd.path())
                .unwrap()
                .unwrap()
                .state,
            ManualMemoryAdmissionState::Admitted
        );
    }

    #[test]
    fn manual_memory_status_uses_trimmed_unicode_character_cap() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let path = memories.path().join("MEMORY.md");

        for (contents, expected_chars, expected_truncated) in [
            (" \n\t ".to_string(), 0, false),
            ("界".repeat(MANUAL_MEMORY_LIMIT_CHARS), 8_000, false),
            ("界".repeat(MANUAL_MEMORY_LIMIT_CHARS + 1), 8_000, true),
        ] {
            std::fs::write(&path, contents)?;
            set_continuity_source_admitted(
                Some(memories.path()),
                cwd.path(),
                "MEMORY.md",
                false,
            )?;
            let unadmitted = manual_memory_status(Some(memories.path()), cwd.path())?
                .expect("configured memory status");
            assert_eq!(
                unadmitted.state,
                ManualMemoryAdmissionState::AvailableNotAdmitted
            );
            assert_eq!(unadmitted.request_chars_if_admitted, expected_chars);
            assert_eq!(unadmitted.eligible_chars_now, 0);
            assert_eq!(unadmitted.limit_chars, 8_000);
            assert_eq!(unadmitted.truncated, expected_truncated);

            set_continuity_source_admitted(
                Some(memories.path()),
                cwd.path(),
                "MEMORY.md",
                true,
            )?;
            let admitted = manual_memory_status(Some(memories.path()), cwd.path())?
                .expect("configured memory status");
            assert_eq!(admitted.state, ManualMemoryAdmissionState::Admitted);
            assert_eq!(admitted.request_chars_if_admitted, expected_chars);
            assert_eq!(admitted.eligible_chars_now, expected_chars);
            assert_eq!(admitted.limit_chars, 8_000);
            assert_eq!(admitted.truncated, expected_truncated);
        }

        let truncated = truncate_chars(
            &"界".repeat(MANUAL_MEMORY_LIMIT_CHARS + 1),
            MANUAL_MEMORY_LIMIT_CHARS,
        );
        assert_eq!(truncated.chars().count(), MANUAL_MEMORY_LIMIT_CHARS);
        assert!(truncated.ends_with('…'));
        Ok(())
    }

    #[test]
    fn manual_memory_status_reports_allowlisted_failures() -> anyhow::Result<()> {
        let directory_case = tempdir()?;
        let cwd = tempdir()?;
        std::fs::create_dir(directory_case.path().join("MEMORY.md"))?;
        let directory_error = manual_memory_status(Some(directory_case.path()), cwd.path())
            .expect_err("directory must be unavailable");
        assert_eq!(
            directory_error.reason,
            ManualMemoryUnavailableReason::MemoryPathNotFile
        );
        assert_eq!(directory_error.to_string(), "manual memory path is not a file");

        let utf8_case = tempdir()?;
        std::fs::write(utf8_case.path().join("MEMORY.md"), [0xff, 0xfe])?;
        let utf8_error = manual_memory_status(Some(utf8_case.path()), cwd.path())
            .expect_err("invalid UTF-8 must be unavailable");
        assert_eq!(
            utf8_error.reason,
            ManualMemoryUnavailableReason::InvalidUtf8
        );
        assert_eq!(utf8_error.to_string(), "manual memory is not valid UTF-8");

        let admission_case = tempdir()?;
        std::fs::write(admission_case.path().join("MEMORY.md"), "memory")?;
        write_admission_fixture(admission_case.path(), cwd.path(), b"not valid = [")?;
        let admission_error = manual_memory_status(Some(admission_case.path()), cwd.path())
            .expect_err("invalid admission must be unavailable");
        assert_eq!(
            admission_error.reason,
            ManualMemoryUnavailableReason::AdmissionUnavailable
        );
        assert_eq!(
            admission_error.to_string(),
            "manual memory admission is unavailable"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn manual_memory_read_failure_is_not_reported_as_missing() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        std::os::unix::fs::symlink("MEMORY.md", memories.path().join("MEMORY.md"))?;

        let error = manual_memory_status(Some(memories.path()), cwd.path())
            .expect_err("symlink loop must be unavailable");
        assert_eq!(
            error.reason,
            ManualMemoryUnavailableReason::MemoryUnreadable
        );
        assert_eq!(error.to_string(), "manual memory is unreadable");
        Ok(())
    }

    #[test]
    fn admission_current_fields_win_over_legacy_and_rewrite_canonically()
    -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let custom = cwd.path().join("notes.md");
        std::fs::write(&custom, "notes")?;
        let custom = custom.canonicalize()?;
        let fixture = format!(
            "Global AGENTS.md = true\n\
             Project AGENTS.md = false\n\
             GOAL.md = true\n\
             ES.md = false\n\
             MEMORY.md = true\n\
             dev/AGENTS.md = true\n\
             dev/LEGACY.md = false\n\
             global_rules = false\n\
             project_rules = true\n\
             goal = false\n\
             checkpoint = true\n\
             memory = false\n\
             [dev_sources]\n\
             \"AGENTS.md\" = false\n\
             \"CURRENT.md\" = true\n\
             [custom_sources]\n\
             \"{}\" = true\n",
            custom.display()
        );
        let path = write_admission_fixture(memories.path(), cwd.path(), fixture.as_bytes())?;

        let admission = read_admission(
            path.parent().expect("workspace admission directory"),
        )?;
        assert!(!admission.global_rules);
        assert!(admission.project_rules);
        assert!(!admission.goal);
        assert!(admission.checkpoint);
        assert!(!admission.memory);
        assert_eq!(admission.dev_sources.get("AGENTS.md"), Some(&false));
        assert_eq!(admission.dev_sources.get("LEGACY.md"), Some(&false));
        assert_eq!(admission.dev_sources.get("CURRENT.md"), Some(&true));
        assert_eq!(
            admission.custom_sources.get(&custom.display().to_string()),
            Some(&true)
        );

        set_continuity_source_admitted(
            Some(memories.path()),
            cwd.path(),
            PROJECT_RULES,
            false,
        )?;
        let rewritten = std::fs::read_to_string(&path)?;
        assert!(!rewritten.contains("Global AGENTS.md"));
        assert!(!rewritten.contains("MEMORY.md ="));
        let rewritten_admission = read_admission(path.parent().expect("workspace"))?;
        assert!(!rewritten_admission.global_rules);
        assert!(!rewritten_admission.project_rules);
        assert!(!rewritten_admission.goal);
        assert!(rewritten_admission.checkpoint);
        assert!(!rewritten_admission.memory);
        assert_eq!(rewritten_admission.dev_sources, admission.dev_sources);
        assert_eq!(rewritten_admission.custom_sources, admission.custom_sources);

        let opposite = "MEMORY.md = false\nmemory = true\n";
        write_admission_fixture(memories.path(), cwd.path(), opposite.as_bytes())?;
        assert!(
            read_admission(path.parent().expect("workspace"))?.memory,
            "an explicitly present canonical true must beat legacy false"
        );
        Ok(())
    }

    #[test]
    fn admission_not_found_defaults_but_unknown_or_duplicate_data_errors()
    -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let workspace = workspace_context_dir(Some(memories.path()), cwd.path())
            .expect("workspace");
        assert_eq!(read_admission(&workspace)?, ContinuityAdmission::default());

        let path = write_admission_fixture(
            memories.path(),
            cwd.path(),
            b"MEMORY.md = true\nMEMORY.md = false\n",
        )?;
        assert!(read_admission(path.parent().expect("workspace")).is_err());
        std::fs::write(&path, "unknown = true\n")?;
        assert!(read_admission(path.parent().expect("workspace")).is_err());
        Ok(())
    }

    #[test]
    fn legacy_admission_supplies_only_absent_current_values() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let path = write_admission_fixture(
            memories.path(),
            cwd.path(),
            b"Global AGENTS.md = true\nProject AGENTS.md = true\nGOAL.md = true\nES.md = true\nMEMORY.md = true\ndev/AGENTS.md = false\n",
        )?;

        let admission = read_admission(path.parent().expect("workspace"))?;
        assert!(admission.global_rules);
        assert!(admission.project_rules);
        assert!(admission.goal);
        assert!(admission.checkpoint);
        assert!(admission.memory);
        assert_eq!(admission.dev_sources.get("AGENTS.md"), Some(&false));
        Ok(())
    }

    #[tokio::test]
    async fn nested_legacy_shaped_keys_are_rejected_without_rewrite_or_prompt()
    -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("project");
        let workspace = workspace_context_dir(Some(&memories), &cwd).expect("workspace");
        let dev = home.path().join(".elpis/skills/dev");
        std::fs::create_dir_all(&memories)?;
        std::fs::create_dir_all(&cwd)?;
        std::fs::create_dir_all(&workspace)?;
        std::fs::create_dir_all(&dev)?;
        std::fs::write(memories.join(MANUAL_MEMORY_FILE), "PLANTED_MEMORY_BODY")?;
        std::fs::write(workspace.join("GOAL.md"), "PLANTED_GOAL_BODY")?;
        std::fs::write(dev.join("AGENTS.md"), "PLANTED_DEV_BODY")?;

        for fixture in [
            "[custom_sources]\nMEMORY.md = true\n",
            "[dev_sources]\nGOAL.md = true\n",
            "[custom_sources]\ndev/AGENTS.md = true\n",
        ] {
            let path = write_admission_fixture(memories.as_path(), &cwd, fixture.as_bytes())?;
            assert_eq!(
                read_admission(path.parent().expect("workspace"))
                    .expect_err("nested legacy-shaped key must be ambiguous")
                    .to_string(),
                "admission record is invalid"
            );
            assert!(
                set_continuity_source_admitted(
                    Some(memories.as_path()),
                    &cwd,
                    PROJECT_RULES,
                    true,
                )
                .is_err()
            );
            assert_eq!(std::fs::read(&path)?, fixture.as_bytes());

            let prompt = build_continuity_prompt(Some(memories.as_path()), &cwd)
                .await
                .unwrap_or_default();
            assert!(prompt.is_empty());
            for planted in [
                "PLANTED_MEMORY_BODY",
                "PLANTED_GOAL_BODY",
                "PLANTED_DEV_BODY",
            ] {
                assert!(!prompt.contains(planted));
            }
            assert_eq!(std::fs::read(&path)?, fixture.as_bytes());
        }
        Ok(())
    }

    #[test]
    fn malformed_admission_errors_are_fixed_and_do_not_expose_content_or_paths()
    -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let custom = cwd.path().join("notes.md");
        let planted_secret = "PLANTED_ADMISSION_SECRET_7f04";
        let planted_path = "/private/planted/admission/path";
        let fixture = format!("memory = [\"{planted_secret}\", \"{planted_path}\"\n");
        std::fs::write(memories.path().join(MANUAL_MEMORY_FILE), "memory")?;
        std::fs::write(&custom, "notes")?;
        let admission =
            write_admission_fixture(memories.path(), cwd.path(), fixture.as_bytes())?;
        let workspace = admission.parent().expect("workspace");

        let mut exposed = vec![
            parse_admission(&fixture)
                .expect_err("malformed TOML")
                .to_string(),
            read_admission(workspace)
                .expect_err("malformed admission read")
                .to_string(),
            admission_fingerprint(Some(memories.path()), cwd.path())
                .expect_err("malformed fingerprint")
                .to_string(),
            set_continuity_source_admitted(
                Some(memories.path()),
                cwd.path(),
                PROJECT_RULES,
                true,
            )
            .expect_err("malformed toggle")
            .to_string(),
            add_continuity_source(Some(memories.path()), cwd.path(), &custom)
                .expect_err("malformed add")
                .to_string(),
            remove_continuity_source(
                Some(memories.path()),
                cwd.path(),
                &custom.display().to_string(),
            )
            .expect_err("malformed remove")
            .to_string(),
        ];
        assert_eq!(
            manual_memory_status(Some(memories.path()), cwd.path())
                .expect_err("malformed status")
                .to_string(),
            "manual memory admission is unavailable"
        );
        std::fs::remove_file(memories.path().join(MANUAL_MEMORY_FILE))?;
        exposed.push(
            create_manual_memory(Some(memories.path()), cwd.path())
                .expect_err("malformed create")
                .to_string(),
        );

        for message in &exposed[..exposed.len() - 1] {
            assert_eq!(message.as_str(), "admission record is invalid");
        }
        assert_eq!(
            exposed.last().expect("create error").as_str(),
            "empty memory file reserved; no template written: admission record is invalid"
        );
        for message in exposed {
            assert!(!message.contains(planted_secret));
            assert!(!message.contains(planted_path));
        }
        assert_eq!(std::fs::read(&admission)?, fixture.as_bytes());
        Ok(())
    }

    #[test]
    fn admission_invalid_utf8_and_nonfile_are_never_defaults() -> anyhow::Result<()> {
        let invalid_utf8 = tempdir()?;
        let cwd = tempdir()?;
        let invalid_path = write_admission_fixture(invalid_utf8.path(), cwd.path(), &[0xff])?;
        let workspace = invalid_path.parent().expect("workspace");
        assert!(read_admission(workspace).is_err());
        assert!(admission_fingerprint(Some(invalid_utf8.path()), cwd.path()).is_err());

        let nonfile = tempdir()?;
        let nonfile_path = admission_path(nonfile.path(), cwd.path());
        std::fs::create_dir_all(&nonfile_path)?;
        assert!(read_admission(nonfile_path.parent().expect("workspace")).is_err());
        assert!(admission_fingerprint(Some(nonfile.path()), cwd.path()).is_err());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn admission_read_failure_is_never_cached_as_not_found() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let path = admission_path(memories.path(), cwd.path());
        std::fs::create_dir_all(path.parent().expect("workspace"))?;
        std::os::unix::fs::symlink(ADMISSION_FILE, &path)?;

        assert!(read_admission(path.parent().expect("workspace")).is_err());
        assert!(admission_fingerprint(Some(memories.path()), cwd.path()).is_err());
        Ok(())
    }

    #[test]
    fn admission_errors_leave_records_unchanged_and_create_only_reserves_memory()
    -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let custom = cwd.path().join("notes.md");
        std::fs::write(&custom, "notes")?;
        let original = b"not valid = [";
        let admission = write_admission_fixture(memories.path(), cwd.path(), original)?;

        assert!(
            set_continuity_source_admitted(
                Some(memories.path()),
                cwd.path(),
                PROJECT_RULES,
                true,
            )
            .is_err()
        );
        assert!(add_continuity_source(Some(memories.path()), cwd.path(), &custom).is_err());
        assert!(
            remove_continuity_source(
                Some(memories.path()),
                cwd.path(),
                &custom.display().to_string(),
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&admission)?, original);

        let error = create_manual_memory(Some(memories.path()), cwd.path())
            .expect_err("invalid admission must stop template creation");
        assert!(
            error
                .to_string()
                .contains("empty memory file reserved; no template written")
        );
        assert_eq!(std::fs::read(&admission)?, original);
        assert_eq!(std::fs::read(memories.path().join("MEMORY.md"))?, b"");
        Ok(())
    }

    #[test]
    fn nonfile_admission_rejects_every_mutation_without_replacement() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let custom = cwd.path().join("notes.md");
        std::fs::write(&custom, "notes")?;
        std::fs::write(memories.path().join(MANUAL_MEMORY_FILE), "memory")?;
        let admission = admission_path(memories.path(), cwd.path());
        std::fs::create_dir_all(&admission)?;

        assert_eq!(
            manual_memory_status(Some(memories.path()), cwd.path())
                .expect_err("non-file admission must make status unavailable")
                .reason,
            ManualMemoryUnavailableReason::AdmissionUnavailable
        );

        assert!(
            set_continuity_source_admitted(
                Some(memories.path()),
                cwd.path(),
                PROJECT_RULES,
                true,
            )
            .is_err()
        );
        assert!(add_continuity_source(Some(memories.path()), cwd.path(), &custom).is_err());
        assert!(
            remove_continuity_source(
                Some(memories.path()),
                cwd.path(),
                &custom.display().to_string(),
            )
            .is_err()
        );
        assert!(admission.is_dir());

        std::fs::remove_file(memories.path().join(MANUAL_MEMORY_FILE))?;
        let error = create_manual_memory(Some(memories.path()), cwd.path())
            .expect_err("non-file admission must stop template creation");
        assert!(
            error
                .to_string()
                .contains("empty memory file reserved; no template written")
        );
        assert!(admission.is_dir());
        assert_eq!(std::fs::read(memories.path().join("MEMORY.md"))?, b"");
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_admission_rejects_status_and_mutations_without_replacement()
    -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let custom = cwd.path().join("notes.md");
        std::fs::write(&custom, "notes")?;
        std::fs::write(memories.path().join(MANUAL_MEMORY_FILE), "memory")?;
        let admission = admission_path(memories.path(), cwd.path());
        std::fs::create_dir_all(admission.parent().expect("workspace"))?;
        std::os::unix::fs::symlink(ADMISSION_FILE, &admission)?;

        assert_eq!(
            manual_memory_status(Some(memories.path()), cwd.path())
                .expect_err("unreadable admission must make status unavailable")
                .reason,
            ManualMemoryUnavailableReason::AdmissionUnavailable
        );
        assert!(
            set_continuity_source_admitted(
                Some(memories.path()),
                cwd.path(),
                PROJECT_RULES,
                true,
            )
            .is_err()
        );
        assert!(add_continuity_source(Some(memories.path()), cwd.path(), &custom).is_err());
        assert!(
            remove_continuity_source(
                Some(memories.path()),
                cwd.path(),
                &custom.display().to_string(),
            )
            .is_err()
        );
        assert!(std::fs::symlink_metadata(&admission)?.file_type().is_symlink());

        std::fs::remove_file(memories.path().join(MANUAL_MEMORY_FILE))?;
        let error = create_manual_memory(Some(memories.path()), cwd.path())
            .expect_err("unreadable admission must stop template creation");
        assert!(
            error
                .to_string()
                .contains("empty memory file reserved; no template written")
        );
        assert!(std::fs::symlink_metadata(&admission)?.file_type().is_symlink());
        assert_eq!(std::fs::read(memories.path().join(MANUAL_MEMORY_FILE))?, b"");
        Ok(())
    }

    #[test]
    fn stale_memory_admission_cannot_admit_a_missing_file_or_survive_create()
    -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let path = memories.path().join("MEMORY.md");
        std::fs::write(&path, "memory")?;
        set_continuity_source_admitted(
            Some(memories.path()),
            cwd.path(),
            "MEMORY.md",
            true,
        )?;
        std::fs::remove_file(&path)?;

        assert_eq!(
            manual_memory_status(Some(memories.path()), cwd.path())?
                .expect("status")
                .state,
            ManualMemoryAdmissionState::Missing
        );
        assert!(
            set_continuity_source_admitted(
                Some(memories.path()),
                cwd.path(),
                "MEMORY.md",
                true,
            )
            .is_err()
        );

        let created = create_manual_memory(Some(memories.path()), cwd.path())?;
        assert_eq!(
            created.state,
            ManualMemoryAdmissionState::AvailableNotAdmitted
        );
        assert!(!read_admission(
            admission_path(memories.path(), cwd.path())
                .parent()
                .expect("workspace")
        )?
        .memory);
        Ok(())
    }

    #[test]
    fn canonical_memory_cannot_be_added_as_a_custom_source() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let memory = memories.path().join("MEMORY.md");
        let other = memories.path().join("notes.md");
        std::fs::write(&memory, "memory")?;
        std::fs::write(&other, "notes")?;

        let direct = add_continuity_source(Some(memories.path()), cwd.path(), &memory)
            .expect_err("canonical memory has a dedicated row");
        assert_eq!(direct.kind(), std::io::ErrorKind::InvalidInput);
        assert_eq!(direct.to_string(), MANUAL_MEMORY_ADD_GUIDANCE);

        let added = add_continuity_sources(Some(memories.path()), cwd.path(), memories.path())?;
        assert_eq!(added, vec![other.canonicalize()?]);
        let admission = read_admission(
            admission_path(memories.path(), cwd.path())
                .parent()
                .expect("workspace"),
        )?;
        assert!(
            admission
                .custom_sources
                .keys()
                .all(|path| Path::new(path) != memory.canonicalize().unwrap())
        );

        let memory_only = tempdir()?;
        std::fs::write(memory_only.path().join("MEMORY.md"), "memory")?;
        let only = add_continuity_sources(Some(memory_only.path()), cwd.path(), memory_only.path())
            .expect_err("a directory containing only canonical memory must fail");
        assert_eq!(only.to_string(), MANUAL_MEMORY_ADD_GUIDANCE);
        assert!(!admission_path(memory_only.path(), cwd.path()).exists());

        let empty_memory = tempdir()?;
        let empty_path = empty_memory.path().join(MANUAL_MEMORY_FILE);
        std::fs::write(&empty_path, "")?;
        let empty_direct =
            add_continuity_source(Some(empty_memory.path()), cwd.path(), &empty_path)
                .expect_err("empty canonical memory still has a dedicated row");
        assert_eq!(
            empty_direct.to_string(),
            MANUAL_MEMORY_ADD_GUIDANCE
        );
        let empty_directory = add_continuity_sources(
            Some(empty_memory.path()),
            cwd.path(),
            empty_memory.path(),
        )
        .expect_err("a directory containing only empty canonical memory must fail");
        assert_eq!(empty_directory.to_string(), MANUAL_MEMORY_ADD_GUIDANCE);
        assert!(!admission_path(empty_memory.path(), cwd.path()).exists());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn canonical_memory_alias_cannot_be_added_as_a_custom_source() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let memory = memories.path().join(MANUAL_MEMORY_FILE);
        let aliases = cwd.path().join("aliases");
        std::fs::write(&memory, "")?;
        std::fs::create_dir(&aliases)?;
        let alias = aliases.join("memory-alias.md");
        std::os::unix::fs::symlink(&memory, &alias)?;

        let direct = add_continuity_source(Some(memories.path()), cwd.path(), &alias)
            .expect_err("a canonical-memory alias must use the dedicated row");
        assert_eq!(direct.to_string(), MANUAL_MEMORY_ADD_GUIDANCE);
        let directory = add_continuity_sources(Some(memories.path()), cwd.path(), &aliases)
            .expect_err("a directory containing only a memory alias must fail");
        assert_eq!(directory.to_string(), MANUAL_MEMORY_ADD_GUIDANCE);
        assert!(!admission_path(memories.path(), cwd.path()).exists());
        Ok(())
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn hard_link_memory_alias_cannot_be_added_directly_or_alone() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let memory = memories.path().join(MANUAL_MEMORY_FILE);
        let aliases = cwd.path().join("aliases");
        let alias = aliases.join("memory-hard-link.md");
        std::fs::write(&memory, "memory")?;
        std::fs::create_dir(&aliases)?;
        std::fs::hard_link(&memory, &alias)?;

        let direct = add_continuity_source(Some(memories.path()), cwd.path(), &alias)
            .expect_err("a hard link to canonical memory must use the dedicated row");
        assert_eq!(direct.to_string(), MANUAL_MEMORY_ADD_GUIDANCE);
        assert!(!admission_path(memories.path(), cwd.path()).exists());

        let directory = add_continuity_sources(Some(memories.path()), cwd.path(), &aliases)
            .expect_err("a directory containing only a memory hard link must fail");
        assert_eq!(directory.to_string(), MANUAL_MEMORY_ADD_GUIDANCE);
        assert!(!admission_path(memories.path(), cwd.path()).exists());
        Ok(())
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn directory_add_with_hard_link_admits_only_the_ordinary_file() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let memory = memories.path().join(MANUAL_MEMORY_FILE);
        let candidates = cwd.path().join("candidates");
        let alias = candidates.join("memory-hard-link.md");
        let ordinary = candidates.join("notes.md");
        std::fs::write(&memory, "memory")?;
        std::fs::create_dir(&candidates)?;
        std::fs::hard_link(&memory, &alias)?;
        std::fs::write(&ordinary, "ordinary notes")?;

        assert_eq!(
            add_continuity_sources(Some(memories.path()), cwd.path(), &candidates)?,
            vec![ordinary.canonicalize()?]
        );
        let admission = read_admission(
            admission_path(memories.path(), cwd.path())
                .parent()
                .expect("workspace"),
        )?;
        assert_eq!(admission.custom_sources.len(), 1);
        assert_eq!(
            admission
                .custom_sources
                .get(&ordinary.canonicalize()?.display().to_string()),
            Some(&true)
        );
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn directory_add_canonicalizes_file_symlinks_without_following_linked_directories()
    -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let memory = memories.path().join(MANUAL_MEMORY_FILE);
        let candidates = cwd.path().join("candidates");
        let ordinary = cwd.path().join("ordinary.md");
        let outside = cwd.path().join("outside-directory");
        let memory_alias = candidates.join("memory-symlink.md");
        let ordinary_alias_a = candidates.join("ordinary-a.md");
        let ordinary_alias_b = candidates.join("ordinary-b.md");
        let linked_directory = candidates.join("linked-directory");
        std::fs::write(&memory, "memory")?;
        std::fs::create_dir(&candidates)?;
        std::fs::create_dir(&outside)?;
        let planted_body = "PLANTED_ORDINARY_SYMLINK_BODY";
        let linked_body = "PLANTED_LINKED_DIRECTORY_BODY";
        std::fs::write(&ordinary, planted_body)?;
        std::fs::write(outside.join("must-not-be-added.md"), linked_body)?;
        std::os::unix::fs::symlink(&memory, &memory_alias)?;
        std::os::unix::fs::symlink(&ordinary, &ordinary_alias_a)?;
        std::os::unix::fs::symlink(&ordinary, &ordinary_alias_b)?;
        std::os::unix::fs::symlink(&outside, &linked_directory)?;
        let canonical_ordinary = ordinary.canonicalize()?;

        assert_eq!(
            add_continuity_sources(Some(memories.path()), cwd.path(), &candidates)?,
            vec![canonical_ordinary.clone()]
        );
        let admission = read_admission(
            admission_path(memories.path(), cwd.path())
                .parent()
                .expect("workspace"),
        )?;
        assert_eq!(admission.custom_sources.len(), 1);
        assert_eq!(
            admission
                .custom_sources
                .get(&canonical_ordinary.display().to_string()),
            Some(&true)
        );
        let prompt = build_continuity_prompt(Some(memories.path()), cwd.path())
            .await
            .expect("canonical ordinary source is admitted");
        assert!(prompt.contains(planted_body));
        assert!(!prompt.contains(linked_body));

        set_continuity_source_admitted(
            Some(memories.path()),
            cwd.path(),
            &ordinary_alias_a.display().to_string(),
            false,
        )?;
        assert!(
            !build_continuity_prompt(Some(memories.path()), cwd.path())
                .await
                .is_some_and(|prompt| prompt.contains(planted_body))
        );
        assert!(remove_continuity_source(
            Some(memories.path()),
            cwd.path(),
            &ordinary_alias_b.display().to_string(),
        )?);
        assert!(
            read_admission(
                admission_path(memories.path(), cwd.path())
                    .parent()
                    .expect("workspace"),
            )?
            .custom_sources
            .is_empty()
        );
        Ok(())
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn persisted_hard_link_alias_never_projects_or_enters_the_prompt()
    -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let memory = memories.path().join(MANUAL_MEMORY_FILE);
        let alias = cwd.path().join("persisted-memory-hard-link.md");
        let planted_body = "PLANTED_HARD_LINK_MEMORY_BODY";
        std::fs::write(&memory, planted_body)?;
        std::fs::hard_link(&memory, &alias)?;
        let alias = alias.canonicalize()?;
        let workspace = workspace_context_dir(Some(memories.path()), cwd.path())
            .expect("workspace");
        let mut admission = ContinuityAdmission {
            memory: false,
            ..ContinuityAdmission::default()
        };
        admission
            .custom_sources
            .insert(alias.display().to_string(), true);
        write_admission(&workspace, &admission)?;

        let sources = continuity_sources(Some(memories.path()), cwd.path(), &[])?;
        assert!(sources.iter().all(|source| source.path != alias));
        let prompt = build_continuity_prompt(Some(memories.path()), cwd.path())
            .await
            .unwrap_or_default();
        assert!(!prompt.contains(planted_body));
        Ok(())
    }

    #[test]
    fn admission_and_template_failures_preserve_truthful_partial_state() -> anyhow::Result<()> {
        for stage in [
            InjectedPersistenceFailure::AdmissionTempCreate,
            InjectedPersistenceFailure::AdmissionTempWrite,
            InjectedPersistenceFailure::AdmissionTempSync,
            InjectedPersistenceFailure::AdmissionRename,
            InjectedPersistenceFailure::AdmissionDirectorySync,
        ] {
            let memories = tempdir()?;
            let cwd = tempdir()?;
            let _guard = inject_persistence_failure(stage);
            let error = create_manual_memory(Some(memories.path()), cwd.path())
                .expect_err("admission persistence must fail");
            assert!(
                error
                    .to_string()
                    .contains("empty memory file reserved; no template written")
            );
            assert_eq!(std::fs::read(memories.path().join("MEMORY.md"))?, b"");
        }

        for (stage, expected_contents) in [
            (InjectedPersistenceFailure::TemplateWrite, ""),
            (
                InjectedPersistenceFailure::TemplateSync,
                "# Elpis Memory\n",
            ),
        ] {
            let memories = tempdir()?;
            let cwd = tempdir()?;
            let _guard = inject_persistence_failure(stage);
            create_manual_memory(Some(memories.path()), cwd.path())
                .expect_err("template persistence must fail");
            assert_eq!(
                std::fs::read_to_string(memories.path().join("MEMORY.md"))?,
                expected_contents
            );
            assert!(!read_admission(
                admission_path(memories.path(), cwd.path())
                    .parent()
                    .expect("workspace")
            )?
            .memory);
        }
        Ok(())
    }

    #[test]
    fn cached_memory_projection_never_rereads_memory_content() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        let memory = memories.path().join("MEMORY.md");
        std::fs::write(&memory, "remember this")?;
        let status = manual_memory_status(Some(memories.path()), cwd.path())?
            .expect("memory status");
        std::fs::remove_file(&memory)?;
        std::fs::create_dir(&memory)?;

        let sources = continuity_sources_from_manual_memory_status(
            Some(memories.path()),
            cwd.path(),
            &[],
            &[],
            Some(&status),
        )?;
        let source = sources
            .iter()
            .find(|source| source.name == "MEMORY.md")
            .expect("cached memory row");
        assert_eq!(source.bytes, status.bytes);
        assert_eq!(
            source.estimated_tokens,
            (status.request_chars_if_admitted as u64).div_ceil(4)
        );
        assert_eq!(source.admitted, false);
        assert!(source.selectable);
        Ok(())
    }

    #[test]
    fn empty_present_memory_stays_visible_with_persisted_admission() -> anyhow::Result<()> {
        let memories = tempdir()?;
        let cwd = tempdir()?;
        std::fs::write(memories.path().join("MEMORY.md"), " \n\t")?;
        set_continuity_source_admitted(
            Some(memories.path()),
            cwd.path(),
            MANUAL_MEMORY_FILE,
            true,
        )?;

        let sources = continuity_sources(Some(memories.path()), cwd.path(), &[])?;
        let memory = sources
            .iter()
            .find(|source| source.name == MANUAL_MEMORY_FILE)
            .expect("empty memory row");
        assert!(memory.admitted);
        assert_eq!(memory.bytes, 3);
        assert_eq!(memory.estimated_tokens, 0);
        Ok(())
    }

    #[test]
    fn source_list_contains_only_nonempty_portable_context_files() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = Path::new("/tmp/project");
        let workspace = workspace_context_dir(Some(&memories), cwd).expect("workspace path");
        std::fs::create_dir_all(&workspace)?;
        std::fs::write(workspace.join("GOAL.md"), "Ship Elpis")?;
        std::fs::write(workspace.join("ES.md"), "")?;
        std::fs::write(workspace.join("raw.log"), "hidden")?;

        let sources = continuity_sources(Some(&memories), cwd, &[])?;
        assert_eq!(sources.len(), 2, "missing Memory stays visible at zero cost");
        assert_eq!(sources[0].name, "GOAL.md");
        assert_eq!(sources[0].bytes, 10);
        assert_eq!(sources[0].estimated_tokens, 3);
        assert_eq!(sources[0].category, ContinuitySourceCategory::Files);
        assert_eq!(sources[0].lifetime, "every turn");
        Ok(())
    }

    /// macOS reaches every temporary directory through a symlink, and a symlinked home
    /// does the same anywhere, so durable memory must still group as Memory when the
    /// stored path and the memories root spell the same file differently.
    #[cfg(unix)]
    #[test]
    fn memory_groups_as_memory_when_its_root_is_reached_through_a_symlink() -> anyhow::Result<()> {
        let home = tempdir()?;
        let real_home = home.path().join("real");
        let memories = real_home.join(".elpis/memories");
        let cwd = real_home.join("projects/Elpis");
        std::fs::create_dir_all(&memories)?;
        std::fs::create_dir_all(&cwd)?;
        let memory = memories.join("MEMORY.md");
        std::fs::write(&memory, "Durable memory")?;

        let linked_home = home.path().join("linked");
        std::os::unix::fs::symlink(&real_home, &linked_home)?;
        let linked_memories = linked_home.join(".elpis/memories");
        let sources = continuity_sources(Some(&linked_memories), &cwd, &[])?;
        let source = sources
            .iter()
            .find(|source| source.name.ends_with("MEMORY.md"))
            .expect("memory source");
        assert_eq!(source.category, ContinuitySourceCategory::Memory);
        Ok(())
    }

    #[test]
    fn sources_expose_honest_groups_and_capped_token_estimates() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("projects/Elpis");
        let dev = home.path().join(".elpis/skills/dev");
        let workspace = workspace_context_dir(Some(&memories), &cwd).expect("workspace path");
        let global = home.path().join("global/AGENTS.md");
        std::fs::create_dir_all(&memories)?;
        std::fs::create_dir_all(&cwd)?;
        std::fs::create_dir_all(&dev)?;
        std::fs::create_dir_all(&workspace)?;
        std::fs::create_dir_all(global.parent().expect("global parent"))?;
        std::fs::write(&global, "Global instructions")?;
        std::fs::write(cwd.join("AGENTS.md"), "Project instructions")?;
        std::fs::write(dev.join("SKILL.md"), "Development instructions")?;
        std::fs::write(workspace.join("GOAL.md"), "x".repeat(MAX_GOAL_CHARS + 40))?;
        std::fs::write(workspace.join("ES.md"), "Verified command evidence")?;
        let memory = memories.join("MEMORY.md");
        std::fs::write(&memory, "Durable memory")?;
        let instructions = vec![global, cwd.join("AGENTS.md"), dev.join("SKILL.md")];
        let sources = continuity_sources(Some(&memories), &cwd, &instructions)?;
        for (name, category) in [
            ("GOAL.md", ContinuitySourceCategory::Files),
            ("MEMORY.md", ContinuitySourceCategory::Memory),
            ("Global AGENTS.md", ContinuitySourceCategory::Instructions),
            ("ES.md", ContinuitySourceCategory::Files),
        ] {
            let source = sources
                .iter()
                .find(|source| source.name.ends_with(name))
                .unwrap_or_else(|| panic!("missing source {name}"));
            assert_eq!(source.category, category, "wrong group for {name}");
            assert!(source.estimated_tokens > 0, "missing estimate for {name}");
        }
        assert_eq!(
            sources
                .iter()
                .find(|source| source.name == "GOAL.md")
                .expect("goal source")
                .estimated_tokens,
            (MAX_GOAL_CHARS as u64).div_ceil(4)
        );
        Ok(())
    }

    /// A file on disk is not consent. Optional rows may not reach the model until the
    /// Context Ledger admits them, while development rules start admitted on a fresh
    /// workspace and remain switchable.
    #[tokio::test]
    async fn optional_sources_start_excluded_while_dev_rules_start_admitted()
    -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("projects/Elpis");
        let dev = home.path().join(".elpis/skills/dev");
        let workspace = workspace_context_dir(Some(&memories), &cwd).expect("workspace path");
        let global = home.path().join("global/AGENTS.md");
        std::fs::create_dir_all(&memories)?;
        std::fs::create_dir_all(&cwd)?;
        std::fs::create_dir_all(&dev)?;
        std::fs::create_dir_all(&workspace)?;
        std::fs::create_dir_all(global.parent().expect("global parent"))?;
        std::fs::write(&global, "Global rule")?;
        std::fs::write(cwd.join("AGENTS.md"), "Project rule")?;
        std::fs::write(dev.join("SKILL.md"), "Dev rule")?;
        std::fs::write(workspace.join("GOAL.md"), "Ship it")?;
        std::fs::write(workspace.join("ES.md"), "Checkpoint")?;
        std::fs::write(memories.join("MEMORY.md"), "Durable memory")?;

        let project = cwd.join("AGENTS.md");
        let instructions = vec![global.clone(), project.clone()];
        let sources = continuity_sources(Some(&memories), &cwd, &instructions)?;
        for name in [
            GLOBAL_RULES,
            PROJECT_RULES,
            "GOAL.md",
            "ES.md",
            "MEMORY.md",
        ] {
            let source = sources
                .iter()
                .find(|source| source.name == name)
                .unwrap_or_else(|| panic!("{name} must stay listed so it can be switched on"));
            assert!(!source.admitted, "{name} must default to off");
            assert!(source.selectable, "{name} must stay switchable");
        }
        let dev_source = sources
            .iter()
            .find(|source| source.name == "dev/SKILL.md")
            .expect("dev rule must stay listed so it can be switched off");
        assert!(dev_source.admitted, "dev/SKILL.md must default to on");
        assert!(dev_source.selectable, "dev/SKILL.md must stay switchable");
        assert!(
            build_continuity_prompt(Some(&memories), &cwd)
                .await
                .is_some_and(|prompt| prompt.contains("Dev rule")),
            "a fresh development rule must reach the prompt"
        );

        set_continuity_source_admitted(Some(&memories), &cwd, "dev/SKILL.md", false)?;
        assert_eq!(
            build_continuity_prompt(Some(&memories), &cwd).await,
            None,
            "an explicit development-rule exclusion must remain authoritative"
        );
        Ok(())
    }

    /// The ledger is the only authority over instruction files. Global and project
    /// AGENTS.md ride a native instruction path that used to ignore admission entirely,
    /// so their rows have to answer this question the same way every other row does.
    #[test]
    fn instruction_admission_tracks_the_ledger_through_repeated_toggles() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("projects/Elpis");
        let dev = home.path().join(".elpis/skills/dev");
        let global = home.path().join("global/AGENTS.md");
        std::fs::create_dir_all(&memories)?;
        std::fs::create_dir_all(&cwd)?;
        std::fs::create_dir_all(&dev)?;
        std::fs::create_dir_all(global.parent().expect("global parent"))?;
        std::fs::write(&global, "Global rule")?;
        std::fs::write(cwd.join("AGENTS.md"), "Project rule")?;
        let project = cwd.join("AGENTS.md");

        assert!(!instruction_source_admitted(
            Some(&memories),
            &cwd,
            &global
        )?);
        assert!(!instruction_source_admitted(
            Some(&memories),
            &cwd,
            &project
        )?);

        for expected in [true, false, true] {
            set_continuity_source_admitted(Some(&memories), &cwd, GLOBAL_RULES, expected)?;
            set_continuity_source_admitted(Some(&memories), &cwd, PROJECT_RULES, expected)?;
            assert_eq!(
                instruction_source_admitted(Some(&memories), &cwd, &global)?,
                expected
            );
            assert_eq!(
                instruction_source_admitted(Some(&memories), &cwd, &project)?,
                expected
            );
        }

        // A host without Elpis context storage has no ledger to consult, so the gate
        // must stay open rather than silently swallowing every instruction file.
        assert!(instruction_source_admitted(None, &cwd, &project)?);
        Ok(())
    }

    /// Instruction assembly caches its discovery per turn. A live toggle has to invalidate
    /// that cache, so the ledger's state needs a cheap fingerprint that changes with it.
    #[test]
    fn admission_fingerprint_changes_when_a_row_is_toggled() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("projects/Elpis");
        std::fs::create_dir_all(&memories)?;
        std::fs::create_dir_all(&cwd)?;

        let before = admission_fingerprint(Some(&memories), &cwd)?;
        set_continuity_source_admitted(Some(&memories), &cwd, PROJECT_RULES, true)?;
        let after = admission_fingerprint(Some(&memories), &cwd)?;
        assert_ne!(before, after, "a toggle must invalidate cached assembly");
        set_continuity_source_admitted(Some(&memories), &cwd, PROJECT_RULES, false)?;
        assert_ne!(after, admission_fingerprint(Some(&memories), &cwd)?);
        Ok(())
    }

    #[tokio::test]
    async fn prompt_loads_only_portable_goal_and_checkpoint() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = Path::new("/tmp/project");
        let workspace = workspace_context_dir(Some(&memories), cwd).expect("workspace path");
        tokio::fs::create_dir_all(&workspace).await?;
        tokio::fs::write(workspace.join("GOAL.md"), "Ship Elpis").await?;
        tokio::fs::write(workspace.join("ES.md"), "Next: visible context").await?;
        tokio::fs::write(workspace.join("raw.log"), "must not load").await?;
        admit_all(Some(&memories), cwd, &["GOAL.md", "ES.md"])?;

        let prompt = build_continuity_prompt(Some(&memories), cwd)
            .await
            .expect("continuity prompt");
        assert!(prompt.contains("Ship Elpis"));
        assert!(prompt.contains("Next: visible context"));
        assert!(!prompt.contains("must not load"));
        Ok(())
    }

    #[tokio::test]
    async fn admission_selection_excludes_a_source_from_the_next_prompt() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = Path::new("/tmp/project");
        let workspace = workspace_context_dir(Some(&memories), cwd).expect("workspace path");
        tokio::fs::create_dir_all(&workspace).await?;
        tokio::fs::write(workspace.join("GOAL.md"), "Ship the ledger").await?;
        tokio::fs::write(workspace.join("ES.md"), "Keep the checkpoint").await?;
        admit_all(Some(&memories), cwd, &["GOAL.md", "ES.md"])?;

        set_continuity_source_admitted(Some(&memories), cwd, "ES.md", false)?;
        let prompt = build_continuity_prompt(Some(&memories), cwd)
            .await
            .expect("prompt");

        assert!(prompt.contains("Ship the ledger"));
        assert!(!prompt.contains("Keep the checkpoint"));
        let sources = continuity_sources(Some(&memories), cwd, &[])?;
        assert!(
            sources
                .iter()
                .any(|source| source.name == "ES.md" && !source.admitted)
        );
        Ok(())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn withdrawn_prebuilt_memory_source_is_skipped_before_injection(
    ) -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("project");
        tokio::fs::create_dir_all(&memories).await?;
        tokio::fs::write(
            memories.join(MANUAL_MEMORY_FILE),
            "MEMORY_WITHDRAWN_MARKER",
        )
        .await?;
        set_continuity_source_admitted(Some(&memories), &cwd, MANUAL_MEMORY_FILE, true)?;
        let source = continuity_sources(Some(&memories), &cwd, &[])?
            .into_iter()
            .find(|source| source.name == MANUAL_MEMORY_FILE)
            .expect("prebuilt admitted memory source");

        set_continuity_source_admitted(Some(&memories), &cwd, MANUAL_MEMORY_FILE, false)?;

        assert_eq!(
            read_continuity_source_section(&source, Some(&memories), &cwd).await,
            None,
            "a durable withdrawal after source discovery must win before injection"
        );
        Ok(())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn post_read_memory_admission_error_skips_the_memory_section()
    -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("project");
        let workspace = workspace_context_dir(Some(&memories), &cwd).expect("workspace");
        tokio::fs::create_dir_all(&workspace).await?;
        tokio::fs::write(workspace.join("GOAL.md"), "goal that must also fail closed").await?;
        tokio::fs::create_dir_all(&memories).await?;
        tokio::fs::write(memories.join(MANUAL_MEMORY_FILE), "memory").await?;
        admit_all(
            Some(&memories),
            &cwd,
            &["GOAL.md", MANUAL_MEMORY_FILE],
        )?;

        let _guard = inject_persistence_failure(
            InjectedPersistenceFailure::MemoryPostReadAdmission,
        );
        let prompt = build_continuity_prompt(Some(&memories), &cwd)
            .await
            .expect("the independently admitted goal remains available");
        assert!(prompt.contains("goal that must also fail closed"));
        assert!(!prompt.contains("memory"));
        Ok(())
    }

    #[tokio::test]
    async fn custom_source_is_visible_enabled_and_can_be_disabled() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("project");
        let custom = cwd.join("notes.md");
        tokio::fs::create_dir_all(&cwd).await?;
        tokio::fs::write(&custom, "Keep this visible").await?;

        let added = add_continuity_source(Some(&memories), &cwd, Path::new("notes.md"))?;
        let sources = continuity_sources(Some(&memories), &cwd, &[])?;
        assert!(
            sources
                .iter()
                .any(|source| source.path == added && source.admitted)
        );
        assert!(
            build_continuity_prompt(Some(&memories), &cwd)
                .await
                .expect("prompt")
                .contains("Keep this visible")
        );

        set_continuity_source_admitted(Some(&memories), &cwd, &added.display().to_string(), false)?;
        assert!(
            !build_continuity_prompt(Some(&memories), &cwd)
                .await
                .is_some_and(|prompt| prompt.contains("Keep this visible"))
        );

        // Excluding leaves the row on the list; removing takes it off entirely.
        let name = added.display().to_string();
        assert!(
            continuity_sources(Some(&memories), &cwd, &[])?
                .iter()
                .any(|source| source.path == added)
        );
        assert!(remove_continuity_source(Some(&memories), &cwd, &name)?);
        assert!(
            continuity_sources(Some(&memories), &cwd, &[])?
                .iter()
                .all(|source| source.path != added),
            "removed file must not come back on the next scan"
        );
        // Removing twice is not an error, and discovered rows refuse removal.
        assert!(!remove_continuity_source(Some(&memories), &cwd, &name)?);
        assert!(!remove_continuity_source(
            Some(&memories),
            &cwd,
            PROJECT_RULES
        )?);
        Ok(())
    }

    #[tokio::test]
    async fn applicable_rules_are_visible_and_toggleable() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("projects/Elpis");
        // The canonical installed location. A project-sibling `skills/dev` is
        // deliberately no longer scanned, so rules placed there are never discovered and
        // the continuity prompt comes back empty.
        let dev = home.path().join(".elpis/skills/dev");
        let global = home.path().join("global/AGENTS.md");
        tokio::fs::create_dir_all(&cwd).await?;
        tokio::fs::create_dir_all(&dev).await?;
        tokio::fs::create_dir_all(global.parent().expect("global parent")).await?;
        tokio::fs::write(&global, "Global rule").await?;
        tokio::fs::write(cwd.join("AGENTS.md"), "Project rule").await?;
        tokio::fs::write(dev.join("AGENTS.md"), "Dev rule").await?;
        tokio::fs::write(dev.join("SKILL.md"), "Skill rule").await?;

        let instructions = vec![
            global,
            cwd.join("AGENTS.md"),
            dev.join("AGENTS.md"),
            dev.join("SKILL.md"),
        ];
        admit_all(
            Some(&memories),
            &cwd,
            &[GLOBAL_RULES, PROJECT_RULES, "dev/AGENTS.md", "dev/SKILL.md"],
        )?;
        let sources = continuity_sources(Some(&memories), &cwd, &instructions)?;
        assert!(
            sources
                .iter()
                .all(|source| source.selectable && source.admitted)
        );
        assert!(sources.iter().any(|source| source.name == GLOBAL_RULES));
        assert!(sources.iter().any(|source| source.name == PROJECT_RULES));
        assert!(sources.iter().any(|source| source.name == "dev/AGENTS.md"));
        assert!(sources.iter().any(|source| source.name == "dev/SKILL.md"));

        set_continuity_source_admitted(Some(&memories), &cwd, GLOBAL_RULES, false)?;
        set_continuity_source_admitted(Some(&memories), &cwd, "dev/SKILL.md", false)?;
        let sources = continuity_sources(Some(&memories), &cwd, &instructions)?;
        assert!(
            sources
                .iter()
                .any(|source| source.name == GLOBAL_RULES && !source.admitted)
        );
        assert!(
            sources
                .iter()
                .any(|source| source.name == "dev/SKILL.md" && !source.admitted)
        );
        assert!(
            sources
                .iter()
                .any(|source| source.name == "dev/AGENTS.md" && source.admitted)
        );

        // Global/project AGENTS.md ride the server's native instruction channel; the
        // continuity prompt must not re-inject them (that was the double-send). Dev
        // rules are never sent by the server at all, so admitted ones DO get injected —
        // except dev/SKILL.md, excluded just above.
        let prompt = build_continuity_prompt(Some(&memories), &cwd)
            .await
            .expect("dev/AGENTS.md is still admitted, so a prompt is built");
        assert!(prompt.contains("Dev rule"));
        assert!(!prompt.contains("Skill rule"));
        assert!(!prompt.contains("Global rule"));
        assert!(!prompt.contains("Project rule"));
        Ok(())
    }

    /// The regression this guards: the app server's `instruction_source_paths` only ever
    /// contains global/project AGENTS.md, never `skills/dev/*.md` — so passing the
    /// server's real (dev-less) list must still surface dev rules, both in the ledger and
    /// in the injected prompt.
    #[tokio::test]
    async fn dev_rules_are_discovered_even_when_server_omits_them() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("projects/Elpis");
        let dev = home.path().join(".elpis/skills/dev");
        tokio::fs::create_dir_all(&cwd).await?;
        tokio::fs::create_dir_all(&dev).await?;
        tokio::fs::write(dev.join("AGENTS.md"), "Dev rule").await?;

        // Simulates the real server response: no dev paths in the list at all.
        let server_reported: Vec<PathBuf> = vec![];
        let sources = continuity_sources(Some(&memories), &cwd, &server_reported)?;
        let dev_source = sources
            .iter()
            .find(|source| source.path == dev.join("AGENTS.md"))
            .unwrap_or_else(|| panic!("dev file missing from ledger sources: {sources:?}"));
        assert!(dev_source.admitted, "dev rules must default to on");

        let dev_source_name = dev_source.name.clone();
        let prompt = build_continuity_prompt(Some(&memories), &cwd)
            .await
            .expect("dev rule should be injected since the server never sends it");
        assert!(prompt.contains("Dev rule"));

        // ...and the ledger can still switch an individual dev file off.
        set_continuity_source_admitted(Some(&memories), &cwd, &dev_source_name, false)?;
        assert!(
            !build_continuity_prompt(Some(&memories), &cwd)
                .await
                .is_some_and(|prompt| prompt.contains("Dev rule"))
        );
        Ok(())
    }

    /// Bundled rules installed under the Elpis home are canonical. A project-sibling
    /// `skills/dev` left beside a checkout must not create a second ledger copy.
    #[tokio::test]
    async fn installed_dev_rules_replace_project_sibling_duplicates() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("projects/Elpis");
        let project_dev = home.path().join("projects/skills/dev");
        let home_dev = home.path().join(".elpis/skills/dev");
        tokio::fs::create_dir_all(&cwd).await?;
        tokio::fs::create_dir_all(&project_dev).await?;
        tokio::fs::create_dir_all(&home_dev).await?;
        tokio::fs::write(project_dev.join("AGENTS.md"), "Project dev rule").await?;
        tokio::fs::write(home_dev.join("AGENTS.md"), "Home dev rule").await?;

        let sources = continuity_sources(Some(&memories), &cwd, &[])?;
        let dev_sources = sources
            .iter()
            .filter(|source| source.name.starts_with(DEV_SOURCE_PREFIX))
            .collect::<Vec<_>>();
        assert_eq!(
            dev_sources.len(),
            1,
            "the installed canonical rule must appear exactly once: {dev_sources:?}"
        );
        assert_eq!(dev_sources[0].name, "dev/AGENTS.md");
        assert_eq!(dev_sources[0].path, home_dev.join("AGENTS.md"));

        admit_all(Some(&memories), &cwd, &["dev/AGENTS.md"])?;
        let prompt = build_continuity_prompt(Some(&memories), &cwd)
            .await
            .expect("installed dev rule should be admitted");
        assert!(!prompt.contains("Project dev rule"));
        assert!(prompt.contains("Home dev rule"));

        set_continuity_source_admitted(Some(&memories), &cwd, dev_sources[0].name.as_str(), false)?;
        assert!(
            !build_continuity_prompt(Some(&memories), &cwd)
                .await
                .is_some_and(|prompt| prompt.contains("Home dev rule"))
        );
        Ok(())
    }

    #[test]
    fn manually_added_file_already_listed_as_a_rule_appears_once() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("projects/Elpis");
        let dev = home.path().join("projects/skills/dev");
        std::fs::create_dir_all(&cwd)?;
        std::fs::create_dir_all(&dev)?;
        let dev_rule = dev.join("AGENTS.md");
        std::fs::write(&dev_rule, "Dev rule")?;

        add_continuity_source(Some(&memories), &cwd, &dev_rule)?;
        let instructions = vec![dev_rule.clone()];
        let sources = continuity_sources(Some(&memories), &cwd, &instructions)?;
        let rows = sources
            .iter()
            .filter(|source| {
                source
                    .path
                    .canonicalize()
                    .ok()
                    .zip(dev_rule.canonicalize().ok())
                    .is_some_and(|(a, b)| a == b)
            })
            .count();
        assert_eq!(rows, 1, "dedupe must collapse rule + manual add to one row");
        Ok(())
    }

    #[test]
    fn add_continuity_sources_admits_every_file_in_a_directory() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("project");
        let docs = cwd.join("docs");
        let nested = docs.join("nested");
        std::fs::create_dir_all(&nested)?;
        std::fs::create_dir_all(docs.join(".hidden"))?;
        std::fs::write(docs.join("a.md"), "alpha")?;
        std::fs::write(nested.join("b.md"), "beta")?;
        std::fs::write(docs.join("empty.md"), "")?;
        std::fs::write(docs.join(".hidden/skip.md"), "hidden")?;

        let added = add_continuity_sources(Some(&memories), &cwd, &docs)?;
        assert_eq!(added.len(), 2, "non-empty visible files only: {added:?}");

        let sources = continuity_sources(Some(&memories), &cwd, &[])?;
        for file in ["a.md", "b.md"] {
            assert!(
                sources
                    .iter()
                    .any(|source| source.path.file_name().is_some_and(|n| n == file)
                        && source.admitted),
                "missing admitted row for {file}"
            );
        }
        Ok(())
    }

    #[test]
    fn add_continuity_sources_rejects_empty_directory() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("project");
        let empty = cwd.join("empty-dir");
        std::fs::create_dir_all(&empty)?;
        let error = add_continuity_sources(Some(&memories), &cwd, &empty).unwrap_err();
        assert!(error.to_string().contains("no non-empty files"));
        Ok(())
    }

    #[test]
    fn a_completed_goal_is_listed_but_no_longer_admitted() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("project");
        let workspace = workspace_context_dir(Some(&memories), &cwd).expect("workspace path");
        std::fs::create_dir_all(&workspace)?;

        let goal = workspace.join("GOAL.md");
        std::fs::write(
            &goal,
            "# Elpis Goal\n\n- Status: active\n\n## Objective\n\nShip it.\n",
        )?;
        admit_all(Some(&memories), &cwd, &["GOAL.md"])?;
        let active = continuity_sources(Some(&memories), &cwd, &[])?;
        let active_goal = active
            .iter()
            .find(|source| source.name == "GOAL.md")
            .expect("goal row");
        assert!(active_goal.admitted, "an active goal is admitted");

        std::fs::write(
            &goal,
            "# Elpis Goal\n\n- Status: complete\n\n## Objective\n\nShip it.\n",
        )?;
        let finished = continuity_sources(Some(&memories), &cwd, &[])?;
        let finished_goal = finished
            .iter()
            .find(|source| source.name == "GOAL.md")
            .expect("goal row stays listed");
        assert!(
            !finished_goal.admitted,
            "a finished goal stops occupying the window"
        );
        Ok(())
    }

    #[tokio::test]
    async fn pre_compaction_sync_accepts_present_or_missing_files() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = Path::new("/tmp/project");
        let workspace = workspace_context_dir(Some(&memories), cwd).expect("workspace path");
        tokio::fs::create_dir_all(&workspace).await?;
        tokio::fs::write(workspace.join("GOAL.md"), "Ship Elpis").await?;

        sync_continuity_before_compaction(Some(&memories), cwd).await?;
        assert_eq!(
            tokio::fs::read_to_string(workspace.join("GOAL.md")).await?,
            "Ship Elpis"
        );
        Ok(())
    }

    #[tokio::test]
    async fn configured_dev_rule_roots_replace_managed_fallback() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("project");
        let managed_dev = home.path().join(".elpis/skills/dev");
        let configured_dev = home.path().join("configured/dev");
        let configured_later = home.path().join("configured-later/dev");
        let managed_rule = managed_dev.join("AGENTS.md");
        let configured_rule = configured_dev.join("AGENTS.md");
        let later_rule = configured_later.join("AGENTS.md");
        std::fs::create_dir_all(&memories)?;
        std::fs::create_dir_all(&cwd)?;
        std::fs::create_dir_all(&managed_dev)?;
        std::fs::create_dir_all(&configured_dev)?;
        std::fs::create_dir_all(&configured_later)?;
        std::fs::write(&managed_rule, "Managed fallback rule")?;
        std::fs::write(&configured_rule, "Configured development rule")?;
        std::fs::write(&later_rule, "Later configured development rule")?;
        let configured_dev_root = AbsolutePathBuf::from_absolute_path(&configured_dev)?;
        let configured_later_root = AbsolutePathBuf::from_absolute_path(&configured_later)?;

        let sources = continuity_sources_with_dev_rule_roots(
            Some(&memories),
            &cwd,
            &[],
            &[
                configured_dev_root.clone(),
                configured_later_root.clone(),
                configured_dev_root.clone(),
            ],
        )?;
        let rows = sources
            .iter()
            .filter(|source| source.name == "dev/AGENTS.md")
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 1, "configured roots replace the managed fallback");
        let source = rows[0];
        assert_eq!(source.path, configured_rule);
        assert_eq!(source.origin, "configured development rules");
        assert!(source.admitted, "configured rules are admitted on a fresh workspace");

        let prompt = build_continuity_prompt_with_dev_rule_roots(
            Some(&memories),
            &cwd,
            &[
                configured_dev_root.clone(),
                configured_later_root.clone(),
                configured_dev_root.clone(),
            ],
        )
        .await
        .expect("configured development rule should reach the prompt");
        assert!(prompt.contains("Configured development rule"));
        assert!(!prompt.contains("Later configured development rule"));
        assert!(!prompt.contains("Managed fallback rule"));

        set_continuity_source_admitted(Some(&memories), &cwd, "dev/AGENTS.md", false)?;
        let sources = continuity_sources_with_dev_rule_roots(
            Some(&memories),
            &cwd,
            &[],
            &[
                configured_dev_root.clone(),
                configured_later_root,
                configured_dev_root,
            ],
        )?;
        let source = sources
            .iter()
            .find(|source| source.name == "dev/AGENTS.md")
            .expect("configured row stays listed after exclusion");
        assert_eq!(source.path, configured_rule);
        assert!(!source.admitted, "the configured row is excluded after persistence");
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn dev_rule_alias_deduplication_keeps_a_later_unique_filename() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("project");
        let first_root = home.path().join("first");
        let duplicate_root = home.path().join("duplicate");
        let unique_root = home.path().join("unique");
        let targets = home.path().join("targets");
        std::fs::create_dir_all(&memories)?;
        std::fs::create_dir_all(&cwd)?;
        std::fs::create_dir_all(&first_root)?;
        std::fs::create_dir_all(&duplicate_root)?;
        std::fs::create_dir_all(&unique_root)?;
        std::fs::create_dir_all(&targets)?;

        let primary_target = targets.join("primary.md");
        let shared_target = targets.join("shared.md");
        let unsorted_target = targets.join("unsorted.md");
        std::fs::write(&primary_target, "Primary rule")?;
        std::fs::write(&shared_target, "Shared rule")?;
        std::fs::write(&unsorted_target, "Unsorted rule")?;
        std::os::unix::fs::symlink(&unsorted_target, first_root.join("ZETA.md"))?;
        std::os::unix::fs::symlink(&primary_target, first_root.join("AGENTS.md"))?;
        std::os::unix::fs::symlink(&shared_target, duplicate_root.join("AGENTS.md"))?;
        std::os::unix::fs::symlink(&shared_target, unique_root.join("RULES.md"))?;

        let roots = [
            AbsolutePathBuf::from_absolute_path(&first_root)?,
            AbsolutePathBuf::from_absolute_path(&duplicate_root)?,
            AbsolutePathBuf::from_absolute_path(&unique_root)?,
        ];
        let sources =
            continuity_sources_with_dev_rule_roots(Some(&memories), &cwd, &[], &roots)?;
        let dev_sources = sources
            .iter()
            .filter(|source| source.name.starts_with(DEV_SOURCE_PREFIX))
            .collect::<Vec<_>>();

        assert_eq!(
            dev_sources
                .iter()
                .map(|source| source.name.as_str())
                .collect::<Vec<_>>(),
            vec!["dev/AGENTS.md", "dev/ZETA.md", "dev/RULES.md"],
        );
        assert_eq!(dev_sources[2].path, unique_root.join("RULES.md"));
        Ok(())
    }
}
