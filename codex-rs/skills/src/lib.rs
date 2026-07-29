// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use codex_utils_absolute_path::AbsolutePathBuf;
use include_dir::Dir;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::Hash;
use std::hash::Hasher;
use std::path::Path;

use thiserror::Error;

const SYSTEM_SKILLS_DIR: Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/src/assets/samples");
const DEV_RULES_DIR: Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/src/assets/dev");

const SYSTEM_SKILLS_DIR_NAME: &str = ".system";
const DEV_RULES_DIR_NAME: &str = "dev";
const SKILLS_DIR_NAME: &str = "skills";
const SYSTEM_SKILLS_MARKER_FILENAME: &str = ".codex-system-skills.marker";
const SYSTEM_SKILLS_MARKER_SALT: &str = "v1";
const DEV_RULES_MANIFEST_FILENAME: &str = ".elpis-managed-rules";
const LEGACY_RETIRED_DEV_RULES: [&str; 1] = ["TERMINAL_AND_GIT_RULES.md"];

/// Returns the on-disk cache location for embedded system skills from an absolute CODEX_HOME.
pub fn system_cache_root_dir(codex_home: &AbsolutePathBuf) -> AbsolutePathBuf {
    codex_home
        .join(SKILLS_DIR_NAME)
        .join(SYSTEM_SKILLS_DIR_NAME)
}

fn dev_rules_root_dir(codex_home: &AbsolutePathBuf) -> AbsolutePathBuf {
    codex_home.join(SKILLS_DIR_NAME).join(DEV_RULES_DIR_NAME)
}

/// Installs embedded system skills into `CODEX_HOME/skills/.system`.
///
/// Clears any existing system skills directory first and then writes the embedded
/// skills directory into place.
///
/// To avoid doing unnecessary work on every startup, a marker file is written
/// with a fingerprint of the embedded directory. When the marker matches, the
/// install is skipped.
pub fn install_system_skills(codex_home: &AbsolutePathBuf) -> Result<(), SystemSkillsError> {
    let skills_root_dir = codex_home.join(SKILLS_DIR_NAME);
    fs::create_dir_all(skills_root_dir.as_path())
        .map_err(|source| SystemSkillsError::io("create skills root dir", source))?;
    install_dev_rules(codex_home)?;

    let dest_system = system_cache_root_dir(codex_home);

    let marker_path = dest_system.join(SYSTEM_SKILLS_MARKER_FILENAME);
    let expected_fingerprint = embedded_system_skills_fingerprint();
    if dest_system.as_path().is_dir()
        && read_marker(&marker_path).is_ok_and(|marker| marker == expected_fingerprint)
    {
        return Ok(());
    }

    if dest_system.as_path().exists() {
        fs::remove_dir_all(dest_system.as_path())
            .map_err(|source| SystemSkillsError::io("remove existing system skills dir", source))?;
    }

    write_embedded_dir(&SYSTEM_SKILLS_DIR, &dest_system)?;
    fs::write(marker_path.as_path(), format!("{expected_fingerprint}\n"))
        .map_err(|source| SystemSkillsError::io("write system skills marker", source))?;
    Ok(())
}

fn install_dev_rules(codex_home: &AbsolutePathBuf) -> Result<(), SystemSkillsError> {
    let dest = dev_rules_root_dir(codex_home);
    fs::create_dir_all(dest.as_path())
        .map_err(|source| SystemSkillsError::io("create dev rules dir", source))?;

    let mut current_files = DEV_RULES_DIR
        .files()
        .filter_map(|file| {
            file.path()
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    current_files.sort_unstable();

    let manifest_path = dest.join(DEV_RULES_MANIFEST_FILENAME);
    let mut retired_files = fs::read_to_string(manifest_path.as_path())
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .chain(LEGACY_RETIRED_DEV_RULES.map(str::to_string))
        .collect::<Vec<_>>();
    retired_files.sort_unstable();
    retired_files.dedup();

    for file_name in retired_files {
        if current_files.contains(&file_name)
            || Path::new(&file_name).components().count() != 1
            || Path::new(&file_name)
                .file_name()
                .and_then(|name| name.to_str())
                != Some(file_name.as_str())
        {
            continue;
        }
        match fs::remove_file(dest.join(&file_name).as_path()) {
            Ok(()) => {}
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(SystemSkillsError::io("remove retired dev rule", source));
            }
        }
    }

    write_embedded_dir(&DEV_RULES_DIR, &dest)?;
    fs::write(
        manifest_path.as_path(),
        format!("{}\n", current_files.join("\n")),
    )
    .map_err(|source| SystemSkillsError::io("write dev rules manifest", source))?;
    Ok(())
}

fn read_marker(path: &AbsolutePathBuf) -> Result<String, SystemSkillsError> {
    Ok(fs::read_to_string(path.as_path())
        .map_err(|source| SystemSkillsError::io("read system skills marker", source))?
        .trim()
        .to_string())
}

fn embedded_system_skills_fingerprint() -> String {
    let mut items = Vec::new();
    collect_fingerprint_items(&SYSTEM_SKILLS_DIR, &mut items);
    items.sort_unstable_by(|(a, _), (b, _)| a.cmp(b));

    let mut hasher = DefaultHasher::new();
    SYSTEM_SKILLS_MARKER_SALT.hash(&mut hasher);
    for (path, contents_hash) in items {
        path.hash(&mut hasher);
        contents_hash.hash(&mut hasher);
    }
    format!("{:x}", hasher.finish())
}

fn collect_fingerprint_items(dir: &Dir<'_>, items: &mut Vec<(String, Option<u64>)>) {
    for entry in dir.entries() {
        match entry {
            include_dir::DirEntry::Dir(subdir) => {
                items.push((subdir.path().to_string_lossy().to_string(), None));
                collect_fingerprint_items(subdir, items);
            }
            include_dir::DirEntry::File(file) => {
                let mut file_hasher = DefaultHasher::new();
                file.contents().hash(&mut file_hasher);
                items.push((
                    file.path().to_string_lossy().to_string(),
                    Some(file_hasher.finish()),
                ));
            }
        }
    }
}

/// Writes the embedded `include_dir::Dir` to disk under `dest`.
///
/// Preserves the embedded directory structure.
fn write_embedded_dir(dir: &Dir<'_>, dest: &AbsolutePathBuf) -> Result<(), SystemSkillsError> {
    fs::create_dir_all(dest.as_path())
        .map_err(|source| SystemSkillsError::io("create system skills dir", source))?;

    for entry in dir.entries() {
        match entry {
            include_dir::DirEntry::Dir(subdir) => {
                let subdir_dest = dest.join(subdir.path());
                fs::create_dir_all(subdir_dest.as_path()).map_err(|source| {
                    SystemSkillsError::io("create system skills subdir", source)
                })?;
                write_embedded_dir(subdir, dest)?;
            }
            include_dir::DirEntry::File(file) => {
                let path = dest.join(file.path());
                if let Some(parent) = path.as_path().parent() {
                    fs::create_dir_all(parent).map_err(|source| {
                        SystemSkillsError::io("create system skills file parent", source)
                    })?;
                }
                fs::write(path.as_path(), file.contents())
                    .map_err(|source| SystemSkillsError::io("write system skill file", source))?;
            }
        }
    }

    Ok(())
}

#[derive(Debug, Error)]
pub enum SystemSkillsError {
    #[error("io error while {action}: {source}")]
    Io {
        action: &'static str,
        #[source]
        source: std::io::Error,
    },
}

impl SystemSkillsError {
    fn io(action: &'static str, source: std::io::Error) -> Self {
        Self::Io { action, source }
    }
}

#[cfg(test)]
mod tests {
    use super::SYSTEM_SKILLS_DIR;
    use super::collect_fingerprint_items;
    use super::install_system_skills;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use std::fs;

    #[test]
    fn fingerprint_traverses_nested_entries() {
        let mut items = Vec::new();
        collect_fingerprint_items(&SYSTEM_SKILLS_DIR, &mut items);
        let mut paths: Vec<String> = items.into_iter().map(|(path, _)| path).collect();
        paths.sort_unstable();

        assert!(
            paths
                .binary_search_by(|probe| probe.as_str().cmp("skill-creator/SKILL.md"))
                .is_ok()
        );
        assert!(
            paths
                .binary_search_by(|probe| probe.as_str().cmp("skill-creator/scripts/init_skill.py"))
                .is_ok()
        );
    }

    #[test]
    fn install_system_skills_installs_current_dev_rules_and_removes_retired_managed_rule() {
        let home = tempfile::tempdir().expect("tempdir");
        let codex_home =
            AbsolutePathBuf::from_absolute_path(home.path()).expect("absolute tempdir");
        let dev_dir = home.path().join("skills/dev");
        fs::create_dir_all(&dev_dir).expect("create legacy dev dir");
        fs::write(
            dev_dir.join("TERMINAL_AND_GIT_RULES.md"),
            "retired bundled rule",
        )
        .expect("write retired rule");
        fs::write(dev_dir.join("PERSONAL.md"), "keep user-authored rule")
            .expect("write personal rule");

        install_system_skills(&codex_home).expect("install embedded rules");

        assert!(dev_dir.join("AGENTS.md").is_file());
        assert!(dev_dir.join("CODING_GUIDELINES.md").is_file());
        assert!(!dev_dir.join("TERMINAL_AND_GIT_RULES.md").exists());
        assert_eq!(
            fs::read_to_string(dev_dir.join("PERSONAL.md")).expect("read personal rule"),
            "keep user-authored rule"
        );
    }
}
