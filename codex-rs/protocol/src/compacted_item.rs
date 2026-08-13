use crate::models::ResponseItem;
use crate::protocol::CompactedItem;
use serde::Deserialize;
use serde::Serialize;
use serde::ser::SerializeStruct;

/// Serializes the derived `kind` discriminator alongside the stored fields.
///
/// Written by hand rather than derived so `kind` cannot drift from the record it describes:
/// it is computed from `message` on every write. Deserialization ignores any `kind` present
/// in an existing rollout for the same reason — the record is the source of truth, not the
/// label a previous writer stamped on it.
impl Serialize for CompactedItem {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // `kind` plus the five optional fields that are skipped when absent.
        let mut len = 2;
        if self.replacement_history.is_some() {
            len += 1;
        }
        if self.window_number.is_some() {
            len += 1;
        }
        if self.first_window_id.is_some() {
            len += 1;
        }
        if self.previous_window_id.is_some() {
            len += 1;
        }
        if self.window_id.is_some() {
            len += 1;
        }

        let mut state = serializer.serialize_struct("CompactedItem", len)?;
        state.serialize_field("message", &self.message)?;
        state.serialize_field("kind", &self.kind())?;
        if let Some(replacement_history) = &self.replacement_history {
            state.serialize_field("replacement_history", replacement_history)?;
        }
        if let Some(window_number) = &self.window_number {
            state.serialize_field("window_number", window_number)?;
        }
        if let Some(first_window_id) = &self.first_window_id {
            state.serialize_field("first_window_id", first_window_id)?;
        }
        if let Some(previous_window_id) = &self.previous_window_id {
            state.serialize_field("previous_window_id", previous_window_id)?;
        }
        if let Some(window_id) = &self.window_id {
            state.serialize_field("window_id", window_id)?;
        }
        state.end()
    }
}

// Before `window_number` was introduced, the numeric window number was serialized as
// `window_id`. Accept that shape so existing rollouts remain resumable.
impl<'de> Deserialize<'de> for CompactedItem {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let serialized = SerializedCompactedItem::deserialize(deserializer)?;
        let mut window_number = serialized.window_number;
        let window_id = match serialized.window_id {
            Some(SerializedWindowId::Id(window_id)) => Some(window_id),
            Some(SerializedWindowId::LegacyWindowNumber(legacy_window_number)) => {
                window_number.get_or_insert(legacy_window_number);
                None
            }
            None => None,
        };
        Ok(Self {
            message: serialized.message,
            replacement_history: serialized.replacement_history,
            window_number,
            first_window_id: serialized.first_window_id,
            previous_window_id: serialized.previous_window_id,
            window_id,
        })
    }
}

#[derive(Deserialize)]
struct SerializedCompactedItem {
    message: String,
    #[serde(default)]
    replacement_history: Option<Vec<ResponseItem>>,
    #[serde(default)]
    window_number: Option<u64>,
    #[serde(default)]
    first_window_id: Option<String>,
    #[serde(default)]
    previous_window_id: Option<String>,
    #[serde(default)]
    window_id: Option<SerializedWindowId>,
    // `kind` is not read back: it is derived from `message` on every write, so a stale or
    // hand-edited label in an existing rollout cannot mislabel the record. Unknown fields
    // are ignored by default, so it needs no declaration here.
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SerializedWindowId {
    Id(String),
    LegacyWindowNumber(u64),
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use pretty_assertions::assert_eq;
    use schemars::schema_for;
    use serde_json::json;
    use ts_rs::TS;

    #[test]
    fn serializes_window_number_and_id() -> Result<()> {
        let item = CompactedItem {
            message: "summary".to_string(),
            replacement_history: None,
            window_number: Some(3),
            first_window_id: Some("019b3f6e-0000-7000-8000-000000000001".to_string()),
            previous_window_id: Some("019b3f6e-0000-7000-8000-000000000002".to_string()),
            window_id: Some("019b3f6e-7a10-7cc3-8b6e-1d09e2f7a001".to_string()),
        };

        assert_eq!(
            serde_json::to_value(item)?,
            json!({
                "message": "summary",
                "kind": "compaction",
                "window_number": 3,
                "first_window_id": "019b3f6e-0000-7000-8000-000000000001",
                "previous_window_id": "019b3f6e-0000-7000-8000-000000000002",
                "window_id": "019b3f6e-7a10-7cc3-8b6e-1d09e2f7a001",
            })
        );
        Ok(())
    }

    #[test]
    fn pruning_and_compaction_records_serialize_distinct_kind_values() -> Result<()> {
        let prune = CompactedItem {
            message: CompactedItem::context_prune_checkpoint_message(12_345),
            replacement_history: None,
            window_number: Some(0),
            first_window_id: None,
            previous_window_id: None,
            window_id: None,
        };
        let compaction = CompactedItem {
            message: "a summary of the conversation".to_string(),
            ..prune
        };

        assert_eq!(serde_json::to_value(&compaction)?["kind"], "compaction");
        assert_eq!(
            serde_json::to_value(&CompactedItem {
                message: CompactedItem::context_prune_checkpoint_message(12_345),
                replacement_history: None,
                window_number: Some(0),
                first_window_id: None,
                previous_window_id: None,
                window_id: None,
            })?["kind"],
            "context_prune"
        );
        Ok(())
    }

    #[test]
    fn stale_serialized_kind_is_ignored_on_read() -> Result<()> {
        let item = serde_json::from_value::<CompactedItem>(json!({
            "message": "elpis.context-prune.v1:99",
            "kind": "compaction",
        }))?;

        assert_eq!(serde_json::to_value(item)?["kind"], "context_prune");
        Ok(())
    }

    #[test]
    fn generated_contract_includes_compaction_kind() -> Result<()> {
        let schema = serde_json::to_value(schema_for!(CompactedItem))?;
        assert_eq!(schema["schema"]["required"], json!(["kind", "message"]));
        assert!(CompactedItem::inline().contains("kind: CompactedKind"));
        Ok(())
    }

    #[test]
    fn migrates_legacy_numeric_window_id() -> Result<()> {
        let item = serde_json::from_value::<CompactedItem>(json!({
            "message": "summary",
            "window_id": 3,
        }))?;

        assert_eq!(
            item,
            CompactedItem {
                message: "summary".to_string(),
                replacement_history: None,
                window_number: Some(3),
                first_window_id: None,
                previous_window_id: None,
                window_id: None,
            }
        );
        Ok(())
    }
}
