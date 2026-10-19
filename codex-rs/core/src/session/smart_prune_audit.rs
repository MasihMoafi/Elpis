//! Elpis: durable, admission-time evidence for Smart Prune. Copied from v0.3.0.
//!
//! A compact body is not allowed into conversation history until redacted copies of
//! the post-hook source and the proposed admitted envelope have been published
//! together through one atomic directory rename.

use std::fs::File;
use std::io::BufWriter;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::TokenUsage;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use tempfile::Builder;

use crate::log_redaction::redact_secrets;

const AUDIT_SCHEMA_VERSION: u32 = 1;
const REQUEST_INPUT_REPRESENTATION: &str = "logical_response_items_before_transport";

#[derive(Debug, Clone)]
pub(super) struct AdmissionAuditItem {
    pub(super) call_id: String,
    pub(super) decision: &'static str,
    pub(super) source_sha256: String,
    pub(super) source: ResponseItem,
    pub(super) admitted: ResponseItem,
    pub(super) source_tokens: usize,
    pub(super) admitted_tokens: usize,
    pub(super) saved_tokens: usize,
}

pub(super) struct AdmissionAuditInput<'a> {
    pub(super) admission_id: &'a str,
    pub(super) session_id: &'a str,
    pub(super) turn_id: &'a str,
    pub(super) model_slug: &'a str,
    pub(super) ace_instructions: &'a str,
    pub(super) ace_input: &'a str,
    pub(super) raw_response: &'a str,
    pub(super) usage: Option<&'a TokenUsage>,
    pub(super) items: &'a [AdmissionAuditItem],
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AttemptStatus {
    Admitted,
    Unchanged,
    TimedOut,
    ModelError,
    MalformedResponse,
    SourceError,
    AuditError,
    Cancelled,
}

impl AttemptStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Admitted => "admitted",
            Self::Unchanged => "unchanged",
            Self::TimedOut => "timed_out",
            Self::ModelError => "model_error",
            Self::MalformedResponse => "malformed_response",
            Self::SourceError => "source_error",
            Self::AuditError => "audit_error",
            Self::Cancelled => "cancelled",
        }
    }
}

pub(super) struct AttemptAuditInput<'a> {
    pub(super) attempt_id: &'a str,
    pub(super) session_id: &'a str,
    pub(super) thread_id: Option<&'a str>,
    pub(super) chat_title: Option<&'a str>,
    pub(super) turn_id: &'a str,
    pub(super) turn_number: Option<usize>,
    pub(super) status: AttemptStatus,
    pub(super) model_slug: &'a str,
    pub(super) reasoning_effort: &'a str,
    pub(super) instructions: &'a str,
    pub(super) input: &'a str,
    pub(super) raw_response: Option<&'a str>,
    pub(super) error: Option<&'a str>,
    pub(super) candidate_outputs: usize,
    pub(super) admitted_outputs: usize,
    pub(super) saved_tokens: usize,
    pub(super) latency_ms: u64,
    pub(super) usage: Option<&'a TokenUsage>,
    pub(super) admission_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AttemptAuditReceipt {
    pub(super) audit_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AdmissionAuditReceipt {
    pub(super) admission_id: String,
    pub(super) admission_dir: PathBuf,
}

#[derive(Serialize)]
struct AceConversation<'a> {
    model: &'a str,
    instructions: &'a str,
    input: &'a str,
    raw_response: &'a str,
    usage: Option<&'a TokenUsage>,
}

#[derive(Serialize)]
struct AdmissionManifest<'a> {
    schema_version: u32,
    admission_id: &'a str,
    session_id: &'a str,
    turn_id: &'a str,
    timestamp: String,
    model: &'a str,
    ace_conversation: &'static str,
    source_tokens: usize,
    admitted_tokens: usize,
    saved_tokens: usize,
    items: Vec<ManifestItem<'a>>,
}

#[derive(Serialize)]
struct ManifestItem<'a> {
    call_id: &'a str,
    decision: &'a str,
    source_sha256: &'a str,
    source_artifact: String,
    admitted_artifact: String,
    source_tokens: usize,
    admitted_tokens: usize,
    saved_tokens: usize,
}

#[derive(Serialize)]
struct RequestLinkage<'a> {
    schema_version: u32,
    admission_id: &'a str,
    timestamp: String,
    request_sequence: u64,
    input_representation: &'static str,
    request_input_sha256: &'a str,
}

#[derive(Serialize)]
struct ResponseLinkage<'a> {
    schema_version: u32,
    admission_id: &'a str,
    timestamp: String,
    response_id: &'a str,
    usage: Option<&'a TokenUsage>,
}

#[derive(Serialize)]
struct AttemptRecord<'a> {
    schema_version: u32,
    attempt_id: &'a str,
    session_id: &'a str,
    thread_id: Option<&'a str>,
    chat_title: Option<&'a str>,
    turn_id: &'a str,
    turn_number: Option<usize>,
    timestamp: String,
    status: AttemptStatus,
    model: &'a str,
    reasoning_effort: &'a str,
    instructions: &'a str,
    input: &'a str,
    raw_response: Option<&'a str>,
    error: Option<&'a str>,
    candidate_outputs: usize,
    admitted_outputs: usize,
    saved_tokens: usize,
    latency_ms: u64,
    usage: Option<&'a TokenUsage>,
    admission_id: Option<&'a str>,
}

pub(super) fn response_item_sha256(item: &ResponseItem) -> Result<String> {
    let bytes = serde_json::to_vec(item).context("failed to serialize Smart Prune source")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn write_attempt(
    log_dir: &Path,
    input: AttemptAuditInput<'_>,
) -> Result<AttemptAuditReceipt> {
    let mut id_components = Path::new(input.attempt_id).components();
    anyhow::ensure!(
        matches!(id_components.next(), Some(Component::Normal(_)))
            && id_components.next().is_none(),
        "invalid Smart Prune attempt id"
    );
    std::fs::create_dir_all(log_dir).with_context(|| {
        format!(
            "failed to create Smart Prune audit directory under {}",
            log_dir.display()
        )
    })?;
    let smart_prune_dir = log_dir.join("smart-prune");
    ensure_private_directory(&smart_prune_dir)?;
    let attempts_dir = smart_prune_dir.join("attempts");
    ensure_private_directory(&attempts_dir)?;
    sync_directory(log_dir)?;
    sync_directory(&smart_prune_dir)?;
    let relative_path = Path::new("smart-prune")
        .join("attempts")
        .join(format!("{}.json", input.attempt_id));
    let final_path = log_dir.join(&relative_path);
    write_json_new(
        &final_path,
        &AttemptRecord {
            schema_version: AUDIT_SCHEMA_VERSION,
            attempt_id: input.attempt_id,
            session_id: input.session_id,
            thread_id: input.thread_id,
            chat_title: input.chat_title,
            turn_id: input.turn_id,
            turn_number: input.turn_number,
            timestamp: chrono::Utc::now().to_rfc3339(),
            status: input.status,
            model: input.model_slug,
            reasoning_effort: input.reasoning_effort,
            instructions: input.instructions,
            input: input.input,
            raw_response: input.raw_response,
            error: input.error,
            candidate_outputs: input.candidate_outputs,
            admitted_outputs: input.admitted_outputs,
            saved_tokens: input.saved_tokens,
            latency_ms: input.latency_ms,
            usage: input.usage,
            admission_id: input.admission_id,
        },
    )?;
    // The machine audit remains authoritative even if its readable projection cannot
    // be appended (for example, a pre-existing log path is not writable).
    if let Err(error) = append_readable_attempt(log_dir, input.attempt_id) {
        tracing::warn!(
            attempt_id = input.attempt_id,
            "Smart Prune readable log could not be appended: {}",
            redact_secrets(&format!("{error:#}"))
        );
    }
    Ok(AttemptAuditReceipt {
        audit_path: relative_path,
    })
}

fn append_readable_attempt(log_dir: &Path, attempt_id: &str) -> Result<()> {
    let record = crate::smart_prune_log::read_attempt(log_dir, attempt_id)?;
    let directory = log_dir.join("smart-prune");
    // Serialize filename selection too: chat renames and concurrent first attempts
    // must continue appending to a single Markdown record for this thread.
    let lock = open_private_append(&directory.join(".readable.lock"))?;
    lock.lock()?;
    let path = readable_chat_path(&directory, &record)?;
    let mut file = open_private_append(&path)?;
    file.write_all(redact_secrets(&record.readable()).as_bytes())?;
    file.sync_all()?;
    sync_directory(&directory)?;
    Ok(())
}

fn readable_chat_path(
    directory: &Path,
    record: &crate::smart_prune_log::PruneLogRecord,
) -> Result<PathBuf> {
    anyhow::ensure!(
        !record.thread_id.is_empty()
            && record
                .thread_id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_')),
        "invalid readable log thread id"
    );
    let suffix = format!(" {}.md", record.thread_id);
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().ends_with(&suffix) {
            return Ok(entry.path());
        }
    }
    let title: String = record
        .chat_title
        .chars()
        .take(40)
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
            {
                '_'
            } else {
                ch
            }
        })
        .collect();
    Ok(directory.join(format!(
        "{} {}{suffix}",
        &record.timestamp[..10],
        title.trim()
    )))
}

fn open_private_append(path: &Path) -> Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    anyhow::ensure!(
        file.metadata()?.is_file(),
        "readable log is not a regular file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        anyhow::ensure!(
            file.metadata()?.nlink() == 1,
            "readable log has multiple links"
        );
    }
    set_private_file_permissions(&file)?;
    Ok(file)
}

pub(super) fn write_admission(
    log_dir: &Path,
    input: AdmissionAuditInput<'_>,
) -> Result<AdmissionAuditReceipt> {
    anyhow::ensure!(
        !input.items.is_empty(),
        "Smart Prune admission has no items"
    );
    let admission_path = validated_admission_path(input.admission_id)?;
    std::fs::create_dir_all(log_dir).with_context(|| {
        format!(
            "failed to create Smart Prune audit directory under {}",
            log_dir.display()
        )
    })?;
    let smart_prune_dir = log_dir.join("smart-prune");
    ensure_private_directory(&smart_prune_dir).with_context(|| {
        format!(
            "failed to create Smart Prune audit directory {}",
            smart_prune_dir.display()
        )
    })?;
    let admissions_dir = smart_prune_dir.join("admissions");
    ensure_private_directory(&admissions_dir).with_context(|| {
        format!(
            "failed to create Smart Prune audit directory {}",
            admissions_dir.display()
        )
    })?;
    sync_directory(log_dir)?;
    sync_directory(&smart_prune_dir)?;
    let final_dir = log_dir.join(admission_path);
    anyhow::ensure!(
        !final_dir.exists(),
        "Smart Prune admission already exists: {}",
        final_dir.display()
    );

    let staging = Builder::new()
        .prefix(".pending-")
        .tempdir_in(&admissions_dir)
        .with_context(|| {
            format!(
                "failed to stage Smart Prune admission {}",
                input.admission_id
            )
        })?;
    let staging_dir = staging.path();
    set_private_directory_permissions(staging_dir)?;
    write_json_new(
        &staging_dir.join("ace.json"),
        &AceConversation {
            model: input.model_slug,
            instructions: input.ace_instructions,
            input: input.ace_input,
            raw_response: input.raw_response,
            usage: input.usage,
        },
    )?;

    let items_dir = staging_dir.join("items");
    ensure_private_directory(&items_dir)?;
    let mut manifest_items = Vec::with_capacity(input.items.len());
    for (index, item) in input.items.iter().enumerate() {
        anyhow::ensure!(
            response_item_sha256(&item.source)? == item.source_sha256,
            "Smart Prune source hash changed before audit publication"
        );
        let source_name = source_artifact_name(index, &item.call_id);
        let admitted_name = format!(
            "{index:03}-{}-admitted.json",
            safe_filename_component(&item.call_id)
        );
        write_json_new(&items_dir.join(&source_name), &item.source)?;
        write_json_new(&items_dir.join(&admitted_name), &item.admitted)?;
        manifest_items.push(ManifestItem {
            call_id: &item.call_id,
            decision: item.decision,
            source_sha256: &item.source_sha256,
            source_artifact: format!("items/{source_name}"),
            admitted_artifact: format!("items/{admitted_name}"),
            source_tokens: item.source_tokens,
            admitted_tokens: item.admitted_tokens,
            saved_tokens: item.saved_tokens,
        });
    }

    write_json_new(
        &staging_dir.join("manifest.json"),
        &AdmissionManifest {
            schema_version: AUDIT_SCHEMA_VERSION,
            admission_id: input.admission_id,
            session_id: input.session_id,
            turn_id: input.turn_id,
            timestamp: chrono::Utc::now().to_rfc3339(),
            model: input.model_slug,
            ace_conversation: "ace.json",
            source_tokens: input.items.iter().map(|item| item.source_tokens).sum(),
            admitted_tokens: input.items.iter().map(|item| item.admitted_tokens).sum(),
            saved_tokens: input.items.iter().map(|item| item.saved_tokens).sum(),
            items: manifest_items,
        },
    )?;

    sync_directory(&items_dir)?;
    sync_directory(staging_dir)?;
    publish_staging_directory(staging, &final_dir, &admissions_dir)?;

    Ok(AdmissionAuditReceipt {
        admission_id: input.admission_id.to_string(),
        admission_dir: final_dir,
    })
}

fn publish_staging_directory(
    staging: tempfile::TempDir,
    final_dir: &Path,
    parent: &Path,
) -> Result<()> {
    let staging_path = staging.path().to_path_buf();
    std::fs::rename(&staging_path, final_dir).with_context(|| {
        format!(
            "failed to publish Smart Prune audit {} to {}",
            staging_path.display(),
            final_dir.display()
        )
    })?;
    sync_directory(parent)?;
    Ok(())
}

fn resolve_admission_directory(
    log_dir: &Path,
    audit_path: &Path,
    admission_id: &str,
) -> Result<PathBuf> {
    let expected = validated_admission_path(admission_id)?;
    anyhow::ensure!(
        !audit_path.is_absolute() && audit_path == expected,
        "invalid Smart Prune audit path: {}",
        audit_path.display()
    );

    let canonical_log_dir = std::fs::canonicalize(log_dir).with_context(|| {
        format!(
            "failed to resolve Smart Prune log directory {}",
            log_dir.display()
        )
    })?;
    let admission_dir = log_dir.join(audit_path);
    let canonical_admission_dir = std::fs::canonicalize(&admission_dir).with_context(|| {
        format!(
            "failed to resolve Smart Prune admission directory {}",
            admission_dir.display()
        )
    })?;
    anyhow::ensure!(
        canonical_admission_dir.starts_with(&canonical_log_dir) && canonical_admission_dir.is_dir(),
        "Smart Prune admission directory escapes the log root"
    );
    Ok(canonical_admission_dir)
}

fn source_artifact_name(index: usize, call_id: &str) -> String {
    format!(
        "{index:03}-{}-source.json",
        safe_filename_component(call_id)
    )
}

/// Where `write_admission` stores the exact source of its `index`th item.
pub(super) fn source_artifact_path(
    log_dir: &Path,
    admission_id: &str,
    index: usize,
    call_id: &str,
) -> Result<PathBuf> {
    Ok(log_dir
        .join(validated_admission_path(admission_id)?)
        .join("items")
        .join(source_artifact_name(index, call_id)))
}

fn validated_admission_path(admission_id: &str) -> Result<PathBuf> {
    let mut admission_id_components = Path::new(admission_id).components();
    anyhow::ensure!(
        matches!(admission_id_components.next(), Some(Component::Normal(_)))
            && admission_id_components.next().is_none(),
        "invalid Smart Prune admission id"
    );
    Ok(Path::new("smart-prune")
        .join("admissions")
        .join(admission_id))
}

pub(super) fn write_request_linkage(
    log_dir: &Path,
    audit_path: &Path,
    admission_id: &str,
    request_sequence: u64,
    request_input_sha256: &str,
) -> Result<()> {
    let admission_dir = resolve_admission_directory(log_dir, audit_path, admission_id)?;
    write_json_new(
        &admission_dir.join("request.json"),
        &RequestLinkage {
            schema_version: AUDIT_SCHEMA_VERSION,
            admission_id,
            timestamp: chrono::Utc::now().to_rfc3339(),
            request_sequence,
            input_representation: REQUEST_INPUT_REPRESENTATION,
            request_input_sha256,
        },
    )
}

pub(super) fn write_response_linkage(
    log_dir: &Path,
    audit_path: &Path,
    admission_id: &str,
    response_id: &str,
    usage: Option<&TokenUsage>,
) -> Result<()> {
    let admission_dir = resolve_admission_directory(log_dir, audit_path, admission_id)?;
    write_json_new(
        &admission_dir.join("response.json"),
        &ResponseLinkage {
            schema_version: AUDIT_SCHEMA_VERSION,
            admission_id,
            timestamp: chrono::Utc::now().to_rfc3339(),
            response_id,
            usage,
        },
    )
}

fn write_json_new(path: &Path, value: &impl Serialize) -> Result<()> {
    // Sanitize in memory before any bytes reach even the unpublished staging file.
    // Hashes and the model's source/admitted items retain their original values.
    let serialized = redact_secrets(&serde_json::to_string_pretty(value)?);
    let parent = path
        .parent()
        .context("immutable Smart Prune audit file has no parent directory")?;
    let mut staged = Builder::new()
        .prefix(".pending-json-")
        .tempfile_in(parent)
        .with_context(|| format!("failed to stage immutable audit file {}", path.display()))?;
    set_private_file_permissions(staged.as_file())?;
    {
        let mut writer = BufWriter::new(staged.as_file_mut());
        writer.write_all(serialized.as_bytes())?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
    staged.as_file().sync_all()?;
    std::fs::hard_link(staged.path(), path)
        .with_context(|| format!("failed to create immutable audit file {}", path.display()))?;
    if let Err(err) = sync_directory(parent) {
        let _ = std::fs::remove_file(path);
        let _ = sync_directory(parent);
        return Err(err);
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    let metadata = std::fs::symlink_metadata(path)?;
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Smart Prune audit path is not a real directory: {}",
        path.display()
    );
    set_private_directory_permissions(path)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(file: &File) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_file_permissions(_file: &File) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

fn safe_filename_component(call_id: &str) -> String {
    let safe: String = call_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    if safe.is_empty() {
        "call".to_string()
    } else {
        safe
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::FunctionCallOutputPayload;

    struct SerializationFailure;

    impl Serialize for SerializationFailure {
        fn serialize<S>(&self, _serializer: S) -> std::result::Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            Err(serde::ser::Error::custom("injected serialization failure"))
        }
    }

    fn output(call_id: &str, body: &str) -> ResponseItem {
        ResponseItem::FunctionCallOutput {
            id: None,
            call_id: Some(call_id.to_string()),
            name: None,
            namespace: None,
            output: FunctionCallOutputPayload::from_text(body.to_string()),
            internal_chat_message_metadata_passthrough: None,
        }
    }

    fn audit_item(call_id: &str) -> AdmissionAuditItem {
        let source = output(call_id, &"raw sentinel\n".repeat(1_000));
        let admitted = output(call_id, "kept fact\n[ELPIS SMART PRUNE]");
        AdmissionAuditItem {
            call_id: call_id.to_string(),
            decision: "compact",
            source_sha256: response_item_sha256(&source).expect("source hash"),
            source,
            admitted,
            source_tokens: 3_000,
            admitted_tokens: 10,
            saved_tokens: 2_990,
        }
    }

    fn audit_input<'a>(
        admission_id: &'a str,
        item: &'a AdmissionAuditItem,
    ) -> AdmissionAuditInput<'a> {
        AdmissionAuditInput {
            admission_id,
            session_id: "session-1",
            turn_id: "turn-1",
            model_slug: "gpt-5.6-luna",
            ace_instructions: "instructions",
            ace_input: "input",
            raw_response: "response",
            usage: None,
            items: std::slice::from_ref(item),
        }
    }

    fn attempt_input<'a>(attempt_id: &'a str) -> AttemptAuditInput<'a> {
        AttemptAuditInput {
            attempt_id,
            session_id: "session-1",
            thread_id: Some("session-1"),
            chat_title: Some("Readable fixture"),
            turn_id: "turn-1",
            turn_number: Some(3),
            status: AttemptStatus::TimedOut,
            model_slug: "gpt-5.6-luna",
            reasoning_effort: "low",
            instructions: "instructions",
            input: "exact optimizer input",
            raw_response: None,
            error: Some("20-second optimizer deadline elapsed"),
            candidate_outputs: 2,
            admitted_outputs: 0,
            saved_tokens: 0,
            latency_ms: 20_000,
            usage: None,
            admission_id: None,
        }
    }

    fn readable_path(root: &Path) -> PathBuf {
        let record = crate::smart_prune_log::read_attempt(root, "readable-1").unwrap();
        readable_chat_path(&root.join("smart-prune"), &record).unwrap()
    }

    fn chat_markdown_path(root: &Path) -> PathBuf {
        std::fs::read_dir(root.join("smart-prune"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.extension().is_some_and(|ext| ext == "md"))
            .expect("per-chat Markdown record")
    }

    #[test]
    fn real_audit_writers_redact_secrets_without_mutating_model_items() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tools/elpis-claude/test/fixtures/log-secrets.json"
        ))
        .unwrap();
        for (index, fixture) in fixtures.as_array().unwrap().iter().enumerate() {
            let root = tempfile::tempdir().unwrap();
            let body = fixture["input"].as_str().unwrap();
            let expected = fixture["expected"].as_str().unwrap();
            let source = output("call-1", body);
            let before = serde_json::to_string(&source).unwrap();
            let item = AdmissionAuditItem {
                call_id: "call-1".to_string(),
                decision: "compact",
                source_sha256: response_item_sha256(&source).unwrap(),
                source: source.clone(),
                admitted: source,
                source_tokens: 100,
                admitted_tokens: 10,
                saved_tokens: 90,
            };
            let mut admission = audit_input("redaction", &item);
            admission.ace_instructions = body;
            admission.ace_input = body;
            admission.raw_response = body;
            let receipt = write_admission(root.path(), admission).unwrap();
            let read = |path: &Path| -> serde_json::Value {
                serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
            };
            let ace = read(&receipt.admission_dir.join("ace.json"));
            for field in ["instructions", "input", "raw_response"] {
                assert!(ace[field] == expected, "ace fixture {index}, {field}");
            }
            for name in [
                source_artifact_name(0, "call-1"),
                "000-call-1-admitted.json".into(),
            ] {
                let stored = read(&receipt.admission_dir.join("items").join(name));
                assert!(
                    stored == serde_json::to_value(output("call-1", expected)).unwrap(),
                    "item fixture {index}"
                );
            }
            let optimizer_input = serde_json::json!({"items": [{
                "call_id": "call-1", "source_tokens_estimate": 100,
                "source_output": item.source
            }]})
            .to_string();
            let mut attempt = attempt_input("redaction");
            attempt.instructions = body;
            attempt.input = &optimizer_input;
            attempt.raw_response = Some(body);
            attempt.error = Some(body);
            let attempt = write_attempt(root.path(), attempt).unwrap();
            let stored = read(&root.path().join(attempt.audit_path));
            for field in ["instructions", "raw_response", "error"] {
                assert!(
                    stored[field] == expected,
                    "attempt fixture {index}, {field}"
                );
            }
            let readable = std::fs::read_to_string(chat_markdown_path(root.path())).unwrap();
            assert!(
                redact_secrets(&readable) == readable,
                "readable fixture {index}"
            );
            assert!(
                serde_json::to_string(&item.source).unwrap() == before,
                "source unchanged {index}"
            );
            assert!(
                serde_json::to_string(&item.admitted).unwrap() == before,
                "admitted unchanged {index}"
            );
            assert_eq!(
                response_item_sha256(&item.source).unwrap(),
                item.source_sha256
            );
        }
    }

    #[test]
    fn readable_prune_log_appends_attempts_with_token_totals() {
        let root = tempfile::tempdir().expect("audit root");
        let input = serde_json::json!({"items": [{
            "call_id": "call-1", "source_tokens_estimate": 1200,
            "invocation": {"name": "shell", "arguments": "{\"command\":\"cargo test -p core\"}"},
            "source_output": {"type": "function_call_output", "call_id": "call-1", "output": "original output"}
        }]}).to_string();
        let mut attempt = attempt_input("readable-1");
        attempt.input = &input;
        write_attempt(root.path(), attempt).unwrap();
        let path = readable_path(root.path());
        assert!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with(" Readable fixture session-1.md")
        );
        let first = std::fs::read_to_string(&path).expect("readable log beside audit");
        let timestamp = chrono::DateTime::parse_from_str(
            first
                .strip_prefix("## ")
                .unwrap()
                .split(" · ")
                .next()
                .unwrap(),
            "%Y-%m-%d %H:%M:%S %:z",
        )
        .unwrap();
        assert_eq!(
            timestamp.offset().local_minus_utc(),
            chrono::Local::now().offset().local_minus_utc()
        );
        assert!(first.contains("Readable fixture · Turn 3 · gpt-5.6-luna (low)"));
        assert!(first.contains("shell: cargo test -p core"), "{first}");
        assert!(first.contains("| 1200 | 1200 |"), "{first}");
        assert!(
            first.contains("failed: The pruning model stopped responding"),
            "{first}"
        );
        assert!(first.contains("Saved 0 of 1200 tokens (0.0%)"), "{first}");
        assert!(
            first
                .trim_end()
                .ends_with("Turn ID: turn-1 · Attempt: readable-1</small>")
        );
        let mut renamed = attempt_input("readable-2");
        renamed.chat_title = Some("Renamed chat");
        write_attempt(root.path(), renamed).unwrap();
        let both = std::fs::read_to_string(&path).unwrap();
        assert!(both.starts_with(&first));
        assert!(both.contains("Renamed chat"));
        assert_eq!(
            both.matches("failed: The pruning model stopped responding")
                .count(),
            2,
            "an unreadable input must retain the failure reason too"
        );
        let mut other = attempt_input("other-chat");
        other.thread_id = Some("session-2");
        other.chat_title = Some("داده / parser | notes");
        write_attempt(root.path(), other).unwrap();
        assert_eq!(
            std::fs::read_dir(root.path().join("smart-prune"))
                .unwrap()
                .filter(|e| e
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "md"))
                .count(),
            2
        );
        assert!(
            root.path()
                .join("smart-prune")
                .read_dir()
                .unwrap()
                .any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains("داده _ parser _ notes session-2.md"))
        );
        assert_eq!(both.matches("Attempt: readable-").count(), 2);
        assert!(write_attempt(root.path(), attempt_input("readable-1")).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), both);
    }

    #[test]
    fn readable_prune_log_reports_mixed_admitted_and_kept_numbers() {
        let root = tempfile::tempdir().unwrap();
        let item = audit_item("call-1");
        write_admission(root.path(), audit_input("admission-1", &item)).unwrap();
        let input = serde_json::json!({"items":[
            {"call_id":"call-1", "source_tokens_estimate":3000,
             "invocation":{"name":"shell","arguments":"{\"command\":\"cargo test -p core\"}"},
             "source_output":item.source},
            {"call_id":"call-2", "source_tokens_estimate":1200,
             "invocation":{"name":"read_file","arguments":"{\"path\":\"src/app.rs\"}"},
             "source_output":output("call-2", "kept original")}
        ]})
        .to_string();
        let mut attempt = attempt_input("mixed");
        attempt.input = &input;
        attempt.status = AttemptStatus::Admitted;
        attempt.error = None;
        attempt.admission_id = Some("admission-1");
        attempt.admitted_outputs = 1;
        attempt.saved_tokens = 2990;
        write_attempt(root.path(), attempt).unwrap();
        let log = std::fs::read_to_string(chat_markdown_path(root.path())).unwrap();
        assert!(log.contains("| 3000 | 10 | compacted:"), "{log}");
        assert!(
            log.contains("read\\_file: src/app.rs | 1200 | 1200 | kept:"),
            "{log}"
        );
        assert!(log.contains("Saved 2990 of 4200 tokens (71.2%)"), "{log}");
        let record = crate::smart_prune_log::read_attempt(root.path(), "mixed").unwrap();
        assert_eq!(
            record.items[0].compact.as_deref(),
            Some("kept fact\n[ELPIS SMART PRUNE]")
        );
        assert!(record.items[1].compact.is_none());
    }

    #[test]
    fn readable_prune_log_serializes_concurrent_appends() {
        let root = tempfile::tempdir().unwrap();
        std::thread::scope(|scope| {
            for index in 0..8 {
                let directory = root.path();
                scope.spawn(move || {
                    write_attempt(directory, attempt_input(&format!("parallel-{index}"))).unwrap();
                });
            }
        });
        let log = std::fs::read_to_string(chat_markdown_path(root.path())).unwrap();
        assert_eq!(log.matches("Readable fixture · Turn 3").count(), 8);
        assert_eq!(log.matches("Attempt: parallel-").count(), 8);
        for index in 0..8 {
            assert!(log.contains(&format!("Attempt: parallel-{index}</small>\n\n")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn readable_prune_log_rejects_symlinks_without_losing_the_machine_audit() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), "untouched").unwrap();
        let directory = root.path().join("smart-prune");
        std::fs::create_dir(&directory).unwrap();
        std::os::unix::fs::symlink(
            outside.path(),
            directory.join("2026-10-17 Readable fixture session-1.md"),
        )
        .unwrap();
        let receipt = write_attempt(root.path(), attempt_input("linked-log")).unwrap();
        assert!(root.path().join(receipt.audit_path).is_file());
        assert_eq!(
            std::fs::read_to_string(outside.path()).unwrap(),
            "untouched"
        );
    }

    #[test]
    fn attempt_publication_is_exact_immutable_and_path_confined() {
        let root = tempfile::tempdir().expect("audit root");
        let receipt = write_attempt(root.path(), attempt_input("attempt-1"))
            .expect("publish optimizer attempt");
        assert_eq!(
            receipt.audit_path,
            Path::new("smart-prune/attempts/attempt-1.json")
        );
        let record: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.path().join(&receipt.audit_path))
                .expect("read optimizer attempt"),
        )
        .expect("parse optimizer attempt");
        assert_eq!(record["status"], "timed_out");
        assert_eq!(record["model"], "gpt-5.6-luna");
        assert_eq!(record["reasoning_effort"], "low");
        assert_eq!(record["input"], "exact optimizer input");
        assert_eq!(record["candidate_outputs"], 2);
        assert_eq!(record["latency_ms"], 20_000);
        assert!(
            write_attempt(root.path(), attempt_input("attempt-1")).is_err(),
            "attempt evidence must never be overwritten"
        );
        assert!(write_attempt(root.path(), attempt_input("../escape")).is_err());
        assert!(!root.path().join("escape.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn attempt_artifacts_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("audit root");
        let receipt = write_attempt(root.path(), attempt_input("private-attempt"))
            .expect("publish optimizer attempt");
        for directory in [
            root.path().join("smart-prune"),
            root.path().join("smart-prune/attempts"),
        ] {
            assert_eq!(
                std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700,
                "{} must be private",
                directory.display()
            );
        }
        assert_eq!(
            std::fs::metadata(root.path().join(receipt.audit_path))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600,
        );
        assert_eq!(
            std::fs::metadata(chat_markdown_path(root.path()))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn publishes_exact_source_and_admitted_items_atomically() {
        let root = tempfile::tempdir().expect("audit root");
        let item = audit_item("call/unsafe");
        let receipt = write_admission(
            root.path(),
            AdmissionAuditInput {
                admission_id: "019a-admission",
                session_id: "session-1",
                turn_id: "turn-1",
                model_slug: "gpt-5.6-luna",
                ace_instructions: "instructions",
                ace_input: "input",
                raw_response: r#"{"items":[]}"#,
                usage: None,
                items: std::slice::from_ref(&item),
            },
        )
        .expect("publish admission");

        assert_eq!(receipt.admission_id, "019a-admission");
        assert!(receipt.admission_dir.join("manifest.json").is_file());
        let source_path = receipt
            .admission_dir
            .join("items/000-call_unsafe-source.json");
        let admitted_path = receipt
            .admission_dir
            .join("items/000-call_unsafe-admitted.json");
        assert_eq!(
            serde_json::from_str::<ResponseItem>(&std::fs::read_to_string(source_path).unwrap())
                .unwrap(),
            item.source
        );
        assert_eq!(
            serde_json::from_str::<ResponseItem>(&std::fs::read_to_string(admitted_path).unwrap())
                .unwrap(),
            item.admitted
        );
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(receipt.admission_dir.join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["saved_tokens"], 2_990);
        assert_eq!(manifest["items"][0]["source_sha256"], item.source_sha256);
        assert_eq!(manifest["ace_conversation"], "ace.json");
        assert_eq!(manifest["items"][0]["decision"], "compact");
    }

    #[test]
    fn refuses_overwrite_and_bad_hash_without_publishing_partial_directory() {
        let root = tempfile::tempdir().expect("audit root");
        let item = audit_item("same-call");
        write_admission(root.path(), audit_input("same-id", &item)).expect("first publication");
        assert!(write_admission(root.path(), audit_input("same-id", &item)).is_err());

        let mut bad = audit_item("bad-hash");
        bad.source_sha256 = "wrong".to_string();
        let bad_input = AdmissionAuditInput {
            admission_id: "bad-id",
            session_id: "session-1",
            turn_id: "turn-1",
            model_slug: "gpt-5.6-luna",
            ace_instructions: "instructions",
            ace_input: "input",
            raw_response: "response",
            usage: None,
            items: std::slice::from_ref(&bad),
        };
        assert!(write_admission(root.path(), bad_input).is_err());
        assert!(!root.path().join("smart-prune/admissions/bad-id").exists());
    }

    #[test]
    fn write_failure_is_fail_closed_for_admission() {
        let root = tempfile::NamedTempFile::new().expect("not a directory");
        let item = audit_item("call-1");
        let error = write_admission(
            root.path(),
            AdmissionAuditInput {
                admission_id: "admission-1",
                session_id: "session-1",
                turn_id: "turn-1",
                model_slug: "gpt-5.6-luna",
                ace_instructions: "instructions",
                ace_input: "input",
                raw_response: "response",
                usage: None,
                items: std::slice::from_ref(&item),
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("Smart Prune audit directory"));
    }

    #[test]
    fn failed_json_publication_leaves_no_final_or_staging_file() {
        let root = tempfile::tempdir().expect("audit root");
        let final_path = root.path().join("request.json");

        assert!(write_json_new(&final_path, &SerializationFailure).is_err());
        assert!(
            !final_path.exists(),
            "a partial final file must never escape"
        );
        assert_eq!(
            std::fs::read_dir(root.path()).unwrap().count(),
            0,
            "failed publication must clean its same-directory staging file"
        );
    }

    #[test]
    fn failed_directory_publication_cleans_staging_directory() {
        let root = tempfile::tempdir().expect("audit root");
        let staging = Builder::new()
            .prefix(".pending-test-")
            .tempdir_in(root.path())
            .expect("staging directory");
        let staging_path = staging.path().to_path_buf();
        std::fs::write(staging.path().join("raw.json"), b"sensitive").unwrap();
        let final_dir = root.path().join("final");
        std::fs::create_dir(&final_dir).unwrap();
        std::fs::write(final_dir.join("occupied"), b"do not replace").unwrap();

        assert!(publish_staging_directory(staging, &final_dir, root.path()).is_err());
        assert!(
            !staging_path.exists(),
            "rename failure must not leak exact source in a pending directory"
        );
        assert_eq!(
            std::fs::read(final_dir.join("occupied")).unwrap(),
            b"do not replace"
        );
    }

    #[test]
    fn admission_path_resolution_rejects_absolute_traversal_and_mismatch() {
        let root = tempfile::tempdir().expect("audit root");
        let item = audit_item("call-1");
        let receipt =
            write_admission(root.path(), audit_input("safe-id", &item)).expect("publish admission");
        assert_eq!(
            resolve_admission_directory(
                root.path(),
                Path::new("smart-prune/admissions/safe-id"),
                "safe-id",
            )
            .unwrap(),
            receipt.admission_dir
        );

        let outside = tempfile::tempdir().expect("outside root");
        assert!(
            resolve_admission_directory(root.path(), outside.path(), "safe-id").is_err(),
            "an absolute restored path must not replace the trusted log root"
        );
        assert!(
            resolve_admission_directory(
                root.path(),
                Path::new("smart-prune/admissions/../../outside"),
                "safe-id",
            )
            .is_err(),
            "parent traversal must be rejected"
        );
        assert!(
            resolve_admission_directory(
                root.path(),
                Path::new("smart-prune/admissions/other-id"),
                "safe-id",
            )
            .is_err(),
            "the restored path must identify the same admission"
        );
    }

    #[test]
    fn admission_publication_rejects_unsafe_id_without_escaping_log_root() {
        let root = tempfile::tempdir().expect("audit root");
        let outside = tempfile::tempdir().expect("outside root");
        let escaped = outside.path().join("escaped-admission");
        let unsafe_id = escaped.to_str().expect("utf-8 temp path");
        let item = audit_item("call-1");

        assert!(
            write_admission(root.path(), audit_input(unsafe_id, &item)).is_err(),
            "an absolute admission id must not choose the publication directory"
        );
        assert!(!escaped.exists());
    }

    #[cfg(unix)]
    #[test]
    fn admission_path_resolution_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("audit root");
        let admissions = root.path().join("smart-prune/admissions");
        std::fs::create_dir_all(&admissions).unwrap();
        let outside = tempfile::tempdir().expect("outside root");
        symlink(outside.path(), admissions.join("escape-id")).unwrap();

        assert!(
            resolve_admission_directory(
                root.path(),
                Path::new("smart-prune/admissions/escape-id"),
                "escape-id",
            )
            .is_err(),
            "a lexical in-root path must not follow a symlink outside the log root"
        );
    }

    #[cfg(unix)]
    #[test]
    fn admission_artifacts_and_linkages_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("audit root");
        let item = audit_item("private-call");
        let receipt = write_admission(root.path(), audit_input("private-id", &item))
            .expect("publish admission");
        let audit_path = Path::new("smart-prune/admissions/private-id");
        write_request_linkage(root.path(), audit_path, "private-id", 1, "hash")
            .expect("write request linkage");
        write_response_linkage(root.path(), audit_path, "private-id", "response", None)
            .expect("write response linkage");

        for directory in [
            root.path().join("smart-prune"),
            root.path().join("smart-prune/admissions"),
            receipt.admission_dir.clone(),
            receipt.admission_dir.join("items"),
        ] {
            assert_eq!(
                std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700,
                "{} must be private",
                directory.display()
            );
        }
        for file in [
            receipt.admission_dir.join("ace.json"),
            receipt.admission_dir.join("manifest.json"),
            receipt
                .admission_dir
                .join("items/000-private-call-source.json"),
            receipt
                .admission_dir
                .join("items/000-private-call-admitted.json"),
            receipt.admission_dir.join("request.json"),
            receipt.admission_dir.join("response.json"),
        ] {
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600,
                "{} must be private",
                file.display()
            );
        }
    }

    #[test]
    fn request_and_response_linkage_are_hash_only_and_immutable() {
        let root = tempfile::tempdir().expect("audit root");
        let item = audit_item("call-1");
        let receipt = write_admission(root.path(), audit_input("linked-id", &item))
            .expect("publish admission");
        let audit_path = Path::new("smart-prune/admissions/linked-id");
        write_request_linkage(root.path(), audit_path, "linked-id", 7, "0123456789abcdef")
            .expect("write request linkage");
        let usage = TokenUsage {
            input_tokens: 2_000,
            cached_input_tokens: 1_500,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 2_025,
            ..Default::default()
        };
        write_response_linkage(
            root.path(),
            audit_path,
            "linked-id",
            "response-1",
            Some(&usage),
        )
        .expect("write response linkage");
        assert!(
            write_request_linkage(root.path(), audit_path, "linked-id", 8, "other").is_err(),
            "linkage files must never be overwritten"
        );
        let request = std::fs::read_to_string(receipt.admission_dir.join("request.json")).unwrap();
        assert!(request.contains("0123456789abcdef"));
        assert!(!request.contains("raw sentinel"));
        let request: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(
            request["input_representation"],
            "logical_response_items_before_transport"
        );
        let response: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(receipt.admission_dir.join("response.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(response["usage"]["cached_input_tokens"], 1_500);
        assert_eq!(response["usage"]["cache_write_input_tokens"], 0);
    }

    #[test]
    fn linkage_publication_cannot_escape_trusted_log_root() {
        let root = tempfile::tempdir().expect("audit root");
        let item = audit_item("safe-call");
        write_admission(root.path(), audit_input("safe-id", &item)).expect("publish admission");
        let outside = tempfile::tempdir().expect("outside root");
        let outside_admission = outside.path().join("smart-prune/admissions/safe-id");
        std::fs::create_dir_all(&outside_admission).unwrap();

        assert!(
            write_request_linkage(root.path(), &outside_admission, "safe-id", 1, "hash",).is_err()
        );
        assert!(!outside_admission.join("request.json").exists());
        assert!(
            write_response_linkage(
                root.path(),
                Path::new("smart-prune/admissions/../../outside"),
                "safe-id",
                "response",
                None,
            )
            .is_err()
        );
        assert!(!root.path().join("outside/response.json").exists());
    }
}
