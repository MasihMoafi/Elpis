use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::BufWriter;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use codex_protocol::models::ResponseItem;
use serde::Serialize;
use tempfile::Builder;
use url::Url;
use uuid::Uuid;

use crate::context_pruner::PruneRecord;

const AUDIT_SCHEMA_VERSION: u32 = 1;

pub(super) struct PruneAuditInput<'a> {
    pub(super) model_slug: &'a str,
    pub(super) ace_instructions: &'a str,
    pub(super) ace_input: &'a str,
    pub(super) raw_response: &'a str,
    pub(super) batch: &'a [(String, String)],
    pub(super) record: &'a PruneRecord,
    pub(super) before_model_items: &'a [ResponseItem],
    pub(super) after_model_items: &'a [ResponseItem],
    pub(super) saved_chars: usize,
}

#[derive(Debug)]
pub(super) struct PruneAuditOutput {
    pub(super) pass_dir: PathBuf,
    pub(super) report: String,
}

#[derive(Serialize)]
struct AceConversation<'a> {
    model: &'a str,
    instructions: &'a str,
    input: &'a str,
    raw_response: &'a str,
}

#[derive(Serialize)]
struct PassManifest<'a> {
    schema_version: u32,
    pass_id: String,
    timestamp: String,
    model: &'a str,
    saved_chars: usize,
    ace_conversation: &'static str,
    items: Vec<ManifestItem>,
}

#[derive(Serialize)]
struct ManifestItem {
    call_id: String,
    decision: &'static str,
    conclusion: Option<String>,
    artifact: String,
}

#[derive(Serialize)]
struct ItemArtifact<'a> {
    schema_version: u32,
    call_id: &'a str,
    decision: &'static str,
    conclusion: Option<&'a str>,
    source_pointer: String,
    model_visible_before: Vec<&'a ResponseItem>,
    model_visible_after: Vec<&'a ResponseItem>,
}

pub(super) fn write_applied_pass(
    log_dir: &Path,
    input: PruneAuditInput<'_>,
) -> Result<PruneAuditOutput> {
    let passes_dir = log_dir.join("pruning").join("passes");
    std::fs::create_dir_all(&passes_dir).with_context(|| {
        format!(
            "failed to create pruning audit directory {}",
            passes_dir.display()
        )
    })?;

    let pass_id = Uuid::now_v7().to_string();
    let final_dir = passes_dir.join(&pass_id);
    let staging = Builder::new()
        .prefix(".pending-")
        .tempdir_in(&passes_dir)
        .with_context(|| format!("failed to stage pruning audit {pass_id}"))?;
    let staging_dir = staging.path();

    write_json_new(
        &staging_dir.join("ace.json"),
        &AceConversation {
            model: input.model_slug,
            instructions: input.ace_instructions,
            input: input.ace_input,
            raw_response: input.raw_response,
        },
    )?;

    let conclusions = conclusions_by_call_id(&input.record.text);
    let mut manifest_items = Vec::with_capacity(input.batch.len());
    let mut report_items = Vec::with_capacity(input.batch.len());
    for (index, (call_id, _)) in input.batch.iter().enumerate() {
        let conclusion = conclusions.get(call_id.as_str()).copied();
        let decision = if conclusion.is_some() {
            "kept"
        } else {
            "deleted"
        };
        let artifact_name = format!(
            "{index:03}-{}.json",
            safe_filename_component(call_id.as_str())
        );
        let artifact_relative = PathBuf::from("items").join(&artifact_name);
        let artifact_path = staging_dir.join(&artifact_relative);
        std::fs::create_dir_all(
            artifact_path
                .parent()
                .context("pruning item artifact has no parent")?,
        )?;
        write_json_new(
            &artifact_path,
            &ItemArtifact {
                schema_version: AUDIT_SCHEMA_VERSION,
                call_id,
                decision,
                conclusion,
                source_pointer: format!("rollout://tool-call/{call_id}"),
                model_visible_before: items_for_call_id(input.before_model_items, call_id),
                model_visible_after: items_for_call_id(input.after_model_items, call_id),
            },
        )?;
        manifest_items.push(ManifestItem {
            call_id: call_id.clone(),
            decision,
            conclusion: conclusion.map(str::to_string),
            artifact: artifact_relative.to_string_lossy().into_owned(),
        });
        report_items.push((
            call_id.clone(),
            decision,
            conclusion.map(str::to_string),
            final_dir.join(artifact_relative),
        ));
    }

    write_json_new(
        &staging_dir.join("manifest.json"),
        &PassManifest {
            schema_version: AUDIT_SCHEMA_VERSION,
            pass_id: pass_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            model: input.model_slug,
            saved_chars: input.saved_chars,
            ace_conversation: "ace.json",
            items: manifest_items,
        },
    )?;

    let staging_path = staging.keep();
    std::fs::rename(&staging_path, &final_dir).with_context(|| {
        format!(
            "failed to commit pruning audit {} to {}",
            staging_path.display(),
            final_dir.display()
        )
    })?;

    let report = build_latest_report(
        &final_dir,
        input.model_slug,
        input.saved_chars,
        &report_items,
    );
    Ok(PruneAuditOutput {
        pass_dir: final_dir,
        report,
    })
}

pub(super) fn write_latest_report(log_dir: &Path, report: &str) -> Result<()> {
    std::fs::create_dir_all(log_dir)?;
    let report_path = log_dir.join("prune_report.md");
    let mut staged = tempfile::NamedTempFile::new_in(log_dir)?;
    staged.write_all(report.as_bytes())?;
    staged.as_file().sync_all()?;
    staged
        .persist(&report_path)
        .map_err(|error| error.error)
        .with_context(|| format!("failed to update {}", report_path.display()))?;
    Ok(())
}

fn write_json_new(path: &Path, value: &impl Serialize) -> Result<()> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("failed to create immutable audit file {}", path.display()))?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok(())
}

fn conclusions_by_call_id(record_text: &str) -> HashMap<&str, &str> {
    record_text
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(id, conclusion)| (id.trim(), conclusion.trim()))
        .collect()
}

fn items_for_call_id<'a>(
    items: &'a [ResponseItem],
    expected_call_id: &str,
) -> Vec<&'a ResponseItem> {
    items
        .iter()
        .filter(|item| response_item_call_id(item) == Some(expected_call_id))
        .collect()
}

fn response_item_call_id(item: &ResponseItem) -> Option<&str> {
    match item {
        ResponseItem::LocalShellCall { call_id, .. }
        | ResponseItem::ToolSearchCall { call_id, .. }
        | ResponseItem::ToolSearchOutput { call_id, .. } => call_id.as_deref(),
        ResponseItem::FunctionCall { call_id, .. }
        | ResponseItem::FunctionCallOutput { call_id, .. }
        | ResponseItem::CustomToolCall { call_id, .. }
        | ResponseItem::CustomToolCallOutput { call_id, .. } => Some(call_id.as_str()),
        _ => None,
    }
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

fn build_latest_report(
    pass_dir: &Path,
    model_slug: &str,
    saved_chars: usize,
    items: &[(String, &'static str, Option<String>, PathBuf)],
) -> String {
    let ace_url = file_url(&pass_dir.join("ace.json"));
    let manifest_url = file_url(&pass_dir.join("manifest.json"));
    let kept = items
        .iter()
        .filter(|(_, decision, _, _)| *decision == "kept")
        .count();
    let mut report = format!(
        "# Elpis Context Pruning Evidence\n\n\
         Latest immutable pass: `{}`  \n\
         Model: `{model_slug}`  \n\
         Result: {} reviewed · {kept} kept · {} deleted · ≈{saved_chars} chars removed\n\n\
         - Exact Ace conversation: {ace_url}\n\
         - Pass manifest: {manifest_url}\n\n\
         ## Decisions\n\n",
        pass_dir.file_name().unwrap_or_default().to_string_lossy(),
        items.len(),
        items.len().saturating_sub(kept),
    );
    for (call_id, decision, conclusion, artifact_path) in items {
        let artifact_url = file_url(artifact_path);
        match conclusion {
            Some(conclusion) => report.push_str(&format!(
                "- `{call_id}` — **KEPT**: {conclusion}  \n  Exact before/after: {artifact_url}\n"
            )),
            None => report.push_str(&format!(
                "- `{call_id}` — **DELETED** as a dead end  \n  Exact before/after: {artifact_url}\n"
            )),
        }
        debug_assert_eq!(
            *decision,
            if conclusion.is_some() {
                "kept"
            } else {
                "deleted"
            }
        );
    }
    report.push_str(
        "\nEvery pass directory is permanent. These artifacts contain only Ace's \
         pruning conversation and the affected tool items, not the full rollout, \
         system prompt, or skills.\n",
    );
    report
}

fn file_url(path: &Path) -> String {
    Url::from_file_path(path)
        .map(Into::into)
        .unwrap_or_else(|()| format!("file://{}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::FunctionCallOutputPayload;

    fn tool_call(call_id: &str, command: &str) -> ResponseItem {
        ResponseItem::FunctionCall {
            id: None,
            name: "exec_command".to_string(),
            namespace: None,
            arguments: format!(r#"{{"cmd":"{command}"}}"#),
            call_id: call_id.to_string(),
            internal_chat_message_metadata_passthrough: None,
        }
    }

    fn tool_output(call_id: &str, output: &str) -> ResponseItem {
        ResponseItem::FunctionCallOutput {
            id: None,
            call_id: call_id.to_string(),
            output: FunctionCallOutputPayload::from_text(output.to_string()),
            internal_chat_message_metadata_passthrough: None,
        }
    }

    #[test]
    fn writes_exact_per_call_artifacts_without_unrelated_context() {
        let root = tempfile::tempdir().expect("audit root");
        let full_output = "needle\n".repeat(200);
        let before = vec![
            ResponseItem::Message {
                id: None,
                role: "developer".to_string(),
                content: vec![codex_protocol::models::ContentItem::InputText {
                    text: "SYSTEM PROMPT AND SKILLS MUST NOT ENTER ITEM FILES".to_string(),
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
            tool_call("call/unsafe", "rg needle"),
            tool_output("call/unsafe", &full_output),
            tool_call("dead-end", "rg missing"),
            tool_output("dead-end", "no matches"),
        ];
        let after = vec![
            tool_call("call/unsafe", "rg needle"),
            tool_output("call/unsafe", "[ELPIS CONTEXT UPDATE]\nkept=found needle"),
        ];
        let batch = vec![
            (
                "call/unsafe".to_string(),
                format!("tool: exec_command\noutput:\n{full_output}"),
            ),
            (
                "dead-end".to_string(),
                "tool: exec_command\noutput:\nno matches".to_string(),
            ),
        ];
        let record = PruneRecord {
            covered_call_ids: vec!["call/unsafe".to_string(), "dead-end".to_string()],
            text: "call/unsafe: found needle in source.rs".to_string(),
        };

        let written = write_applied_pass(
            root.path(),
            PruneAuditInput {
                model_slug: "terra",
                ace_instructions: "PRUNING INSTRUCTIONS",
                ace_input: "ACE INPUT",
                raw_response: "call/unsafe: found needle in source.rs",
                batch: &batch,
                record: &record,
                before_model_items: &before,
                after_model_items: &after,
                saved_chars: 1_000,
            },
        )
        .expect("write audit");

        let item: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(written.pass_dir.join("items/000-call_unsafe.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            item["model_visible_before"][1]["output"].as_str(),
            Some(full_output.as_str())
        );
        assert_eq!(
            item["conclusion"].as_str(),
            Some("found needle in source.rs")
        );
        assert!(
            item["model_visible_after"][1]["output"]
                .as_str()
                .unwrap()
                .contains("ELPIS CONTEXT UPDATE")
        );
        assert!(!item.to_string().contains("SYSTEM PROMPT AND SKILLS"));

        let deleted: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(written.pass_dir.join("items/001-dead-end.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(deleted["decision"], "deleted");
        assert_eq!(deleted["model_visible_before"].as_array().unwrap().len(), 2);
        assert!(
            deleted["model_visible_after"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(written.pass_dir.join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["items"].as_array().unwrap().len(), 2);

        let ace = std::fs::read_to_string(written.pass_dir.join("ace.json")).unwrap();
        assert!(ace.contains("PRUNING INSTRUCTIONS"));
        assert!(ace.contains("ACE INPUT"));
        assert!(ace.contains("call/unsafe: found needle in source.rs"));
        assert!(written.report.contains("Exact before/after: file://"));
    }

    #[test]
    fn every_applied_pass_gets_a_distinct_immutable_directory() {
        let root = tempfile::tempdir().expect("audit root");
        let before = vec![tool_call("a", "first"), tool_output("a", "result")];
        let after = Vec::new();
        let batch = vec![("a".to_string(), "tool and output".to_string())];
        let record = PruneRecord {
            covered_call_ids: vec!["a".to_string()],
            text: String::new(),
        };
        let write = || {
            write_applied_pass(
                root.path(),
                PruneAuditInput {
                    model_slug: "terra",
                    ace_instructions: "instructions",
                    ace_input: "input",
                    raw_response: "NOTHING_TO_KEEP",
                    batch: &batch,
                    record: &record,
                    before_model_items: &before,
                    after_model_items: &after,
                    saved_chars: 10,
                },
            )
            .unwrap()
            .pass_dir
        };

        let first = write();
        let second = write();
        assert_ne!(first, second);
        assert!(first.join("manifest.json").is_file());
        assert!(second.join("manifest.json").is_file());
    }

    #[test]
    fn audit_write_failure_is_reported() {
        let root = tempfile::NamedTempFile::new().expect("non-directory root");
        let batch = vec![("a".to_string(), "output".to_string())];
        let record = PruneRecord {
            covered_call_ids: vec!["a".to_string()],
            text: String::new(),
        };
        let error = write_applied_pass(
            root.path(),
            PruneAuditInput {
                model_slug: "terra",
                ace_instructions: "instructions",
                ace_input: "input",
                raw_response: "NOTHING_TO_KEEP",
                batch: &batch,
                record: &record,
                before_model_items: &[],
                after_model_items: &[],
                saved_chars: 0,
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("pruning audit directory"));
    }
}
