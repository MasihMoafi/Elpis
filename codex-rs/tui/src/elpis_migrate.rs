use clap::ValueEnum;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub(crate) enum MigrationCategory {
    Config,
    Hooks,
    Rules,
    Skills,
    Plugins,
    History,
    Sessions,
    Cache,
}

impl MigrationCategory {
    fn label(self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::Hooks => "hooks",
            Self::Rules => "rules",
            Self::Skills => "skills",
            Self::Plugins => "plugins",
            Self::History => "history",
            Self::Sessions => "sessions",
            Self::Cache => "cache",
        }
    }

    fn sources(self, source_home: &Path) -> io::Result<Vec<PathBuf>> {
        let paths = match self {
            Self::Config => {
                let mut paths = Vec::new();
                for entry in read_dir_if_present(source_home)? {
                    let path = entry.path();
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name == "config.toml" || name.ends_with(".config.toml") {
                        paths.push(path);
                    }
                }
                paths
            }
            Self::Hooks => vec![source_home.join("hooks.json")],
            Self::Rules => vec![source_home.join("rules")],
            Self::Skills => vec![source_home.join("skills")],
            Self::Plugins => vec![source_home.join("plugins")],
            Self::History => vec![source_home.join("history.jsonl")],
            Self::Sessions => vec![
                source_home.join("sessions"),
                source_home.join("archived_sessions"),
            ],
            Self::Cache => vec![
                source_home.join("cache"),
                source_home.join("models_cache.json"),
            ],
        };
        Ok(paths.into_iter().filter(|path| path.exists()).collect())
    }
}

#[derive(Default)]
struct CopyStats {
    copied_files: u64,
    copied_bytes: u64,
    skipped_existing: u64,
}

pub(crate) fn run(
    source_home: &Path,
    elpis_home: &Path,
    selected: &[MigrationCategory],
    apply: bool,
) -> io::Result<String> {
    let mut report = String::new();
    writeln!(
        report,
        "Codex state migration: {} -> {}",
        source_home.display(),
        elpis_home.display()
    )
    .expect("write to string");

    if selected.is_empty() {
        writeln!(report, "Preview only. Nothing is selected or copied.").expect("write to string");
        writeln!(
            report,
            "Choose categories with --migration-include config,hooks,rules,skills,plugins,history,sessions,cache"
        )
        .expect("write to string");
        writeln!(
            report,
            "Historical sessions may contain both Codex and Elpis threads; they are never selected automatically."
        )
        .expect("write to string");
        return Ok(report);
    }

    let mut selections = Vec::new();
    for category in selected {
        for source in category.sources(source_home)? {
            let Some(name) = source.file_name() else {
                continue;
            };
            let destination = elpis_home.join(name);
            let (files, bytes) = measure(&source)?;
            writeln!(
                report,
                "- {}: {} -> {} ({files} files, {bytes} bytes)",
                category.label(),
                source.display(),
                destination.display()
            )
            .expect("write to string");
            selections.push((*category, source, destination));
        }
    }

    if !apply {
        writeln!(
            report,
            "Preview only. Re-run with --apply-migration to copy these paths."
        )
        .expect("write to string");
        return Ok(report);
    }

    let mut stats = CopyStats::default();
    for (category, source, destination) in selections {
        copy_without_overwrite(
            &source,
            &destination,
            source_home,
            elpis_home,
            category == MigrationCategory::Config,
            &mut stats,
        )?;
    }
    writeln!(
        report,
        "Copied {} files ({} bytes); skipped {} existing files. Source files were not changed.",
        stats.copied_files, stats.copied_bytes, stats.skipped_existing
    )
    .expect("write to string");
    Ok(report)
}

fn read_dir_if_present(path: &Path) -> io::Result<Vec<fs::DirEntry>> {
    match fs::read_dir(path) {
        Ok(entries) => entries.collect(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

fn measure(path: &Path) -> io::Result<(u64, u64)> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok((0, 0));
    }
    if metadata.is_file() {
        return Ok((1, metadata.len()));
    }
    let mut files = 0;
    let mut bytes = 0;
    for entry in fs::read_dir(path)? {
        let (child_files, child_bytes) = measure(&entry?.path())?;
        files += child_files;
        bytes += child_bytes;
    }
    Ok((files, bytes))
}

fn copy_without_overwrite(
    source: &Path,
    destination: &Path,
    source_home: &Path,
    elpis_home: &Path,
    rewrite_config_paths: bool,
    stats: &mut CopyStats,
) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        match fs::symlink_metadata(destination) {
            Ok(destination_metadata) if destination_metadata.file_type().is_symlink() => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "refusing to migrate through destination symlink {}",
                        destination.display()
                    ),
                ));
            }
            Ok(destination_metadata) if !destination_metadata.is_dir() => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "migration destination is not a directory: {}",
                        destination.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(destination)?;
            }
            Err(err) => return Err(err),
        }
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_without_overwrite(
                &entry.path(),
                &destination.join(entry.file_name()),
                source_home,
                elpis_home,
                rewrite_config_paths,
                stats,
            )?;
        }
        return Ok(());
    }
    if destination.exists() {
        stats.skipped_existing += 1;
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    if rewrite_config_paths {
        let contents = fs::read_to_string(source)?;
        let rewritten = contents.replace(
            &source_home.to_string_lossy().into_owned(),
            &elpis_home.to_string_lossy(),
        );
        let mut destination_file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
        {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                stats.skipped_existing += 1;
                return Ok(());
            }
            Err(err) => return Err(err),
        };
        std::io::Write::write_all(&mut destination_file, rewritten.as_bytes())?;
        stats.copied_files += 1;
        stats.copied_bytes += u64::try_from(rewritten.len()).unwrap_or(u64::MAX);
    } else {
        let options = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination);
        let mut destination_file = match options {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                stats.skipped_existing += 1;
                return Ok(());
            }
            Err(err) => return Err(err),
        };
        let mut source_file = fs::File::open(source)?;
        let bytes = io::copy(&mut source_file, &mut destination_file)?;
        stats.copied_files += 1;
        stats.copied_bytes += bytes;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn preview_never_copies_and_lists_exact_paths() {
        let source = tempdir().expect("source");
        let destination = tempdir().expect("destination");
        fs::write(source.path().join("hooks.json"), "{}").expect("hook fixture");

        let report = run(
            source.path(),
            destination.path(),
            &[MigrationCategory::Hooks],
            false,
        )
        .expect("preview");

        assert!(report.contains(&source.path().join("hooks.json").display().to_string()));
        assert!(report.contains("Preview only"));
        assert!(!destination.path().join("hooks.json").exists());
    }

    #[test]
    fn apply_does_not_overwrite_and_rewrites_config_home_paths() {
        let source = tempdir().expect("source");
        let destination = tempdir().expect("destination");
        fs::write(
            source.path().join("config.toml"),
            format!(
                "model_instructions_file = \"{}/skills/example.md\"\n",
                source.path().display()
            ),
        )
        .expect("config fixture");
        fs::write(source.path().join("history.jsonl"), "source\n").expect("history fixture");
        fs::write(destination.path().join("history.jsonl"), "destination\n")
            .expect("destination fixture");

        run(
            source.path(),
            destination.path(),
            &[MigrationCategory::Config, MigrationCategory::History],
            true,
        )
        .expect("apply");

        let config =
            fs::read_to_string(destination.path().join("config.toml")).expect("migrated config");
        assert!(config.contains(&destination.path().display().to_string()));
        assert!(!config.contains(&source.path().display().to_string()));
        assert_eq!(
            fs::read_to_string(destination.path().join("history.jsonl")).expect("history"),
            "destination\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn migration_skips_symlinks() {
        use std::os::unix::fs::symlink;

        let source = tempdir().expect("source");
        let destination = tempdir().expect("destination");
        fs::create_dir(source.path().join("rules")).expect("rules");
        fs::write(source.path().join("outside"), "secret").expect("outside");
        symlink(
            source.path().join("outside"),
            source.path().join("rules/link"),
        )
        .expect("symlink");

        run(
            source.path(),
            destination.path(),
            &[MigrationCategory::Rules],
            true,
        )
        .expect("apply");

        assert!(!destination.path().join("rules/link").exists());
    }

    #[cfg(unix)]
    #[test]
    fn migration_refuses_destination_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let source = tempdir().expect("source");
        let destination = tempdir().expect("destination");
        let outside = tempdir().expect("outside");
        fs::create_dir(source.path().join("rules")).expect("rules");
        fs::write(source.path().join("rules/policy.rules"), "allow").expect("rule");
        symlink(outside.path(), destination.path().join("rules")).expect("destination symlink");

        let err = run(
            source.path(),
            destination.path(),
            &[MigrationCategory::Rules],
            true,
        )
        .expect_err("destination symlink must fail");

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(!outside.path().join("policy.rules").exists());
    }
}
