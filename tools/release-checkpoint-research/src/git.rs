//! Read-only local release-evidence collection.
//!
//! Every Git invocation in this module is made through `Command::args`; no
//! command is passed through a shell.  Path-bearing commands request NUL
//! delimiters and all path bytes are decoded strictly so malformed source data
//! becomes a named gap instead of lossy fabricated evidence.

use crate::evidence::{
    EvidenceSourceIdentity, EvidenceSourceKind, LocalRefObservation, LocalReleaseEvidence,
    PackageManifestVersionDeclaration, ReleaseDocumentDeclaration, RemoteEvidenceCollector,
    UnavailableSourceGap, WorktreeInventories, WorktreeInventoryKind, WorktreePathObservation,
};
use crate::{Availability, ExactText, FoundationError, FullId, InclusiveSpan, RepoRelativePath};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const REF_FORMAT: &str = "%(refname)%00%(creatordate:iso-strict)%00%(subject)%00";

/// A read-only collector rooted at one canonical repository directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalReleaseEvidenceCollector {
    root: PathBuf,
}

impl LocalReleaseEvidenceCollector {
    pub fn new(repository_root: impl AsRef<Path>) -> Result<Self, FoundationError> {
        let root = crate::canonical_repository_root(repository_root.as_ref())?;
        Ok(Self { root })
    }

    pub fn repository_root(&self) -> &Path {
        &self.root
    }

    /// Collect all local sources.  A source-level failure is represented in the
    /// returned availability/gap fields; only an invalid collector root is a
    /// top-level error.
    pub fn collect(&self) -> Result<LocalReleaseEvidence, FoundationError> {
        let mut gaps = Vec::new();
        let refs = collect_local_refs(&self.root, &mut gaps);
        let worktree = collect_worktree_inventories(&self.root, &mut gaps);
        let discovery = discover_candidates(&self.root);
        let release_documents = collect_release_documents(&self.root, &discovery, &mut gaps);
        let package_manifests = collect_package_manifests(&self.root, &discovery, &mut gaps);
        add_discovery_gaps(&discovery, &mut gaps);

        Ok(LocalReleaseEvidence::without_remote(
            refs,
            worktree,
            release_documents,
            package_manifests,
            gaps,
        ))
    }

    pub fn capture(&self) -> Result<LocalReleaseEvidence, FoundationError> {
        self.collect()
    }

    pub fn collect_with_remote<C: RemoteEvidenceCollector>(
        &self,
        remote: &C,
    ) -> Result<LocalReleaseEvidence, FoundationError> {
        Ok(self.collect()?.attach_remote(remote))
    }

    pub fn capture_with_remote<C: RemoteEvidenceCollector>(
        &self,
        remote: &C,
    ) -> Result<LocalReleaseEvidence, FoundationError> {
        self.collect_with_remote(remote)
    }
}

/// Compatibility names for the local collector.
pub type LocalEvidenceCollector = LocalReleaseEvidenceCollector;
pub type ReleaseEvidenceCollector = LocalReleaseEvidenceCollector;

/// Collect read-only local release evidence from an absolute repository path.
pub fn collect_local_release_evidence(
    repository_root: impl AsRef<Path>,
) -> Result<LocalReleaseEvidence, FoundationError> {
    LocalReleaseEvidenceCollector::new(repository_root)?.collect()
}

/// Collect local release evidence and attach one explicitly injected remote
/// snapshot.  This function performs no network operation.
pub fn collect_release_evidence<C: RemoteEvidenceCollector>(
    repository_root: impl AsRef<Path>,
    remote: &C,
) -> Result<LocalReleaseEvidence, FoundationError> {
    LocalReleaseEvidenceCollector::new(repository_root)?.collect_with_remote(remote)
}

fn collect_local_refs(
    root: &Path,
    gaps: &mut Vec<UnavailableSourceGap>,
) -> Availability<Vec<LocalRefObservation>> {
    let local_source = source(EvidenceSourceKind::LocalGit, "local-refs");
    let args = vec!["for-each-ref".to_owned(), format!("--format={REF_FORMAT}")];
    let output = match run_git(root, &args) {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            gaps.push(gap_from_output(local_source.clone(), &args, &output));
            return Availability::Unavailable;
        }
        Err(error) => {
            gaps.push(UnavailableSourceGap::new(
                local_source.clone(),
                error.to_string(),
            ));
            return Availability::Unavailable;
        }
    };

    let records = match parse_ref_records(&normalize_ref_output(&output.stdout)) {
        Ok(records) => records,
        Err(reason) => {
            gaps.push(UnavailableSourceGap::new(local_source.clone(), reason));
            return Availability::Unavailable;
        }
    };
    if records.is_empty() {
        return Availability::Empty;
    }

    let mut observations = Vec::with_capacity(records.len());
    for (full_ref, date, subject) in records {
        let resolved_commit = match resolve_ref(root, &full_ref) {
            Ok(commit) => Availability::Present(commit),
            Err(error) => {
                gaps.push(UnavailableSourceGap::new(
                    source(
                        EvidenceSourceKind::LocalGit,
                        format!("local-ref/{full_ref}"),
                    ),
                    error.to_string(),
                ));
                Availability::Unavailable
            }
        };
        let observation = LocalRefObservation::try_new(
            full_ref,
            resolved_commit,
            exact_field(date),
            exact_field(subject),
        );
        let observation = match observation {
            Ok(value) => value,
            Err(error) => {
                gaps.push(UnavailableSourceGap::new(
                    local_source.clone(),
                    error.to_string(),
                ));
                continue;
            }
        };
        observations.push(observation);
    }
    observations.sort_by(|left, right| left.full_ref.cmp(&right.full_ref));
    Availability::Present(observations)
}

fn resolve_ref(root: &Path, full_ref: &str) -> Result<FullId, FoundationError> {
    let expression = format!("{full_ref}^{{commit}}");
    let args = vec![
        "rev-parse".to_owned(),
        "--verify".to_owned(),
        "--end-of-options".to_owned(),
        expression,
    ];
    let output = run_git(root, &args)?;
    if !output.status.success() {
        return Err(git_failure(&args, &output));
    }
    let text = strict_single_line(&output.stdout, "resolved Git commit")?;
    FullId::new(text)
}

fn collect_worktree_inventories(
    root: &Path,
    gaps: &mut Vec<UnavailableSourceGap>,
) -> WorktreeInventories {
    let staged = collect_diff_inventory(
        root,
        WorktreeInventoryKind::Staged,
        vec![
            "diff".to_owned(),
            "--no-ext-diff".to_owned(),
            "--cached".to_owned(),
            "--name-status".to_owned(),
            "--no-renames".to_owned(),
            "-z".to_owned(),
            "--".to_owned(),
        ],
        gaps,
    );
    let unstaged = collect_diff_inventory(
        root,
        WorktreeInventoryKind::Unstaged,
        vec![
            "diff".to_owned(),
            "--no-ext-diff".to_owned(),
            "--name-status".to_owned(),
            "--no-renames".to_owned(),
            "-z".to_owned(),
            "--".to_owned(),
        ],
        gaps,
    );
    let untracked = collect_path_inventory(
        root,
        WorktreeInventoryKind::Untracked,
        vec![
            "ls-files".to_owned(),
            "--full-name".to_owned(),
            "--others".to_owned(),
            "--exclude-standard".to_owned(),
            "-z".to_owned(),
            "--".to_owned(),
        ],
        "untracked",
        gaps,
    );
    let ignored = collect_path_inventory(
        root,
        WorktreeInventoryKind::Ignored,
        vec![
            "ls-files".to_owned(),
            "--full-name".to_owned(),
            "--others".to_owned(),
            "--ignored".to_owned(),
            "--exclude-standard".to_owned(),
            "-z".to_owned(),
            "--".to_owned(),
        ],
        "ignored",
        gaps,
    );
    WorktreeInventories {
        staged,
        unstaged,
        untracked,
        ignored,
    }
}

fn collect_diff_inventory(
    root: &Path,
    kind: WorktreeInventoryKind,
    args: Vec<String>,
    gaps: &mut Vec<UnavailableSourceGap>,
) -> Availability<Vec<WorktreePathObservation>> {
    let source = source(EvidenceSourceKind::Worktree, kind.name());
    let output = match run_git(root, &args) {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            gaps.push(gap_from_output(source, &args, &output));
            return Availability::Unavailable;
        }
        Err(error) => {
            gaps.push(UnavailableSourceGap::new(source, error.to_string()));
            return Availability::Unavailable;
        }
    };
    let records = match parse_name_status_records(&output.stdout) {
        Ok(records) => records,
        Err(reason) => {
            gaps.push(UnavailableSourceGap::new(source, reason));
            return Availability::Unavailable;
        }
    };
    observations_from_records(kind, records, gaps)
}

fn collect_path_inventory(
    root: &Path,
    kind: WorktreeInventoryKind,
    args: Vec<String>,
    status: &str,
    gaps: &mut Vec<UnavailableSourceGap>,
) -> Availability<Vec<WorktreePathObservation>> {
    let source = source(EvidenceSourceKind::Worktree, kind.name());
    let output = match run_git(root, &args) {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            gaps.push(gap_from_output(source, &args, &output));
            return Availability::Unavailable;
        }
        Err(error) => {
            gaps.push(UnavailableSourceGap::new(source, error.to_string()));
            return Availability::Unavailable;
        }
    };
    let paths = match parse_nul_texts(&output.stdout) {
        Ok(paths) => paths,
        Err(reason) => {
            gaps.push(UnavailableSourceGap::new(source, reason));
            return Availability::Unavailable;
        }
    };
    let records = paths
        .into_iter()
        .map(|path| (status.to_owned(), path))
        .collect();
    observations_from_records(kind, records, gaps)
}

fn observations_from_records(
    kind: WorktreeInventoryKind,
    records: Vec<(String, String)>,
    gaps: &mut Vec<UnavailableSourceGap>,
) -> Availability<Vec<WorktreePathObservation>> {
    if records.is_empty() {
        return Availability::Empty;
    }
    let source = source(EvidenceSourceKind::Worktree, kind.name());
    let mut observations = Vec::with_capacity(records.len());
    for (status, path) in records {
        let path = match RepoRelativePath::new(path) {
            Ok(path) => path,
            Err(error) => {
                gaps.push(UnavailableSourceGap::new(source, error.to_string()));
                return Availability::Unavailable;
            }
        };
        observations.push(WorktreePathObservation::new(kind, path, status));
    }
    observations.sort_by(|left, right| left.path.cmp(&right.path));
    Availability::Present(observations)
}

fn normalize_ref_output(bytes: &[u8]) -> Vec<u8> {
    let mut normalized = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        normalized.push(byte);
        index += 1;
        if byte == 0 && bytes.get(index) == Some(&b'\n') {
            index += 1;
        }
    }
    normalized
}

fn parse_ref_records(bytes: &[u8]) -> Result<Vec<(String, String, String)>, String> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    if fields.last().copied() != Some(&[][..]) {
        return Err("local ref output was not NUL terminated".to_owned());
    }
    let mut records = Vec::new();
    let mut index = 0;
    while index < fields.len() - 1 {
        if index + 2 >= fields.len() - 1 {
            return Err("malformed local ref record".to_owned());
        }
        let full_ref = strict_utf8(fields[index], "local ref name")?;
        if full_ref.is_empty() {
            return Err("local ref name was empty".to_owned());
        }
        let date = strict_utf8(fields[index + 1], "local ref date")?;
        let subject = strict_utf8(fields[index + 2], "local ref subject")?;
        records.push((full_ref, date, subject));
        index += 3;
    }
    Ok(records)
}

fn parse_name_status_records(bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    if fields.last().copied() != Some(&[][..]) {
        return Err("Git name-status output was not NUL terminated".to_owned());
    }
    let fields = &fields[..fields.len() - 1];
    if fields.iter().any(|field| field.contains(&b'\t')) {
        let mut result = Vec::with_capacity(fields.len());
        for field in fields {
            let Some(tab) = field.iter().position(|byte| *byte == b'\t') else {
                return Err("malformed Git name-status record".to_owned());
            };
            let status = strict_utf8(&field[..tab], "Git status")?;
            let path = strict_utf8(&field[tab + 1..], "Git path")?;
            if status.is_empty() || path.is_empty() {
                return Err("Git name-status record contained an empty field".to_owned());
            }
            result.push((status, path));
        }
        return Ok(result);
    }
    if fields.len() % 2 != 0 {
        return Err("malformed NUL-delimited Git name-status output".to_owned());
    }
    let mut result = Vec::with_capacity(fields.len() / 2);
    for pair in fields.chunks_exact(2) {
        let status = strict_utf8(pair[0], "Git status")?;
        let path = strict_utf8(pair[1], "Git path")?;
        if status.is_empty() || path.is_empty() {
            return Err("Git name-status record contained an empty field".to_owned());
        }
        result.push((status, path));
    }
    Ok(result)
}

fn parse_nul_texts(bytes: &[u8]) -> Result<Vec<String>, String> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    if fields.last().copied() != Some(&[][..]) {
        return Err("NUL-delimited Git path output was not terminated".to_owned());
    }
    fields[..fields.len() - 1]
        .iter()
        .map(|field| {
            let path = strict_utf8(field, "Git path")?;
            if path.is_empty() {
                return Err("Git path record was empty".to_owned());
            }
            Ok(path)
        })
        .collect()
}

fn strict_utf8(bytes: &[u8], label: &str) -> Result<String, String> {
    String::from_utf8(bytes.to_owned()).map_err(|_| format!("{label} was not valid UTF-8"))
}

fn strict_single_line(bytes: &[u8], label: &str) -> Result<String, FoundationError> {
    let text = String::from_utf8(bytes.to_owned())
        .map_err(|_| FoundationError::boundary(format!("{label} was not valid UTF-8")))?;
    let text = text.strip_suffix('\n').unwrap_or(&text);
    let text = text.strip_suffix('\r').unwrap_or(text);
    if text.is_empty() || text.contains(['\r', '\n']) {
        return Err(FoundationError::Git {
            args: label.to_owned(),
            message: "expected one complete line".to_owned(),
        });
    }
    Ok(text.to_owned())
}

fn exact_field(value: String) -> Availability<ExactText> {
    if value.is_empty() {
        Availability::Empty
    } else {
        Availability::Present(ExactText::new(value))
    }
}

#[derive(Debug, Default)]
struct CandidateDiscovery {
    release_documents: Vec<PathBuf>,
    package_manifests: Vec<PathBuf>,
    errors: Vec<String>,
}

fn discover_candidates(root: &Path) -> CandidateDiscovery {
    let mut discovery = CandidateDiscovery::default();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                discovery.errors.push(format!(
                    "could not enumerate `{}`: {error}",
                    directory.to_string_lossy()
                ));
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    discovery.errors.push(format!(
                        "could not enumerate an entry under `{}`: {error}",
                        directory.to_string_lossy()
                    ));
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    discovery.errors.push(format!(
                        "could not inspect `{}`: {error}",
                        path.to_string_lossy()
                    ));
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            let relative = match crate::relative_repository_path(root, &path) {
                Ok(relative) => relative,
                Err(error) => {
                    discovery.errors.push(format!(
                        "could not represent `{}` as a repository path: {error}",
                        path.to_string_lossy()
                    ));
                    continue;
                }
            };
            if crate::is_artifact_subtree(relative.as_str()) {
                continue;
            }
            if metadata.is_dir() {
                if relative.as_str() == ".git"
                    || relative
                        .as_str()
                        .split('/')
                        .any(|component| component == ".git")
                {
                    continue;
                }
                pending.push(path);
            } else if metadata.is_file() {
                if is_release_document(relative.as_str()) {
                    discovery.release_documents.push(path.clone());
                }
                if is_package_manifest(relative.as_str()) {
                    discovery.package_manifests.push(path);
                }
            }
        }
    }
    discovery.release_documents.sort();
    discovery.package_manifests.sort();
    discovery.errors.sort();
    discovery
}

fn is_release_document(relative: &str) -> bool {
    let file_name = relative.rsplit('/').next().unwrap_or(relative);
    let lower = file_name.to_ascii_lowercase();
    let extension = lower.rsplit('.').next().unwrap_or("");
    if !matches!(extension, "md" | "markdown" | "mdx" | "rst" | "txt") {
        return false;
    }
    let stem = lower
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(lower.as_str());
    let is_root_readme = !relative.contains('/')
        && matches!(
            lower.as_str(),
            "readme.md" | "readme.markdown" | "readme.mdx"
        );
    if is_root_readme {
        return true;
    }
    stem == "changelog"
        || stem.starts_with("changelog-")
        || stem.starts_with("changes")
        || stem.contains("release")
        || relative
            .split('/')
            .any(|component| matches!(component, "release" | "releases" | "release-notes"))
}

fn is_package_manifest(relative: &str) -> bool {
    let file_name = relative.rsplit('/').next().unwrap_or(relative);
    let lower = file_name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "cargo.toml"
            | "package.json"
            | "pyproject.toml"
            | "setup.cfg"
            | "setup.py"
            | "go.mod"
            | "pom.xml"
            | "build.gradle"
            | "build.gradle.kts"
    ) || lower.ends_with(".csproj")
        || lower.ends_with(".nuspec")
}

fn add_discovery_gaps(discovery: &CandidateDiscovery, gaps: &mut Vec<UnavailableSourceGap>) {
    if discovery.errors.is_empty() {
        return;
    }
    let reason = discovery.errors.join("; ");
    gaps.push(UnavailableSourceGap::new(
        source(EvidenceSourceKind::ReleaseDocument, "discovery"),
        reason.clone(),
    ));
    gaps.push(UnavailableSourceGap::new(
        source(EvidenceSourceKind::PackageManifest, "discovery"),
        reason,
    ));
}

fn collect_release_documents(
    root: &Path,
    discovery: &CandidateDiscovery,
    gaps: &mut Vec<UnavailableSourceGap>,
) -> Availability<Vec<ReleaseDocumentDeclaration>> {
    if !discovery.errors.is_empty() {
        return Availability::Unavailable;
    }
    let mut declarations = Vec::new();
    let mut failed = false;
    for path in &discovery.release_documents {
        match parse_release_document(root, path) {
            Ok(values) => declarations.extend(values),
            Err(error) => {
                failed = true;
                gaps.push(UnavailableSourceGap::new(
                    source(EvidenceSourceKind::ReleaseDocument, source_name(root, path)),
                    error.to_string(),
                ));
            }
        }
    }
    if failed {
        return Availability::Unavailable;
    }
    declarations.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.span.cmp(&right.span))
            .then(left.text.cmp(&right.text))
    });
    if declarations.is_empty() {
        Availability::Empty
    } else {
        Availability::Present(declarations)
    }
}

fn collect_package_manifests(
    root: &Path,
    discovery: &CandidateDiscovery,
    gaps: &mut Vec<UnavailableSourceGap>,
) -> Availability<Vec<PackageManifestVersionDeclaration>> {
    if !discovery.errors.is_empty() {
        return Availability::Unavailable;
    }
    let mut declarations = Vec::new();
    let mut failed = false;
    for path in &discovery.package_manifests {
        match parse_package_manifest(root, path) {
            Ok(values) => declarations.extend(values),
            Err(error) => {
                failed = true;
                gaps.push(UnavailableSourceGap::new(
                    source(EvidenceSourceKind::PackageManifest, source_name(root, path)),
                    error.to_string(),
                ));
            }
        }
    }
    if failed {
        return Availability::Unavailable;
    }
    declarations.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.span.cmp(&right.span))
            .then(left.text.cmp(&right.text))
    });
    if declarations.is_empty() {
        Availability::Empty
    } else {
        Availability::Present(declarations)
    }
}

fn parse_release_document(
    root: &Path,
    path: &Path,
) -> Result<Vec<ReleaseDocumentDeclaration>, FoundationError> {
    let relative = crate::relative_repository_path(root, path)?;
    let text = read_text(path, "read release document")?;
    let mut declarations = Vec::new();
    for (line_number, line) in exact_lines(&text) {
        let Some(version) = find_version_token(&line) else {
            continue;
        };
        if !has_release_signal(&line) {
            continue;
        }
        let span = InclusiveSpan::new(line_number, line_number)?;
        declarations.push(ReleaseDocumentDeclaration::try_new(
            relative.clone(),
            span,
            version,
            line,
        )?);
    }
    Ok(declarations)
}

fn parse_package_manifest(
    root: &Path,
    path: &Path,
) -> Result<Vec<PackageManifestVersionDeclaration>, FoundationError> {
    let relative = crate::relative_repository_path(root, path)?;
    let text = read_text(path, "read package manifest")?;
    let file_name = relative
        .as_str()
        .rsplit('/')
        .next()
        .unwrap_or(relative.as_str())
        .to_ascii_lowercase();
    if file_name == "package.json" {
        serde_json::from_str::<serde_json::Value>(&text).map_err(|error| {
            FoundationError::Serialization(format!("malformed package manifest: {error}"))
        })?;
    }

    let mut declarations = Vec::new();
    for (line_number, line) in exact_lines(&text) {
        match manifest_version_value(&file_name, &line)? {
            Some(version) => {
                let span = InclusiveSpan::new(line_number, line_number)?;
                declarations.push(PackageManifestVersionDeclaration::try_new(
                    relative.clone(),
                    span,
                    version,
                    line,
                )?);
            }
            None => {}
        }
    }
    Ok(declarations)
}

fn read_text(path: &Path, operation: &'static str) -> Result<String, FoundationError> {
    fs::read_to_string(path).map_err(|source| FoundationError::Io { operation, source })
}

fn exact_lines(text: &str) -> Vec<(u32, String)> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut line_number = 1_u32;
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            result.push((line_number, text[start..index].to_owned()));
            line_number += 1;
            start = index + 1;
        }
    }
    if start < text.len() {
        result.push((line_number, text[start..].to_owned()));
    }
    result
}

fn has_release_signal(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("release")
        || lower.contains("version")
        || line.trim_start().starts_with('#')
        || line.contains('[')
}

fn find_version_token(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let starts_with_v = matches!(bytes[index], b'v' | b'V')
            && bytes.get(index + 1).is_some_and(u8::is_ascii_digit);
        if !bytes[index].is_ascii_digit() && !starts_with_v {
            index += 1;
            continue;
        }
        if index > 0 && bytes[index - 1].is_ascii_alphanumeric() {
            index += 1;
            continue;
        }
        let start = index;
        if starts_with_v {
            index += 1;
        }
        let mut segments = 0;
        loop {
            let digit_start = index;
            while bytes.get(index).is_some_and(u8::is_ascii_digit) {
                index += 1;
            }
            if index == digit_start {
                break;
            }
            segments += 1;
            if bytes.get(index) != Some(&b'.') {
                break;
            }
            index += 1;
        }
        if segments < 2 {
            index = start + 1;
            continue;
        }
        if matches!(bytes.get(index), Some(b'-' | b'+')) {
            index += 1;
            while bytes
                .get(index)
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
            {
                index += 1;
            }
        }
        if bytes
            .get(index)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
        {
            index = start + 1;
            continue;
        }
        return Some(line[start..index].to_owned());
    }
    None
}

fn manifest_version_value(file_name: &str, line: &str) -> Result<Option<String>, FoundationError> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
        return Ok(None);
    }
    if file_name == "package.json" {
        return json_version_value(trimmed);
    }
    if file_name == "pom.xml" || file_name.ends_with(".csproj") || file_name.ends_with(".nuspec") {
        return xml_version_value(trimmed);
    }
    let Some(equal) = trimmed.find('=') else {
        return Ok(None);
    };
    if trimmed[..equal].trim() != "version" {
        return Ok(None);
    }
    let value = trimmed[equal + 1..].trim();
    if value.is_empty() {
        return Err(FoundationError::invalid(
            "package_manifest",
            "version declaration has no value",
        ));
    }
    if value.starts_with('"') || value.starts_with('\'') {
        return quoted_manifest_value(value);
    }
    if value.starts_with('{') && value.ends_with('}') {
        return Ok(Some(value.to_owned()));
    }
    Err(FoundationError::invalid(
        "package_manifest",
        "version declaration is not a valid quoted or workspace value",
    ))
}

fn json_version_value(line: &str) -> Result<Option<String>, FoundationError> {
    let Some(key) = line.find("\"version\"") else {
        return Ok(None);
    };
    let after_key = &line[key + "\"version\"".len()..];
    let Some(colon) = after_key.find(':') else {
        return Err(FoundationError::invalid(
            "package_manifest",
            "JSON version declaration has no colon",
        ));
    };
    let value = after_key[colon + 1..].trim_start();
    if !value.starts_with('"') {
        return Err(FoundationError::invalid(
            "package_manifest",
            "JSON version declaration is not a string",
        ));
    }
    quoted_manifest_value(value)
}

fn xml_version_value(line: &str) -> Result<Option<String>, FoundationError> {
    let lower = line.to_ascii_lowercase();
    let Some(key) = lower.find("version") else {
        return Ok(None);
    };
    let after_key = &line[key + "version".len()..];
    let Some(equal) = after_key.find('=') else {
        return Err(FoundationError::invalid(
            "package_manifest",
            "XML version declaration has no equals sign",
        ));
    };
    let value = after_key[equal + 1..].trim_start();
    if !value.starts_with('"') && !value.starts_with('\'') {
        return Err(FoundationError::invalid(
            "package_manifest",
            "XML version declaration is not quoted",
        ));
    }
    quoted_manifest_value(value)
}

fn quoted_manifest_value(value: &str) -> Result<Option<String>, FoundationError> {
    let quote = value.as_bytes()[0];
    let mut escaped = false;
    for (index, byte) in value.bytes().enumerate().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
            continue;
        }
        if byte == quote {
            return Ok(Some(value[1..index].to_owned()));
        }
    }
    Err(FoundationError::invalid(
        "package_manifest",
        "unterminated quoted version declaration",
    ))
}

fn source(kind: EvidenceSourceKind, name: impl Into<String>) -> EvidenceSourceIdentity {
    EvidenceSourceIdentity {
        kind,
        name: ExactText::new(name),
    }
}

fn source_name(root: &Path, path: &Path) -> String {
    crate::relative_repository_path(root, path)
        .map(|path| path.into_inner())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

fn gap_from_output(
    source: EvidenceSourceIdentity,
    args: &[String],
    output: &Output,
) -> UnavailableSourceGap {
    UnavailableSourceGap::new(source, git_failure(args, output).to_string())
}

fn run_git(root: &Path, args: &[String]) -> Result<Output, FoundationError> {
    // `args` are passed as individual argv values.  In particular, ref names
    // and paths are never interpolated into a shell command string.
    Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|source| FoundationError::Io {
            operation: "run read-only git command",
            source,
        })
}

fn git_failure(args: &[String], output: &Output) -> FoundationError {
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    FoundationError::Git {
        args: args.join(" "),
        message: if message.is_empty() {
            format!("command exited with status {}", output.status)
        } else {
            message
        },
    }
}
