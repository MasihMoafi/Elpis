//! Foundation contracts and the fail-closed audit boundary for release-checkpoint research.
//!
//! This crate deliberately has no connection to a live remote service.  It captures
//! local Git/worktree facts, keeps evidence and report values typed, and only opens
//! report files after a completed start snapshot has been recorded.

#![forbid(unsafe_code)]

pub mod artifacts;
pub mod ci;
pub mod delta;
pub mod evidence;
pub mod git;
pub mod ignore;
pub mod releases;
pub mod report;
pub mod validate;
pub mod workflows;

pub use artifacts::*;
pub use ci::*;
pub use delta::*;
pub use evidence::*;
pub use git::*;
pub use ignore::*;
pub use releases::*;
pub use report::*;
pub use validate::*;
pub use workflows::*;

use serde::de::{self, DeserializeOwned};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fmt;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};

/// The only directory in which this package may create report artifacts.
pub const ARTIFACT_DIRECTORY: &str = ".kiro/specs/release-checkpoint-research";

/// A value with explicit empty and unavailable states.
///
/// `Empty` means the source was inspected and contained no value. `Unavailable`
/// means the source could not provide a value. Neither state is represented by a
/// magic string or a missing field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Availability<T> {
    Empty,
    Unavailable,
    Present(T),
}

impl<T> Availability<T> {
    pub fn is_empty(&self) -> bool {
        matches!(self, Self::Empty)
    }

    pub fn is_unavailable(&self) -> bool {
        matches!(self, Self::Unavailable)
    }

    pub fn is_present(&self) -> bool {
        matches!(self, Self::Present(_))
    }

    pub fn as_ref(&self) -> Availability<&T> {
        match self {
            Self::Empty => Availability::Empty,
            Self::Unavailable => Availability::Unavailable,
            Self::Present(value) => Availability::Present(value),
        }
    }

    pub fn present(value: T) -> Self {
        Self::Present(value)
    }
}

/// Compatibility name for callers that prefer a tri-state description.
pub type TriState<T> = Availability<T>;
/// Compatibility name for callers that describe captured values as observed.
pub type Observed<T> = Availability<T>;

/// An error returned by the foundation layer. Errors are intentionally textual at
/// the boundary so they can be reported without leaking an OS-specific error type
/// into the serialized audit contracts.
#[derive(Debug)]
pub enum FoundationError {
    Invalid {
        field: &'static str,
        reason: String,
    },
    Io {
        operation: &'static str,
        source: io::Error,
    },
    Git {
        args: String,
        message: String,
    },
    Boundary(String),
    Serialization(String),
    Integrity(String),
}

impl FoundationError {
    fn invalid(field: &'static str, reason: impl Into<String>) -> Self {
        Self::Invalid {
            field,
            reason: reason.into(),
        }
    }

    fn boundary(reason: impl Into<String>) -> Self {
        Self::Boundary(reason.into())
    }

    fn integrity(reason: impl Into<String>) -> Self {
        Self::Integrity(reason.into())
    }
}

impl fmt::Display for FoundationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid { field, reason } => write!(formatter, "invalid {field}: {reason}"),
            Self::Io { operation, source } => write!(formatter, "{operation}: {source}"),
            Self::Git { args, message } => write!(formatter, "git {args}: {message}"),
            Self::Boundary(reason) => write!(formatter, "unsafe audit boundary: {reason}"),
            Self::Serialization(reason) => write!(formatter, "serialization failed: {reason}"),
            Self::Integrity(reason) => write!(formatter, "integrity check failed: {reason}"),
        }
    }
}

impl std::error::Error for FoundationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<io::Error> for FoundationError {
    fn from(source: io::Error) -> Self {
        Self::Io {
            operation: "filesystem operation",
            source,
        }
    }
}

/// Serialize a contract with stable struct field order and ordered map keys.
/// Contract maps use `BTreeMap`, and serde emits struct fields in declaration
/// order, so the resulting JSON is deterministic for the same value.
pub fn serialize_deterministically<T: Serialize>(value: &T) -> Result<String, FoundationError> {
    serde_json::to_string(value).map_err(|error| FoundationError::Serialization(error.to_string()))
}

/// Strict JSON deserialization helper. Unknown enum variants are rejected by
/// serde's derived implementation rather than being silently downgraded.
pub fn deserialize_strict<T: DeserializeOwned>(text: &str) -> Result<T, FoundationError> {
    serde_json::from_str(text).map_err(|error| FoundationError::Serialization(error.to_string()))
}

/// Exact, untrimmed user/source text.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ExactText(String);

impl ExactText {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

impl From<String> for ExactText {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for ExactText {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl AsRef<str> for ExactText {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Display for ExactText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A complete Git object ID. Abbreviated IDs are never accepted. Both SHA-1 and
/// SHA-256 repositories are supported, while the original spelling is preserved.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct FullId(String);

impl FullId {
    pub fn new(value: impl Into<String>) -> Result<Self, FoundationError> {
        let value = value.into();
        validate_full_id(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

fn validate_full_id(value: &str) -> Result<(), FoundationError> {
    let valid_length = value.len() == 40 || value.len() == 64;
    if !valid_length {
        return Err(FoundationError::invalid(
            "full_id",
            "a complete object ID must contain 40 or 64 hexadecimal characters",
        ));
    }
    if !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(FoundationError::invalid(
            "full_id",
            "object IDs may contain only hexadecimal characters",
        ));
    }
    Ok(())
}

impl TryFrom<String> for FullId {
    type Error = FoundationError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl TryFrom<&str> for FullId {
    type Error = FoundationError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<FullId> for String {
    fn from(value: FullId) -> Self {
        value.0
    }
}

impl AsRef<str> for FullId {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Display for FullId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A normalized repository-relative path. It is deliberately a textual contract
/// using `/`, independent of the host's path separator.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RepoRelativePath(String);

impl RepoRelativePath {
    pub fn new(value: impl Into<String>) -> Result<Self, FoundationError> {
        let value = value.into();
        validate_repo_relative_path(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn as_path(&self) -> &Path {
        Path::new(self.as_str())
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

fn validate_repo_relative_path(value: &str) -> Result<(), FoundationError> {
    if value.is_empty() {
        return Err(FoundationError::invalid(
            "repo_relative_path",
            "the path must not be empty",
        ));
    }
    if value.as_bytes().contains(&0) {
        return Err(FoundationError::invalid(
            "repo_relative_path",
            "NUL is not allowed",
        ));
    }
    if value.starts_with('/') || value.starts_with('\\') {
        return Err(FoundationError::invalid(
            "repo_relative_path",
            "absolute paths are not allowed",
        ));
    }
    if value.len() >= 2 && value.as_bytes()[1] == b':' {
        return Err(FoundationError::invalid(
            "repo_relative_path",
            "drive-prefixed paths are not allowed",
        ));
    }
    if value.contains('\\') {
        return Err(FoundationError::invalid(
            "repo_relative_path",
            "backslash separators are not allowed",
        ));
    }
    for component in value.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(FoundationError::invalid(
                "repo_relative_path",
                "paths must be normalized and may not contain empty, `.` or `..` components",
            ));
        }
    }
    Ok(())
}

impl TryFrom<String> for RepoRelativePath {
    type Error = FoundationError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl TryFrom<&str> for RepoRelativePath {
    type Error = FoundationError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<RepoRelativePath> for String {
    fn from(value: RepoRelativePath) -> Self {
        value.0
    }
}

impl AsRef<str> for RepoRelativePath {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Display for RepoRelativePath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A one-dimensional inclusive span (normally line numbers).
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct InclusiveSpan {
    pub start: u32,
    pub end: u32,
}

impl<'de> Deserialize<'de> for InclusiveSpan {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            start: u32,
            end: u32,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.start, wire.end).map_err(de::Error::custom)
    }
}

impl InclusiveSpan {
    pub fn new(start: u32, end: u32) -> Result<Self, FoundationError> {
        if start == 0 || end == 0 {
            return Err(FoundationError::invalid(
                "inclusive_span",
                "span coordinates are one-based",
            ));
        }
        if end < start {
            return Err(FoundationError::invalid(
                "inclusive_span",
                "the end must not precede the start",
            ));
        }
        Ok(Self { start, end })
    }

    pub fn contains(&self, value: u32) -> bool {
        self.start <= value && value <= self.end
    }
}

/// Alias used by inventory/report callers that explicitly mean line spans.
pub type LineSpan = InclusiveSpan;

/// A two-dimensional inclusive source span.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct SourcePosition {
    pub line: u32,
    pub column: u32,
}

impl<'de> Deserialize<'de> for SourcePosition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            line: u32,
            column: u32,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.line, wire.column).map_err(de::Error::custom)
    }
}

impl SourcePosition {
    pub fn new(line: u32, column: u32) -> Result<Self, FoundationError> {
        if line == 0 || column == 0 {
            return Err(FoundationError::invalid(
                "source_position",
                "line and column coordinates are one-based",
            ));
        }
        Ok(Self { line, column })
    }
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct SourceSpan {
    pub start: SourcePosition,
    pub end: SourcePosition,
}

impl<'de> Deserialize<'de> for SourceSpan {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            start: SourcePosition,
            end: SourcePosition,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.start, wire.end).map_err(de::Error::custom)
    }
}

impl SourceSpan {
    pub fn new(start: SourcePosition, end: SourcePosition) -> Result<Self, FoundationError> {
        if end < start {
            return Err(FoundationError::invalid(
                "source_span",
                "the end must not precede the start",
            ));
        }
        Ok(Self { start, end })
    }
}

/// Stable local fingerprint used for Git/index/remote observations.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct Fingerprint(String);

impl<'de> Deserialize<'de> for Fingerprint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

impl Fingerprint {
    pub fn new(value: impl Into<String>) -> Result<Self, FoundationError> {
        let value = value.into();
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(FoundationError::invalid(
                "fingerprint",
                "a fingerprint must be non-empty hexadecimal text",
            ));
        }
        Ok(Self(value))
    }

    fn from_bytes(bytes: &[u8]) -> Self {
        // FNV-1a is used only as a stable local change fingerprint. It is not
        // presented as a cryptographic digest or a remote identity proof.
        let mut hash = 0xcbf29ce484222325_u64;
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        Self(format!("{hash:016x}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Fingerprint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// UTC seconds since the Unix epoch. No local timezone is involved.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UtcSeconds(u64);

impl UtcSeconds {
    pub fn now() -> Result<Self, FoundationError> {
        let duration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| {
                FoundationError::boundary(format!("system clock before Unix epoch: {error}"))
            })?;
        Ok(Self(duration.as_secs()))
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

/// An absolute, UTF-8 path captured after canonicalization.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AbsolutePath(String);

impl AbsolutePath {
    pub fn new(value: impl Into<String>) -> Result<Self, FoundationError> {
        let value = value.into();
        if !Path::new(&value).is_absolute() {
            return Err(FoundationError::invalid(
                "absolute_path",
                "the path must be absolute",
            ));
        }
        Ok(Self(value))
    }

    fn from_path(path: &Path) -> Result<Self, FoundationError> {
        let value = path
            .to_str()
            .ok_or_else(|| FoundationError::boundary("the repository path is not valid UTF-8"))?;
        Self::new(value.to_owned())
    }

    pub fn as_path(&self) -> &Path {
        Path::new(&self.0)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for AbsolutePath {
    type Error = FoundationError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<AbsolutePath> for String {
    fn from(value: AbsolutePath) -> Self {
        value.0
    }
}

/// Branch or detached-head state captured independently of the head ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum CheckoutState {
    Branch(ExactText),
    Detached,
}

impl<'de> Deserialize<'de> for CheckoutState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        enum Wire {
            Branch(String),
            Detached,
        }
        match Wire::deserialize(deserializer)? {
            Wire::Branch(name) => Self::branch(name).map_err(de::Error::custom),
            Wire::Detached => Ok(Self::Detached),
        }
    }
}

impl CheckoutState {
    pub fn branch(name: impl Into<String>) -> Result<Self, FoundationError> {
        let name = name.into();
        if name.is_empty() || name.contains(['\n', '\r', '\0']) {
            return Err(FoundationError::invalid(
                "branch",
                "branch names must be non-empty and may not contain control delimiters",
            ));
        }
        Ok(Self::Branch(ExactText::new(name)))
    }
}

/// A small serializable representation of protected filesystem metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesystemMetadata {
    pub is_directory: bool,
    pub is_regular_file: bool,
    pub is_symlink: bool,
    pub bytes: u64,
    pub modified_utc_seconds: Availability<UtcSeconds>,
    pub device: Availability<u64>,
    pub inode: Availability<u64>,
    pub hard_links: Availability<u64>,
    pub mode: Availability<u32>,
}

impl FilesystemMetadata {
    fn from_metadata(metadata: &Metadata) -> Self {
        let modified_utc_seconds = match metadata.modified() {
            Ok(time) => match time.duration_since(UNIX_EPOCH) {
                Ok(duration) => Availability::Present(UtcSeconds(duration.as_secs())),
                Err(_) => Availability::Unavailable,
            },
            Err(_) => Availability::Unavailable,
        };

        #[cfg(unix)]
        let (device, inode, hard_links, mode) = (
            Availability::Present(metadata.dev()),
            Availability::Present(metadata.ino()),
            Availability::Present(metadata.nlink()),
            Availability::Present(metadata.mode()),
        );
        #[cfg(not(unix))]
        let (device, inode, hard_links, mode) = (
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Present(1),
            Availability::Unavailable,
        );

        Self {
            is_directory: metadata.is_dir(),
            is_regular_file: metadata.is_file(),
            is_symlink: metadata.file_type().is_symlink(),
            bytes: metadata.len(),
            modified_utc_seconds,
            device,
            inode,
            hard_links,
            mode,
        }
    }

    fn same_identity(&self, other: &Self) -> bool {
        self.is_directory == other.is_directory
            && self.is_regular_file == other.is_regular_file
            && self.is_symlink == other.is_symlink
            && self.device == other.device
            && self.inode == other.inode
            && self.hard_links == other.hard_links
    }
}

/// The observed kind of one repository filesystem entry.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum FilesystemEntryType {
    Directory,
    RegularFile,
    Symlink,
    BlockDevice,
    CharacterDevice,
    Fifo,
    Socket,
    Other,
}

impl FilesystemEntryType {
    fn from_metadata(metadata: &Metadata) -> Self {
        if metadata.file_type().is_symlink() {
            Self::Symlink
        } else if metadata.is_dir() {
            Self::Directory
        } else if metadata.is_file() {
            Self::RegularFile
        } else {
            #[cfg(unix)]
            {
                let file_type = metadata.file_type();
                if file_type.is_block_device() {
                    return Self::BlockDevice;
                }
                if file_type.is_char_device() {
                    return Self::CharacterDevice;
                }
                if file_type.is_fifo() {
                    return Self::Fifo;
                }
                if file_type.is_socket() {
                    return Self::Socket;
                }
            }
            Self::Other
        }
    }
}

/// A complete observation of one path outside the research artifact subtree.
///
/// `metadata` contains the path type, byte length, ownership-safe identity, and
/// permissions where the host exposes them. Regular files carry a content
/// fingerprint; symlinks carry their un-followed target text. Other special
/// files are never opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesystemEntrySnapshot {
    pub path: RepoRelativePath,
    pub entry_type: FilesystemEntryType,
    pub metadata: FilesystemMetadata,
    pub content_fingerprint: Availability<Fingerprint>,
    pub symlink_target: Availability<ExactText>,
}

impl FilesystemEntrySnapshot {
    pub fn bytes(&self) -> u64 {
        self.metadata.bytes
    }

    pub fn permissions(&self) -> &Availability<u32> {
        &self.metadata.mode
    }
}

/// Deterministic filesystem state outside `ARTIFACT_DIRECTORY`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesystemSnapshot {
    pub entries: BTreeMap<RepoRelativePath, FilesystemEntrySnapshot>,
    pub fingerprint: Fingerprint,
}

impl FilesystemSnapshot {
    fn from_entries(
        entries: BTreeMap<RepoRelativePath, FilesystemEntrySnapshot>,
    ) -> Result<Self, FoundationError> {
        let serialized = serde_json::to_string(&entries)
            .map_err(|error| FoundationError::Serialization(error.to_string()))?;
        let fingerprint = Fingerprint::from_bytes(serialized.as_bytes());
        Ok(Self {
            entries,
            fingerprint,
        })
    }

    pub fn fingerprint(&self) -> &Fingerprint {
        &self.fingerprint
    }

    pub fn entry(&self, path: &RepoRelativePath) -> Option<&FilesystemEntrySnapshot> {
        self.entries.get(path)
    }
}

/// The protected artifact path and its pre-write metadata state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtectedPathSnapshot {
    pub path: RepoRelativePath,
    pub metadata: Availability<FilesystemMetadata>,
}

/// Local Git identity and fingerprints for one independent worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeIdentity {
    pub repository_root: AbsolutePath,
    pub checkout: CheckoutState,
    pub head: FullId,
    pub git_fingerprint: Fingerprint,
    pub remote_fingerprints: Availability<BTreeMap<ExactText, Fingerprint>>,
}

/// A start-of-audit snapshot. It is complete before a report file can be opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartSnapshot {
    pub captured_at_utc: UtcSeconds,
    pub identity: WorktreeIdentity,
    pub protected_artifact: ProtectedPathSnapshot,
    pub filesystem: FilesystemSnapshot,
}

/// Compatibility names used by callers that call the start snapshot a baseline.
pub type BaselineSnapshot = StartSnapshot;
pub type AuditSnapshot = StartSnapshot;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum InventoryState {
    Tracked,
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Other(ExactText),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryEntry {
    pub path: RepoRelativePath,
    pub state: InventoryState,
}

/// A fresh inventory captured for one worktree. No mutable global inventory is
/// shared between calls, which makes two worktrees independently auditable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeInventory {
    pub identity: WorktreeIdentity,
    pub tracked: Vec<RepoRelativePath>,
    pub entries: Vec<InventoryEntry>,
}

impl WorktreeInventory {
    pub fn capture(root: impl AsRef<Path>) -> Result<Self, FoundationError> {
        capture_worktree_inventory(root)
    }
}

/// A source path and its inclusive line span.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EvidenceLocator {
    pub path: RepoRelativePath,
    pub span: InclusiveSpan,
}

impl EvidenceLocator {
    pub fn new(path: RepoRelativePath, span: InclusiveSpan) -> Self {
        Self { path, span }
    }
}

/// A stable, non-empty citation identifier.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct EvidenceId(String);

impl EvidenceId {
    pub fn new(value: impl Into<String>) -> Result<Self, FoundationError> {
        let value = value.into();
        if value.is_empty()
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            return Err(FoundationError::invalid(
                "evidence_id",
                "IDs must be non-empty ASCII identifier text",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for EvidenceId {
    type Error = FoundationError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<EvidenceId> for String {
    fn from(value: EvidenceId) -> Self {
        value.0
    }
}

impl fmt::Display for EvidenceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A citation with typed locator and explicitly available/empty/unavailable quote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceCitation {
    pub id: EvidenceId,
    pub locator: EvidenceLocator,
    pub quote: Availability<ExactText>,
}

impl EvidenceCitation {
    pub fn new(id: EvidenceId, locator: EvidenceLocator, quote: Availability<ExactText>) -> Self {
        Self { id, locator, quote }
    }
}

/// Compatibility name for the citation primitive.
pub type Evidence = EvidenceCitation;

/// A citation collection that rejects duplicate IDs and duplicate locators.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct EvidenceSet {
    pub citations: Vec<EvidenceCitation>,
}

impl<'de> Deserialize<'de> for EvidenceSet {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            citations: Vec<EvidenceCitation>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::try_new(wire.citations).map_err(de::Error::custom)
    }
}

impl EvidenceSet {
    pub fn try_new(citations: Vec<EvidenceCitation>) -> Result<Self, FoundationError> {
        let mut result = Self::default();
        for citation in citations {
            result.push(citation)?;
        }
        Ok(result)
    }

    pub fn push(&mut self, citation: EvidenceCitation) -> Result<(), FoundationError> {
        if self.citations.iter().any(|item| item.id == citation.id) {
            return Err(FoundationError::invalid(
                "evidence_set",
                format!("duplicate evidence ID `{}`", citation.id),
            ));
        }
        if self
            .citations
            .iter()
            .any(|item| item.locator == citation.locator)
        {
            return Err(FoundationError::invalid(
                "evidence_set",
                "duplicate evidence locator",
            ));
        }
        self.citations.push(citation);
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.citations.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConclusionLabel {
    Pass,
    Fail,
    Inconclusive,
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Redaction {
    None,
    Sensitive,
    Secret,
    PersonalData,
    Omitted,
}

/// A typed conclusion. Labels and redaction are closed enums, not free-form text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Conclusion {
    pub label: ConclusionLabel,
    pub redaction: Redaction,
    pub rationale: ExactText,
    pub evidence_ids: Vec<EvidenceId>,
}

impl<'de> Deserialize<'de> for Conclusion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            label: ConclusionLabel,
            redaction: Redaction,
            rationale: ExactText,
            evidence_ids: Vec<EvidenceId>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(
            wire.label,
            wire.redaction,
            wire.rationale,
            wire.evidence_ids,
        )
        .map_err(de::Error::custom)
    }
}

impl Conclusion {
    pub fn new(
        label: ConclusionLabel,
        redaction: Redaction,
        rationale: ExactText,
        evidence_ids: Vec<EvidenceId>,
    ) -> Result<Self, FoundationError> {
        let mut ids = BTreeSet::new();
        for id in &evidence_ids {
            if !ids.insert(id) {
                return Err(FoundationError::invalid(
                    "conclusion",
                    "duplicate evidence IDs are not allowed",
                ));
            }
        }
        Ok(Self {
            label,
            redaction,
            rationale,
            evidence_ids,
        })
    }
}

/// A minimal complete report contract for later stages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuditReport {
    pub schema_version: ExactText,
    pub snapshot: StartSnapshot,
    pub conclusion: Conclusion,
    pub evidence: EvidenceSet,
}

impl<'de> Deserialize<'de> for AuditReport {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            schema_version: ExactText,
            snapshot: StartSnapshot,
            conclusion: Conclusion,
            evidence: EvidenceSet,
        }
        let wire = Wire::deserialize(deserializer)?;
        let report =
            Self::new(wire.snapshot, wire.conclusion, wire.evidence).map_err(de::Error::custom)?;
        if report.schema_version != wire.schema_version {
            return Err(de::Error::custom("unsupported audit report schema version"));
        }
        Ok(report)
    }
}

impl AuditReport {
    pub fn new(
        snapshot: StartSnapshot,
        conclusion: Conclusion,
        evidence: EvidenceSet,
    ) -> Result<Self, FoundationError> {
        for id in &conclusion.evidence_ids {
            if !evidence.citations.iter().any(|citation| &citation.id == id) {
                return Err(FoundationError::invalid(
                    "conclusion",
                    format!("conclusion references unknown evidence ID `{id}`"),
                ));
            }
        }
        Ok(Self {
            schema_version: ExactText::new("foundation-1"),
            snapshot,
            conclusion,
            evidence,
        })
    }
}

/// Fixed research report names. No arbitrary path or URL can be supplied to the writer.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum ReportOutput {
    ResearchReportMarkdown,
    ResearchReportJson,
}

impl ReportOutput {
    pub const fn filename(self) -> &'static str {
        match self {
            Self::ResearchReportMarkdown => "research-report.md",
            Self::ResearchReportJson => "research-report.json",
        }
    }

    pub fn parse(name: &str) -> Result<Self, FoundationError> {
        match name {
            "research-report.md" => Ok(Self::ResearchReportMarkdown),
            "research-report.json" => Ok(Self::ResearchReportJson),
            _ => Err(FoundationError::boundary(format!(
                "`{name}` is not a named research report output"
            ))),
        }
    }

    pub fn all() -> &'static [Self] {
        &[Self::ResearchReportMarkdown, Self::ResearchReportJson]
    }
}

impl TryFrom<&str> for ReportOutput {
    type Error = FoundationError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl TryFrom<String> for ReportOutput {
    type Error = FoundationError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<ReportOutput> for &'static str {
    fn from(value: ReportOutput) -> Self {
        value.filename()
    }
}

/// Typed names for the two fixed research report files.
pub type ResearchReportName = ReportOutput;
pub type ResearchReportFile = ReportOutput;

/// A completed or failed end-of-audit comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompletionStatus {
    VerifiedNoChanges,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompletionComparison {
    pub checked_at_utc: UtcSeconds,
    pub status: CompletionStatus,
    pub start_fingerprint: Fingerprint,
    pub current_fingerprint: Availability<Fingerprint>,
    pub start_filesystem_fingerprint: Fingerprint,
    pub current_filesystem_fingerprint: Availability<Fingerprint>,
    pub failure_reason: Availability<ExactText>,
}

impl CompletionComparison {
    pub fn is_verified(&self) -> bool {
        self.status == CompletionStatus::VerifiedNoChanges
    }
}

/// A report writer that can only be constructed by a snapshot-complete boundary.
pub struct ReportWriter {
    output: ReportOutput,
    path: PathBuf,
    file: File,
    bytes_written: u64,
}

impl ReportWriter {
    pub fn output(&self) -> ReportOutput {
        self.output
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn bytes_written(&self) -> u64 {
        self.bytes_written
    }

    pub fn finish(self) -> Result<PublishedReport, FoundationError> {
        self.file.sync_all().map_err(|source| FoundationError::Io {
            operation: "sync report output",
            source,
        })?;
        Ok(PublishedReport {
            output: self.output,
            path: AbsolutePath::from_path(&self.path)?,
            bytes_written: self.bytes_written,
        })
    }
}

impl Write for ReportWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self.file.write(bytes)?;
        self.bytes_written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishedReport {
    pub output: ReportOutput,
    pub path: AbsolutePath,
    pub bytes_written: u64,
}

/// The path policy and write gate. `new` only inspects the repository; it cannot
/// open a report until an `AuditSession` has completed its start snapshot.
pub struct AuditBoundary {
    repository_root: PathBuf,
    artifact_directory: PathBuf,
    snapshot_complete: bool,
    protected_at_start: Option<ProtectedPathSnapshot>,
}

impl AuditBoundary {
    pub fn new(repository_root: impl AsRef<Path>) -> Result<Self, FoundationError> {
        let repository_root = canonical_repository_root(repository_root.as_ref())?;
        let artifact_directory = repository_root.join(ARTIFACT_DIRECTORY);
        validate_existing_directory_chain(&repository_root, ARTIFACT_DIRECTORY)?;
        Ok(Self {
            repository_root,
            artifact_directory,
            snapshot_complete: false,
            protected_at_start: None,
        })
    }

    pub fn prepare(repository_root: impl AsRef<Path>) -> Result<Self, FoundationError> {
        Self::new(repository_root)
    }

    pub fn repository_root(&self) -> &Path {
        &self.repository_root
    }

    pub fn artifact_directory(&self) -> &Path {
        &self.artifact_directory
    }

    pub fn is_snapshot_complete(&self) -> bool {
        self.snapshot_complete
    }

    /// Resolve a repository-relative input while rejecting escapes, symlinks and
    /// hardlinks. The returned path is canonical only when it already exists.
    pub fn resolve_input(&self, path: &RepoRelativePath) -> Result<PathBuf, FoundationError> {
        let candidate = self.repository_root.join(path.as_path());
        validate_existing_path_chain(&self.repository_root, path.as_path())?;
        let resolved = if candidate.exists() {
            fs::canonicalize(&candidate).map_err(|source| FoundationError::Io {
                operation: "canonicalize repository input",
                source,
            })?
        } else {
            candidate.clone()
        };
        if !resolved.starts_with(&self.repository_root) {
            return Err(FoundationError::boundary(format!(
                "repository input `{}` escapes the canonical repository root",
                path.as_str()
            )));
        }
        if candidate.exists() {
            let metadata =
                fs::symlink_metadata(&candidate).map_err(|source| FoundationError::Io {
                    operation: "inspect repository input",
                    source,
                })?;
            if metadata.file_type().is_symlink() {
                return Err(FoundationError::boundary(format!(
                    "repository input `{}` is a symlink",
                    path.as_str()
                )));
            }
            if metadata.is_file() && hard_link_count(&metadata) != 1 {
                return Err(FoundationError::boundary(format!(
                    "repository input `{}` is a hardlink",
                    path.as_str()
                )));
            }
        }
        Ok(resolved)
    }

    /// Return whether a candidate is protected input or a visualization path.
    pub fn path_disposition(&self, path: &RepoRelativePath) -> PathDisposition {
        if is_artifact_subtree(path.as_str()) {
            PathDisposition::ProtectedArtifact
        } else if is_visualization_path(path.as_str()) {
            PathDisposition::Visualization
        } else {
            PathDisposition::Candidate
        }
    }

    /// This method intentionally fails until `AuditSession::start` has captured
    /// the complete baseline and protected-artifact metadata.
    pub fn open_report(&self, output: ReportOutput) -> Result<ReportWriter, FoundationError> {
        if !self.snapshot_complete || self.protected_at_start.is_none() {
            return Err(FoundationError::boundary(
                "a start snapshot must complete before any output is opened",
            ));
        }
        self.open_report_after_snapshot(output)
    }

    fn open_report_after_snapshot(
        &self,
        output: ReportOutput,
    ) -> Result<ReportWriter, FoundationError> {
        validate_existing_directory_chain(&self.repository_root, ARTIFACT_DIRECTORY)?;
        ensure_artifact_directory(&self.repository_root, ARTIFACT_DIRECTORY)?;
        validate_existing_directory_chain(&self.repository_root, ARTIFACT_DIRECTORY)?;

        if let Some(start) = &self.protected_at_start {
            let current = protected_path_snapshot(&self.repository_root)?;
            if let (
                Availability::Present(start_metadata),
                Availability::Present(current_metadata),
            ) = (&start.metadata, &current.metadata)
            {
                if !start_metadata.same_identity(current_metadata) {
                    return Err(FoundationError::boundary(
                        "the protected artifact directory was replaced after the start snapshot",
                    ));
                }
            }
        }

        let path = self.artifact_directory.join(output.filename());
        if is_visualization_path(output.filename()) {
            return Err(FoundationError::boundary(
                "visualization outputs are denylisted",
            ));
        }
        validate_output_path(&self.artifact_directory, &path)?;

        let mut options = OpenOptions::new();
        options.create(true).write(true);
        #[cfg(target_os = "linux")]
        options.custom_flags(0o400000); // O_NOFOLLOW
        let file = options.open(&path).map_err(|source| FoundationError::Io {
            operation: "open report output",
            source,
        })?;
        let metadata = file.metadata().map_err(|source| FoundationError::Io {
            operation: "inspect opened report output",
            source,
        })?;
        if !metadata.is_file() {
            return Err(FoundationError::boundary(
                "report output is not a regular file",
            ));
        }
        if hard_link_count(&metadata) != 1 {
            return Err(FoundationError::boundary("report output is a hardlink"));
        }
        file.set_len(0).map_err(|source| FoundationError::Io {
            operation: "truncate report output",
            source,
        })?;
        Ok(ReportWriter {
            output,
            path,
            file,
            bytes_written: 0,
        })
    }
}

/// An audit session owns the completed start snapshot and the only write gate.
pub struct AuditSession {
    boundary: AuditBoundary,
    snapshot: StartSnapshot,
}

impl AuditSession {
    pub fn start(repository_root: impl AsRef<Path>) -> Result<Self, FoundationError> {
        let mut boundary = AuditBoundary::new(repository_root)?;
        let snapshot = capture_snapshot_for_boundary(&boundary)?;
        boundary.snapshot_complete = true;
        boundary.protected_at_start = Some(snapshot.protected_artifact.clone());
        Ok(Self { boundary, snapshot })
    }

    pub fn boundary(&self) -> &AuditBoundary {
        &self.boundary
    }

    pub fn snapshot(&self) -> &StartSnapshot {
        &self.snapshot
    }

    pub fn open_report(&self, output: ReportOutput) -> Result<ReportWriter, FoundationError> {
        self.boundary.open_report(output)
    }

    pub fn compare_completion(&self) -> CompletionComparison {
        let checked_at_utc = match UtcSeconds::now() {
            Ok(value) => value,
            Err(_) => UtcSeconds(self.snapshot.captured_at_utc.get()),
        };
        let current_filesystem = capture_filesystem_snapshot(self.boundary.repository_root());
        let current_identity = capture_worktree_identity(self.boundary.repository_root());

        let current_fingerprint = match &current_identity {
            Ok(identity) => Availability::Present(identity.git_fingerprint.clone()),
            Err(_) => Availability::Unavailable,
        };
        let current_filesystem_fingerprint = match &current_filesystem {
            Ok(snapshot) => Availability::Present(snapshot.fingerprint.clone()),
            Err(_) => Availability::Unavailable,
        };
        let identity_matches =
            matches!(&current_identity, Ok(identity) if *identity == self.snapshot.identity);
        let filesystem_matches = matches!(
            &current_filesystem,
            Ok(snapshot) if snapshot.fingerprint == self.snapshot.filesystem.fingerprint
        );

        let status = if identity_matches && filesystem_matches {
            CompletionStatus::VerifiedNoChanges
        } else {
            CompletionStatus::Failed
        };
        let failure_reason = if status == CompletionStatus::VerifiedNoChanges {
            Availability::Empty
        } else if current_identity.is_err() {
            Availability::Present(ExactText::new(
                current_identity
                    .as_ref()
                    .err()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "Git identity could not be captured".to_owned()),
            ))
        } else if current_filesystem.is_err() {
            Availability::Present(ExactText::new(
                current_filesystem
                    .as_ref()
                    .err()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "filesystem snapshot could not be captured".to_owned()),
            ))
        } else if !identity_matches && !filesystem_matches {
            Availability::Present(ExactText::new(
                "worktree identity/Git fingerprint and outside-artifact filesystem snapshot changed",
            ))
        } else if !identity_matches {
            Availability::Present(ExactText::new(
                "worktree identity or Git fingerprint changed",
            ))
        } else {
            Availability::Present(ExactText::new(
                "outside-artifact filesystem snapshot changed",
            ))
        };

        CompletionComparison {
            checked_at_utc,
            status,
            start_fingerprint: self.snapshot.identity.git_fingerprint.clone(),
            current_fingerprint,
            start_filesystem_fingerprint: self.snapshot.filesystem.fingerprint.clone(),
            current_filesystem_fingerprint,
            failure_reason,
        }
    }

    pub fn complete(&self) -> CompletionComparison {
        self.compare_completion()
    }

    /// Publish only after the completion comparison is verified. The protected
    /// artifact path is excluded from the Git fingerprint, so writing the report
    /// itself cannot manufacture a false integrity failure.
    pub fn publish_report(
        &self,
        output: ReportOutput,
        contents: &[u8],
    ) -> Result<PublishedReport, FoundationError> {
        let completion = self.compare_completion();
        if !completion.is_verified() {
            return Err(FoundationError::integrity(
                completion
                    .failure_reason
                    .present_reason()
                    .unwrap_or("completion was not verified"),
            ));
        }
        let mut writer = self.open_report(output)?;
        writer
            .write_all(contents)
            .map_err(|source| FoundationError::Io {
                operation: "write report output",
                source,
            })?;
        writer.finish()
    }
}

trait AvailabilityTextExt {
    fn present_reason(&self) -> Option<&str>;
}

impl AvailabilityTextExt for Availability<ExactText> {
    fn present_reason(&self) -> Option<&str> {
        match self {
            Availability::Present(value) => Some(value.as_str()),
            _ => None,
        }
    }
}

/// Create a complete snapshot without opening or creating any output.
pub fn capture_start_snapshot(
    repository_root: impl AsRef<Path>,
) -> Result<StartSnapshot, FoundationError> {
    let boundary = AuditBoundary::new(repository_root)?;
    capture_snapshot_for_boundary(&boundary)
}

fn capture_snapshot_for_boundary(
    boundary: &AuditBoundary,
) -> Result<StartSnapshot, FoundationError> {
    let captured_at_utc = UtcSeconds::now()?;
    let identity = capture_worktree_identity(boundary.repository_root())?;
    let protected_artifact = protected_path_snapshot(&boundary.repository_root)?;
    let filesystem = capture_filesystem_snapshot_at(boundary.repository_root())?;
    Ok(StartSnapshot {
        captured_at_utc,
        identity,
        protected_artifact,
        filesystem,
    })
}

/// Capture all filesystem entries outside the exact research artifact subtree.
///
/// Directory traversal, metadata inspection, regular-file reads, and symlink
/// target reads are all fail-closed: an unreadable entry makes the snapshot
/// unavailable rather than silently omitting it.
pub fn capture_filesystem_snapshot(
    repository_root: impl AsRef<Path>,
) -> Result<FilesystemSnapshot, FoundationError> {
    let boundary = AuditBoundary::new(repository_root)?;
    capture_filesystem_snapshot_at(boundary.repository_root())
}

fn capture_filesystem_snapshot_at(
    repository_root: &Path,
) -> Result<FilesystemSnapshot, FoundationError> {
    let mut entries = BTreeMap::new();
    let mut directories = vec![repository_root.to_path_buf()];

    while let Some(directory) = directories.pop() {
        let children = fs::read_dir(&directory).map_err(|source| FoundationError::Io {
            operation: "read repository filesystem snapshot directory",
            source,
        })?;
        for child in children {
            let child = child.map_err(|source| FoundationError::Io {
                operation: "enumerate repository filesystem snapshot directory",
                source,
            })?;
            let path = child.path();
            let relative = relative_repository_path(repository_root, &path)?;
            if is_artifact_subtree(relative.as_str()) {
                continue;
            }

            let metadata = fs::symlink_metadata(&path).map_err(|source| FoundationError::Io {
                operation: "inspect repository filesystem snapshot entry",
                source,
            })?;
            let snapshot = filesystem_entry_snapshot(relative.clone(), &path, &metadata)?;
            let is_directory = snapshot.entry_type == FilesystemEntryType::Directory;
            entries.insert(relative, snapshot);
            if is_directory {
                directories.push(path);
            }
        }
    }

    FilesystemSnapshot::from_entries(entries)
}

fn filesystem_entry_snapshot(
    relative: RepoRelativePath,
    path: &Path,
    metadata: &Metadata,
) -> Result<FilesystemEntrySnapshot, FoundationError> {
    let entry_type = FilesystemEntryType::from_metadata(metadata);
    let content_fingerprint = if entry_type == FilesystemEntryType::RegularFile {
        let contents = fs::read(path).map_err(|source| FoundationError::Io {
            operation: "read repository filesystem snapshot file",
            source,
        })?;
        Availability::Present(Fingerprint::from_bytes(&contents))
    } else {
        Availability::Empty
    };
    let symlink_target = if entry_type == FilesystemEntryType::Symlink {
        let target = fs::read_link(path).map_err(|source| FoundationError::Io {
            operation: "read repository filesystem snapshot symlink target",
            source,
        })?;
        let target = target.to_str().ok_or_else(|| {
            FoundationError::boundary(format!(
                "filesystem snapshot symlink target for `{}` is not valid UTF-8",
                relative.as_str()
            ))
        })?;
        Availability::Present(ExactText::new(target.to_owned()))
    } else {
        Availability::Empty
    };

    Ok(FilesystemEntrySnapshot {
        path: relative,
        entry_type,
        metadata: FilesystemMetadata::from_metadata(metadata),
        content_fingerprint,
        symlink_target,
    })
}

fn relative_repository_path(
    repository_root: &Path,
    path: &Path,
) -> Result<RepoRelativePath, FoundationError> {
    let relative = path.strip_prefix(repository_root).map_err(|_| {
        FoundationError::boundary(format!(
            "filesystem snapshot path `{}` escapes the repository root",
            path.display()
        ))
    })?;
    let mut components = Vec::new();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(FoundationError::boundary(
                "filesystem snapshot path contains a non-normal component",
            ));
        };
        let component = component.to_str().ok_or_else(|| {
            FoundationError::boundary("filesystem snapshot path is not valid UTF-8")
        })?;
        components.push(component);
    }
    RepoRelativePath::new(components.join("/"))
}

fn is_artifact_subtree(path: &str) -> bool {
    path == ARTIFACT_DIRECTORY || path.starts_with(&format!("{ARTIFACT_DIRECTORY}/"))
}

/// Capture one independent worktree inventory.
pub fn capture_worktree_inventory(
    repository_root: impl AsRef<Path>,
) -> Result<WorktreeInventory, FoundationError> {
    let root = canonical_repository_root(repository_root.as_ref())?;
    let identity = capture_worktree_identity(&root)?;
    let tracked_bytes = git_bytes(&root, &["ls-files", "-z"])?;
    let mut tracked = Vec::new();
    for path in split_nul_paths(&tracked_bytes) {
        tracked.push(RepoRelativePath::new(path)?);
    }
    tracked.sort();
    tracked.dedup();

    let status_bytes = git_bytes(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut entries = Vec::new();
    for record in status_bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        if record.len() < 4 {
            return Err(FoundationError::Git {
                args: "status --porcelain=v1 -z".to_owned(),
                message: "malformed status record".to_owned(),
            });
        }
        let status = &record[..2];
        let path_bytes = &record[3..];
        let path = String::from_utf8_lossy(path_bytes).into_owned();
        let path = path
            .split_once(" -> ")
            .map(|(_, new)| new.to_owned())
            .unwrap_or(path);
        let path = RepoRelativePath::new(path)?;
        let state = inventory_state(status);
        entries.push(InventoryEntry { path, state });
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    entries.dedup_by(|left, right| left.path == right.path);

    Ok(WorktreeInventory {
        identity,
        tracked,
        entries,
    })
}

fn inventory_state(status: &[u8]) -> InventoryState {
    let x = status.first().copied().unwrap_or(b' ');
    let y = status.get(1).copied().unwrap_or(b' ');
    match (x, y) {
        (b'?', b'?') => InventoryState::Untracked,
        (b'A', _) | (_, b'A') => InventoryState::Added,
        (b'D', _) | (_, b'D') => InventoryState::Deleted,
        (b'R', _) | (_, b'R') => InventoryState::Renamed,
        (b' ', b' ') => InventoryState::Tracked,
        _ => InventoryState::Modified,
    }
}

/// Capture just the independent identity/fingerprint portion.
pub fn capture_worktree_identity(
    repository_root: impl AsRef<Path>,
) -> Result<WorktreeIdentity, FoundationError> {
    let root = canonical_repository_root(repository_root.as_ref())?;
    let head_text = git_text(&root, &["rev-parse", "HEAD"])?;
    let head = FullId::new(head_text.trim().to_owned())?;
    let checkout = match git_optional_text(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?
    {
        Some(branch) => CheckoutState::branch(branch.trim().to_owned())?,
        None => CheckoutState::Detached,
    };
    let remote_fingerprints = capture_remote_fingerprints(&root)?;
    let git_fingerprint = capture_git_fingerprint(&root)?;
    Ok(WorktreeIdentity {
        repository_root: AbsolutePath::from_path(&root)?,
        checkout,
        head,
        git_fingerprint,
        remote_fingerprints,
    })
}

fn capture_remote_fingerprints(
    root: &Path,
) -> Result<Availability<BTreeMap<ExactText, Fingerprint>>, FoundationError> {
    let output = git_output(root, &["config", "--get-regexp", r"^remote\..*\.url$"])?;
    if !output.status.success() {
        if output.status.code() == Some(1) {
            return Ok(Availability::Empty);
        }
        return Err(git_failure(
            &["config", "--get-regexp", r"^remote\..*\.url$"],
            &output,
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut fingerprints = BTreeMap::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let Some((key, url)) = line.split_once('\t').or_else(|| line.split_once(' ')) else {
            return Err(FoundationError::Git {
                args: "config --get-regexp ^remote..*.url".to_owned(),
                message: "malformed remote configuration record".to_owned(),
            });
        };
        let Some(name) = key
            .strip_prefix("remote.")
            .and_then(|key| key.strip_suffix(".url"))
        else {
            continue;
        };
        fingerprints.insert(
            ExactText::new(name.to_owned()),
            Fingerprint::from_bytes(url.as_bytes()),
        );
    }
    if fingerprints.is_empty() {
        Ok(Availability::Empty)
    } else {
        Ok(Availability::Present(fingerprints))
    }
}

fn capture_git_fingerprint(root: &Path) -> Result<Fingerprint, FoundationError> {
    let mut material = Vec::new();
    material.extend_from_slice(git_bytes(root, &["rev-parse", "HEAD"])?.as_slice());
    material.push(0);
    material.extend_from_slice(
        git_bytes(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .unwrap_or_default()
            .as_slice(),
    );
    material.push(0);
    let status = git_bytes(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    material.extend_from_slice(&filter_artifact_status(&status));
    material.push(0);
    let diff = git_bytes(
        root,
        &[
            "diff",
            "--binary",
            "--no-ext-diff",
            "--",
            ".",
            ":(exclude).kiro/specs/release-checkpoint-research/**",
        ],
    )?;
    material.extend_from_slice(&diff);
    material.push(0);
    let cached = git_bytes(
        root,
        &[
            "diff",
            "--cached",
            "--binary",
            "--no-ext-diff",
            "--",
            ".",
            ":(exclude).kiro/specs/release-checkpoint-research/**",
        ],
    )?;
    material.extend_from_slice(&cached);
    material.push(0);
    let index = git_bytes(root, &["ls-files", "--stage", "-z"])?;
    material.extend_from_slice(&filter_artifact_status(&index));
    Ok(Fingerprint::from_bytes(&material))
}

fn filter_artifact_status(bytes: &[u8]) -> Vec<u8> {
    let prefix = format!("{ARTIFACT_DIRECTORY}/");
    bytes
        .split(|byte| *byte == 0)
        .filter(|record| {
            let path = if record.len() >= 3 && record[2] == b' ' {
                &record[3..]
            } else if let Some(tab) = record.iter().position(|byte| *byte == b'\t') {
                &record[tab + 1..]
            } else {
                *record
            };
            let text = String::from_utf8_lossy(path);
            !(text == ARTIFACT_DIRECTORY || text.starts_with(&prefix))
        })
        .flat_map(|record| record.iter().copied().chain(std::iter::once(0)))
        .collect()
}

fn git_optional_text(root: &Path, args: &[&str]) -> Result<Option<String>, FoundationError> {
    let output = git_output(root, args)?;
    if output.status.success() {
        return Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()));
    }
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    Err(git_failure(args, &output))
}

fn git_text(root: &Path, args: &[&str]) -> Result<String, FoundationError> {
    let output = git_output(root, args)?;
    if !output.status.success() {
        return Err(git_failure(args, &output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn git_bytes(root: &Path, args: &[&str]) -> Result<Vec<u8>, FoundationError> {
    let output = git_output(root, args)?;
    if !output.status.success() {
        return Err(git_failure(args, &output));
    }
    Ok(output.stdout)
}

fn git_output(root: &Path, args: &[&str]) -> Result<std::process::Output, FoundationError> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|source| FoundationError::Io {
            operation: "run git",
            source,
        })
}

fn git_failure(args: &[&str], output: &std::process::Output) -> FoundationError {
    FoundationError::Git {
        args: args.join(" "),
        message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
    }
}

fn split_nul_paths(bytes: &[u8]) -> impl Iterator<Item = String> + '_ {
    bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(|record| String::from_utf8_lossy(record).into_owned())
}

fn canonical_repository_root(path: &Path) -> Result<PathBuf, FoundationError> {
    if !path.is_absolute() {
        return Err(FoundationError::boundary(
            "the repository root must be supplied as an absolute path",
        ));
    }
    let metadata = fs::symlink_metadata(path).map_err(|source| FoundationError::Io {
        operation: "inspect repository root",
        source,
    })?;
    if metadata.file_type().is_symlink() {
        return Err(FoundationError::boundary(
            "the repository root may not itself be a symlink",
        ));
    }
    if !metadata.is_dir() {
        return Err(FoundationError::boundary(
            "the repository root must be a directory",
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|source| FoundationError::Io {
        operation: "canonicalize repository root",
        source,
    })?;
    if !canonical.is_absolute() {
        return Err(FoundationError::boundary(
            "canonical repository root is not absolute",
        ));
    }
    Ok(canonical)
}

fn validate_existing_directory_chain(root: &Path, relative: &str) -> Result<(), FoundationError> {
    let mut current = root.to_path_buf();
    for component in relative.split('/') {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(FoundationError::boundary(format!(
                        "protected path component `{}` is a symlink",
                        current.display()
                    )));
                }
                if !metadata.is_dir() {
                    return Err(FoundationError::boundary(format!(
                        "protected path component `{}` is not a directory",
                        current.display()
                    )));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(source) => {
                return Err(FoundationError::Io {
                    operation: "inspect protected path component",
                    source,
                })
            }
        }
    }
    Ok(())
}

fn ensure_artifact_directory(root: &Path, relative: &str) -> Result<(), FoundationError> {
    let mut current = root.to_path_buf();
    for component in relative.split('/') {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(FoundationError::boundary(format!(
                        "cannot use unsafe artifact component `{}`",
                        current.display()
                    )));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|source| FoundationError::Io {
                    operation: "create artifact directory",
                    source,
                })?;
                let metadata =
                    fs::symlink_metadata(&current).map_err(|source| FoundationError::Io {
                        operation: "inspect created artifact directory",
                        source,
                    })?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(FoundationError::boundary(
                        "created artifact component is not a directory",
                    ));
                }
            }
            Err(source) => {
                return Err(FoundationError::Io {
                    operation: "inspect artifact directory",
                    source,
                })
            }
        }
    }
    Ok(())
}

fn protected_path_snapshot(root: &Path) -> Result<ProtectedPathSnapshot, FoundationError> {
    validate_existing_directory_chain(root, ARTIFACT_DIRECTORY)?;
    let artifact = root.join(ARTIFACT_DIRECTORY);
    let metadata = match fs::symlink_metadata(&artifact) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(FoundationError::boundary(
                    "the protected artifact directory is a symlink",
                ));
            }
            if !metadata.is_dir() {
                return Err(FoundationError::boundary(
                    "the protected artifact path is not a directory",
                ));
            }
            Availability::Present(FilesystemMetadata::from_metadata(&metadata))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Availability::Empty,
        Err(source) => {
            return Err(FoundationError::Io {
                operation: "inspect protected artifact directory",
                source,
            })
        }
    };
    Ok(ProtectedPathSnapshot {
        path: RepoRelativePath::new(ARTIFACT_DIRECTORY.to_owned())?,
        metadata,
    })
}

fn validate_existing_path_chain(root: &Path, relative: &Path) -> Result<(), FoundationError> {
    let mut current = root.to_path_buf();
    let components = relative.components();
    for component in components {
        let Component::Normal(component) = component else {
            return Err(FoundationError::boundary(
                "repository input contains a non-normal path component",
            ));
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(FoundationError::boundary(format!(
                        "repository input component `{}` is a symlink",
                        current.display()
                    )));
                }
                if metadata.is_file() && hard_link_count(&metadata) != 1 {
                    return Err(FoundationError::boundary(format!(
                        "repository input component `{}` is a hardlink",
                        current.display()
                    )));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(source) => {
                return Err(FoundationError::Io {
                    operation: "inspect repository input component",
                    source,
                })
            }
        }
    }
    Ok(())
}

fn validate_output_path(artifact: &Path, path: &Path) -> Result<(), FoundationError> {
    if path.parent() != Some(artifact) {
        return Err(FoundationError::boundary(
            "report output must be a direct child of the artifact directory",
        ));
    }
    let filename = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| FoundationError::boundary("report output has no valid filename"))?;
    ReportOutput::parse(filename)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(FoundationError::boundary(
                    "report output may not be a symlink",
                ));
            }
            if !metadata.is_file() {
                return Err(FoundationError::boundary(
                    "report output may only replace a regular file",
                ));
            }
            if hard_link_count(&metadata) != 1 {
                return Err(FoundationError::boundary(
                    "report output may not be a hardlink",
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(FoundationError::Io {
                operation: "inspect report output",
                source,
            })
        }
    }
    Ok(())
}

fn hard_link_count(metadata: &Metadata) -> u64 {
    #[cfg(unix)]
    {
        metadata.nlink()
    }
    #[cfg(not(unix))]
    {
        1
    }
}

/// Return whether a source, evidence locator, or path refers to the approved
/// visualization host/path. File extensions are deliberately not denylist rules:
/// ordinary HTML, SVG, image, and Markdown artifacts remain inspectable.
pub fn is_visualization_path(path: &str) -> bool {
    let normalized = path
        .trim()
        .to_ascii_lowercase()
        .replace('\\', "/")
        .replace("%3a", ":")
        .replace("%2f", "/");
    let normalized = normalized
        .strip_prefix("https://")
        .or_else(|| normalized.strip_prefix("http://"))
        .or_else(|| normalized.strip_prefix("//"))
        .unwrap_or(&normalized);
    let normalized = normalized.strip_prefix("www.").unwrap_or(normalized);
    let path_without_query = normalized
        .split_once(['?', '#'])
        .map(|(value, _)| value)
        .unwrap_or(normalized);
    let path_without_query = path_without_query.trim_end_matches('/');

    if path_without_query == "masihmoafi.com/projects/elpis"
        || path_without_query.starts_with("masihmoafi.com/projects/elpis/")
    {
        return true;
    }

    // Source/evidence identifiers commonly derive from the URL by replacing
    // punctuation with separators or removing it altogether. Require token
    // boundaries so a different path such as `elpisian` is not denylisted.
    [
        "masihmoafi.com/projects/elpis",
        "masihmoafi.com_projects_elpis",
        "masihmoafi.com-projects-elpis",
        "masihmoafi_com_projects_elpis",
        "masihmoafi_com-projects-elpis",
        "masihmoafi_projects_elpis",
        "masihmoafi-projects-elpis",
        "masihmoaficomprojectselpis",
    ]
    .iter()
    .any(|token| contains_delimited_token(&normalized, token))
}

fn contains_delimited_token(value: &str, token: &str) -> bool {
    let mut search_from = 0;
    while let Some(relative_start) = value[search_from..].find(token) {
        let start = search_from + relative_start;
        let end = start + token.len();
        let before_is_boundary = value[..start]
            .chars()
            .next_back()
            .map(|character| !character.is_ascii_alphanumeric())
            .unwrap_or(true);
        let after_is_boundary = value[end..]
            .chars()
            .next()
            .map(|character| !character.is_ascii_alphanumeric())
            .unwrap_or(true);
        if before_is_boundary && after_is_boundary {
            return true;
        }
        search_from = end;
    }
    false
}

/// A coarse disposition used by candidate cleanup/report stages.
#[derive(Debug, Copy, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PathDisposition {
    Candidate,
    ProtectedArtifact,
    Visualization,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_id_and_path_validation_are_fail_closed() {
        assert!(FullId::new("a".repeat(40)).is_ok());
        assert!(FullId::new("a".repeat(39)).is_err());
        assert!(RepoRelativePath::new("src/lib.rs").is_ok());
        assert!(RepoRelativePath::new("../outside").is_err());
        assert!(InclusiveSpan::new(2, 2).is_ok());
        assert!(InclusiveSpan::new(3, 2).is_err());
    }

    #[test]
    fn serialization_is_stable() {
        let first = serialize_deterministically(&Availability::Present(BTreeMap::from([
            (ExactText::new("b"), ExactText::new("two")),
            (ExactText::new("a"), ExactText::new("one")),
        ])))
        .expect("serialize");
        let second = serialize_deterministically(&Availability::Present(BTreeMap::from([
            (ExactText::new("a"), ExactText::new("one")),
            (ExactText::new("b"), ExactText::new("two")),
        ])))
        .expect("serialize");
        assert_eq!(first, second);
    }
}
