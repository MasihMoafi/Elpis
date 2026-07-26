use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

const MAX_GOAL_CHARS: usize = 6_000;
const MAX_CHECKPOINT_CHARS: usize = 8_000;
const MAX_RULE_CHARS: usize = 8_000;
const ADMISSION_FILE: &str = "admission.toml";

const GLOBAL_RULES: &str = "Global AGENTS.md";
const PROJECT_RULES: &str = "Project AGENTS.md";
const DEV_SOURCE_PREFIX: &str = "dev/";

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(default)]
struct ContinuityAdmission {
    global_rules: bool,
    project_rules: bool,
    goal: bool,
    checkpoint: bool,
    /// Per-file admission for `skills/dev/*.md`, keyed by file name.
    /// Files absent from the map are admitted by default.
    dev_sources: BTreeMap<String, bool>,
    custom_sources: BTreeMap<String, bool>,
}

impl Default for ContinuityAdmission {
    fn default() -> Self {
        Self {
            global_rules: true,
            project_rules: true,
            goal: true,
            checkpoint: true,
            dev_sources: BTreeMap::new(),
            custom_sources: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContinuitySource {
    pub name: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub estimated_tokens: u64,
    pub category: ContinuitySourceCategory,
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
    Evidence,
}

impl ContinuitySourceCategory {
    pub const ALL: [Self; 4] = [
        Self::Files,
        Self::Memory,
        Self::Instructions,
        Self::Evidence,
    ];

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Files => "ACTIVE FILES",
            Self::Memory => "DURABLE MEMORY",
            Self::Instructions => "INSTRUCTIONS",
            Self::Evidence => "TOOL EVIDENCE",
        }
    }
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

pub async fn build_continuity_prompt(memories_root: Option<&Path>, cwd: &Path) -> Option<String> {
    let mut sections = Vec::new();
    // Global/project AGENTS.md are deliberately NOT injected here: the app server
    // already sends them natively as instructions, and re-reading them into this prompt
    // double-sent every rule file on every turn. `continuity_sources` still auto-discovers
    // them on disk when given an empty instruction list (other callers, like the Context
    // Ledger, rely on that fallback), so they're skipped explicitly by name here instead.
    // Skill-library files are intentionally absent here. The skills service advertises
    // compact metadata and loads a selected skill through its native skill path instead
    // of admitting an entire development folder as always-on context.
    for source in continuity_sources(memories_root, cwd, &[]) {
        if !source.admitted || source.name == GLOBAL_RULES || source.name == PROJECT_RULES {
            continue;
        }
        let Ok(content) = tokio::fs::read_to_string(&source.path).await else {
            continue;
        };
        let content = truncate_chars(content.trim(), source_char_limit(&source.name));
        if !content.is_empty() {
            sections.push(format!(
                "### Source: {} ({} characters)\n\n{}",
                source.path.display(),
                content.chars().count(),
                content
            ));
        }
    }
    if sections.is_empty() {
        return None;
    }
    Some(format!(
        "## Elpis Admitted Context\n\n\
         These are the user-visible sources Elpis admitted for this workspace. They are not a full\n\
         transcript. Verify mutable repository state before acting, and prefer the current user\n\
         message when it changes the task.\n\n{}",
        sections.join("\n\n")
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
) -> Vec<ContinuitySource> {
    let Some(memories_root) = memories_root else {
        return Vec::new();
    };
    let Some(workspace_dir) = workspace_context_dir(Some(memories_root), cwd) else {
        return Vec::new();
    };
    let admission = read_admission(&workspace_dir);
    let mut sources = Vec::new();
    let mut canonical_paths = std::collections::HashSet::new();

    let mut instruction_paths: Vec<PathBuf> = instruction_source_paths.to_vec();
    if instruction_paths.is_empty() {
        let proj_agents = cwd.join("AGENTS.md");
        if proj_agents.exists() {
            instruction_paths.push(proj_agents);
        }
    }

    for path in &instruction_paths {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let is_dev_source = path.to_string_lossy().contains("skills/dev")
            || path.to_string_lossy().contains("/dev/")
            || path
                .parent()
                .is_some_and(|dir| dir.ends_with("skills/dev") || dir.ends_with("dev"));
        let (name, reason): (String, &'static str) = if is_dev_source {
            (
                format!("{DEV_SOURCE_PREFIX}{file_name}"),
                "configured development rules",
            )
        } else if file_name == "AGENTS.md" && path.starts_with(cwd) {
            (PROJECT_RULES.to_string(), "applicable project rules")
        } else if file_name == "AGENTS.md" {
            (GLOBAL_RULES.to_string(), "applicable global rules")
        } else {
            (file_name.to_string(), "instruction source")
        };
        let admitted = if is_dev_source {
            admission
                .dev_sources
                .get(file_name)
                .copied()
                .unwrap_or(true)
        } else if name == GLOBAL_RULES {
            admission.global_rules
        } else if name == PROJECT_RULES {
            admission.project_rules
        } else {
            true
        };
        if let Some(source) = existing_file_source(
            name,
            path.clone(),
            ContinuitySourceCategory::Instructions,
            reason,
            admitted,
        ) {
            if let Ok(canonical) = path.canonicalize() {
                canonical_paths.insert(canonical);
            }
            sources.push(source);
        }
    }

    let goal_path = workspace_dir.join("GOAL.md");
    if let Some(source) = existing_file_source(
        "GOAL.md".to_string(),
        goal_path.clone(),
        ContinuitySourceCategory::Files,
        "active workspace goal",
        admission.goal,
    ) {
        if let Ok(canonical) = goal_path.canonicalize() {
            canonical_paths.insert(canonical);
        }
        sources.push(source);
    }
    let checkpoint_path = workspace_dir.join("ES.md");
    if let Some(source) = existing_file_source(
        "ES.md".to_string(),
        checkpoint_path.clone(),
        ContinuitySourceCategory::Evidence,
        "lean session checkpoint",
        admission.checkpoint,
    ) {
        if let Ok(canonical) = checkpoint_path.canonicalize() {
            canonical_paths.insert(canonical);
        }
        sources.push(source);
    }
    sources.extend(
        admission
            .custom_sources
            .iter()
            .filter_map(|(path, admitted)| {
                let path = PathBuf::from(path);
                if let Ok(canonical) = path.canonicalize()
                    && canonical_paths.contains(&canonical)
                {
                    return None;
                }
                let metadata = std::fs::metadata(&path).ok()?;
                (metadata.is_file() && metadata.len() > 0).then_some(ContinuitySource {
                    name: path.display().to_string(),
                    estimated_tokens: estimate_tokens(&path, metadata.len(), MAX_RULE_CHARS),
                    category: if path.starts_with(memories_root) {
                        ContinuitySourceCategory::Memory
                    } else {
                        ContinuitySourceCategory::Files
                    },
                    path,
                    bytes: metadata.len(),
                    lifetime: "every turn",
                    reason: "manually added file",
                    admitted: *admitted,
                    selectable: true,
                })
            }),
    );
    sources
}

fn existing_file_source(
    name: String,
    path: PathBuf,
    category: ContinuitySourceCategory,
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
    let Some(workspace_dir) = workspace_context_dir(memories_root, cwd) else {
        return Ok(());
    };
    let mut selection = read_admission(&workspace_dir);
    match source_name {
        GLOBAL_RULES => selection.global_rules = admitted,
        PROJECT_RULES => selection.project_rules = admitted,
        "GOAL.md" => selection.goal = admitted,
        "ES.md" => selection.checkpoint = admitted,
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
    let mut selection = read_admission(&workspace_dir);
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
    let Some(workspace_dir) = workspace_context_dir(memories_root, cwd) else {
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
    let mut files = Vec::new();
    if metadata.is_dir() {
        collect_context_files(&path, &mut files)?;
        files.sort();
        if files.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "directory contains no non-empty files",
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
    let mut selection = read_admission(&workspace_dir);
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
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            if matches!(name.as_ref(), "node_modules" | "target" | "__pycache__") {
                continue;
            }
            collect_context_files(&entry.path(), files)?;
        } else if metadata.is_file() && metadata.len() > 0 {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn write_admission(workspace_dir: &Path, selection: &ContinuityAdmission) -> std::io::Result<()> {
    std::fs::create_dir_all(&workspace_dir)?;
    let path = workspace_dir.join(ADMISSION_FILE);
    let temporary_path = path.with_extension("toml.tmp");
    let contents = toml::to_string_pretty(selection)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    std::fs::write(&temporary_path, contents)?;
    std::fs::rename(temporary_path, path)
}

fn read_admission(workspace_dir: &Path) -> ContinuityAdmission {
    let Ok(content) = std::fs::read_to_string(workspace_dir.join(ADMISSION_FILE)) else {
        return ContinuityAdmission::default();
    };
    if let Ok(admission) = toml::from_str(&content) {
        return admission;
    }
    let mut admission = ContinuityAdmission::default();
    for line in content.lines().map(str::trim) {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let admitted = matches!(value.trim(), "true");
        match key.trim() {
            GLOBAL_RULES => admission.global_rules = admitted,
            PROJECT_RULES => admission.project_rules = admitted,
            "GOAL.md" => admission.goal = admitted,
            "ES.md" => admission.checkpoint = admitted,
            key if key.starts_with(DEV_SOURCE_PREFIX) => {
                admission
                    .dev_sources
                    .insert(key[DEV_SOURCE_PREFIX.len()..].to_string(), admitted);
            }
            _ => {}
        }
    }
    admission
}

fn source_char_limit(name: &str) -> usize {
    match name {
        "GOAL.md" => MAX_GOAL_CHARS,
        "ES.md" => MAX_CHECKPOINT_CHARS,
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
    fn source_list_contains_only_nonempty_portable_context_files() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = Path::new("/tmp/project");
        let workspace = workspace_context_dir(Some(&memories), cwd).expect("workspace path");
        std::fs::create_dir_all(&workspace)?;
        std::fs::write(workspace.join("GOAL.md"), "Ship Elpis")?;
        std::fs::write(workspace.join("ES.md"), "")?;
        std::fs::write(workspace.join("raw.log"), "hidden")?;

        let sources = continuity_sources(Some(&memories), cwd, &[]);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].name, "GOAL.md");
        assert_eq!(sources[0].bytes, 10);
        assert_eq!(sources[0].estimated_tokens, 3);
        assert_eq!(sources[0].category, ContinuitySourceCategory::Files);
        assert_eq!(sources[0].lifetime, "every turn");
        Ok(())
    }

    #[test]
    fn sources_expose_honest_groups_and_capped_token_estimates() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("projects/Elpis");
        let dev = home.path().join("projects/skills/dev");
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
        add_continuity_source(Some(&memories), &cwd, &memory)?;

        let instructions = vec![global, cwd.join("AGENTS.md"), dev.join("SKILL.md")];
        let sources = continuity_sources(Some(&memories), &cwd, &instructions);
        for (name, category) in [
            ("GOAL.md", ContinuitySourceCategory::Files),
            ("MEMORY.md", ContinuitySourceCategory::Memory),
            ("Global AGENTS.md", ContinuitySourceCategory::Instructions),
            ("ES.md", ContinuitySourceCategory::Evidence),
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

        set_continuity_source_admitted(Some(&memories), cwd, "ES.md", false)?;
        let prompt = build_continuity_prompt(Some(&memories), cwd)
            .await
            .expect("prompt");

        assert!(prompt.contains("Ship the ledger"));
        assert!(!prompt.contains("Keep the checkpoint"));
        let sources = continuity_sources(Some(&memories), cwd, &[]);
        assert!(
            sources
                .iter()
                .any(|source| source.name == "ES.md" && !source.admitted)
        );
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
        let sources = continuity_sources(Some(&memories), &cwd, &[]);
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
        assert!(continuity_sources(Some(&memories), &cwd, &[])
            .iter()
            .any(|source| source.path == added));
        assert!(remove_continuity_source(Some(&memories), &cwd, &name)?);
        assert!(
            continuity_sources(Some(&memories), &cwd, &[])
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
        let dev = home.path().join("projects/skills/dev");
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
        let sources = continuity_sources(Some(&memories), &cwd, &instructions);
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
        let sources = continuity_sources(Some(&memories), &cwd, &instructions);
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

        // Native instruction and skill channels own these files. The portable
        // continuity prompt must not re-inject any of them.
        assert!(
            !build_continuity_prompt(Some(&memories), &cwd)
                .await
                .is_some_and(|prompt| {
                    ["Dev rule", "Skill rule", "Global rule", "Project rule"]
                        .iter()
                        .any(|needle| prompt.contains(needle))
                })
        );
        Ok(())
    }

    #[tokio::test]
    async fn sibling_skill_library_is_not_implicitly_admitted() -> anyhow::Result<()> {
        let home = tempdir()?;
        let memories = home.path().join(".elpis/memories");
        let cwd = home.path().join("projects/Elpis");
        let dev = home.path().join("projects/skills/dev");
        tokio::fs::create_dir_all(&cwd).await?;
        tokio::fs::create_dir_all(&dev).await?;
        tokio::fs::write(dev.join("AGENTS.md"), "Dev rule").await?;

        let server_reported: Vec<PathBuf> = vec![];
        let sources = continuity_sources(Some(&memories), &cwd, &server_reported);
        assert!(
            sources
                .iter()
                .all(|source| source.path != dev.join("AGENTS.md")),
            "an unselected skill library must not enter the ledger: {sources:?}"
        );

        assert!(
            !build_continuity_prompt(Some(&memories), &cwd)
                .await
                .is_some_and(|prompt| prompt.contains("Dev rule"))
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
        let sources = continuity_sources(Some(&memories), &cwd, &instructions);
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

        let sources = continuity_sources(Some(&memories), &cwd, &[]);
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
}
