//! Durable, admission-time evidence for Smart Prune.
//!
//! A compact body is not allowed into conversation history until the exact
//! post-hook source and the proposed admitted envelope have been published
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
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use tempfile::Builder;

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

pub(super) fn response_item_sha256(item: &ResponseItem) -> Result<String> {
    let bytes = serde_json::to_vec(item).context("failed to serialize Smart Prune source")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
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
        let safe_call_id = safe_filename_component(&item.call_id);
        let source_name = format!("{index:03}-{safe_call_id}-source.json");
        let admitted_name = format!("{index:03}-{safe_call_id}-admitted.json");
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
        serde_json::to_writer_pretty(&mut writer, value)?;
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
            call_id: call_id.to_string(),
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
            cache_write_tokens: None,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 2_025,
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
        assert!(response["usage"].get("cache_write_tokens").is_none());
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
