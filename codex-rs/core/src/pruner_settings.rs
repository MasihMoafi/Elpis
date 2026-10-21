//! User-selected optimizer settings. These never change the main chat model.
use std::io;
use std::path::Path;

use serde::Deserialize;
use serde::Serialize;

pub const DEFAULT_SYSTEM_PROMPT: &str = r#"You are Elpis Smart Prune. Compress fresh tool results before their first use by the main model.

Return exactly one JSON object and no markdown:
{"items":[{"call_id":"...","decision":"compact","content":"...","reason":"Briefly name the facts kept in the compact output."},{"call_id":"...","decision":"unchanged","content":null,"reason":"Why this content must remain exact or cannot safely be made smaller."}]}

Return exactly one item for every supplied call_id. For compact results, name what the compact text kept in a short plain-language phrase. For unchanged results, explain the content-specific reason in plain words; do not merely say unchanged or no change.

Compress representation, not factual coverage. Preserve all distinct facts throughout each source_output, including facts not asked about in active_request. You are not answering that request or filtering evidence by its relevance to it; later questions are unknown. The compact content must stand alone without rereading the source.

Keep exact values and units, identifiers, paths, URLs, source file:line citations, errors, requirements, limits, negations, exceptions, caveats, and next steps. Preserve which value belongs to which entity, required ordering and dependencies, and distinctions between historical, current, and conflicting information. A source link is not a replacement for the facts or their supporting citations.

Reduce repeated boilerplate, redundant wording, and formatting. Collapse repeated records only if their meaning, counts, significant variation, associations, and exceptions remain recoverable; do not replace distinct facts with a vague aggregate. Cover the whole output, not just its beginning or the facts that answer the current question.

Use "compact" only when this factual coverage can be preserved with a materially smaller representation. Use "unchanged" whenever that is uncertain. Never request deletion and never invent facts."#;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrunerBackend {
    #[default]
    Llm,
    Jev,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PrunerSettings {
    #[serde(default)]
    pub backend: PrunerBackend,
    pub model: Option<String>,
    /// Provider that serves `model`. A model is unreachable without one, so the
    /// picker writes both together; `None` follows background maintenance.
    // Older `pruner.json` files predate this key, so a missing one has to load
    // as "unset" rather than fail and take Smart Prune down with it.
    #[serde(default)]
    pub provider: Option<String>,
    /// Saved optimizer effort override; missing in older settings files.
    #[serde(default)]
    pub reasoning_effort: Option<codex_protocol::openai_models::ReasoningEffort>,
    pub system_prompt: Option<String>,
}

impl PrunerSettings {
    pub fn validate(&self) -> io::Result<()> {
        for value in [&self.model, &self.provider] {
            let Some(value) = value else { continue };
            if value.is_empty()
                || value.len() > 200
                || value.chars().any(char::is_whitespace)
                || value.chars().any(char::is_control)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Use nonempty model and provider IDs without whitespace (maximum 200 bytes).",
                ));
            }
        }
        if self
            .system_prompt
            .as_ref()
            .is_some_and(|text| text.trim().is_empty() || text.len() > 65_536)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "The pruner prompt must contain text and be at most 64 KiB.",
            ));
        }
        Ok(())
    }

    pub fn load(home: &Path) -> io::Result<Self> {
        use std::io::Read;
        let path = home.join("pruner.json");
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(131_073).read_to_end(&mut bytes)?;
        if bytes.len() > 131_072 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Pruner settings exceed 128 KiB.",
            ));
        }
        let settings: Self = serde_json::from_slice(&bytes)?;
        settings.validate()?;
        Ok(settings)
    }

    pub fn save(&self, home: &Path) -> io::Result<()> {
        self.validate()?;
        let _lock = Self::write_lock(home)?;
        self.save_unlocked(home)
    }

    /// Save a reviewed snapshot without overwriting changes from another client.
    /// The picker and API share this lock, including changes to the custom prompt.
    pub fn save_if_unchanged(&self, home: &Path, expected: &Self) -> io::Result<bool> {
        self.validate()?;
        let _lock = Self::write_lock(home)?;
        if Self::load(home)? != *expected {
            return Ok(false);
        }
        self.save_unlocked(home)?;
        Ok(true)
    }

    fn write_lock(home: &Path) -> io::Result<std::fs::File> {
        std::fs::create_dir_all(home)?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(home.join(".pruner.lock"))?;
        file.lock()?;
        Ok(file)
    }

    fn save_unlocked(&self, home: &Path) -> io::Result<()> {
        use std::io::Write;
        let bytes = serde_json::to_vec_pretty(self)?;
        if bytes.len() + 1 > 131_072 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Encoded pruner settings exceed 128 KiB.",
            ));
        }
        let mut file = tempfile::NamedTempFile::new_in(home)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.as_file().sync_all()?;
        file.persist(home.join("pruner.json"))
            .map_err(|error| error.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_settings_default_to_llm_and_jev_is_explicit() -> io::Result<()> {
        let old: PrunerSettings =
            serde_json::from_str(r#"{"model":"chat","provider":"openai","system_prompt":null}"#)?;
        assert_eq!(old.backend, PrunerBackend::Llm);
        let jev: PrunerSettings = serde_json::from_str(r#"{"backend":"jev"}"#)?;
        assert_eq!(jev.backend, PrunerBackend::Jev);
        assert!(serde_json::from_str::<PrunerSettings>(r#"{"backend":"unknown"}"#).is_err());
        let home = tempfile::tempdir()?;
        jev.save(home.path())?;
        assert_eq!(PrunerSettings::load(home.path())?, jev);
        assert!(!home.path().join("config.toml").exists());
        Ok(())
    }

    #[test]
    fn saves_and_loads_only_optimizer_settings() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        assert_eq!(PrunerSettings::load(dir.path())?, PrunerSettings::default());
        std::fs::write(dir.path().join("config.toml"), "model = 'chat-model'\n")?;
        let settings = PrunerSettings {
            backend: PrunerBackend::Llm,
            model: Some("pruner-model".into()),
            provider: Some("openrouter".into()),
            reasoning_effort: None,
            system_prompt: Some("Keep the planted fact.".into()),
        };
        settings.save(dir.path())?;
        assert_eq!(PrunerSettings::load(dir.path())?, settings);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("config.toml"))?,
            "model = 'chat-model'\n"
        );
        PrunerSettings::default().save(dir.path())?;
        assert_eq!(PrunerSettings::load(dir.path())?, PrunerSettings::default());
        Ok(())
    }

    #[test]
    fn reviewed_edit_rejects_a_concurrent_prompt_change() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let reviewed = PrunerSettings {
            backend: PrunerBackend::Llm,
            model: Some("original-model".into()),
            provider: Some("openai".into()),
            reasoning_effort: None,
            system_prompt: Some("Original prompt".into()),
        };
        reviewed.save(dir.path())?;
        let picker_edit = PrunerSettings {
            system_prompt: Some("New prompt from the terminal".into()),
            ..reviewed.clone()
        };
        picker_edit.save(dir.path())?;
        let stale_edit = PrunerSettings {
            backend: PrunerBackend::Llm,
            model: Some("new-model".into()),
            ..reviewed.clone()
        };
        assert!(!stale_edit.save_if_unchanged(dir.path(), &reviewed)?);
        assert_eq!(PrunerSettings::load(dir.path())?, picker_edit);
        Ok(())
    }

    #[test]
    fn only_one_concurrent_reviewed_edit_can_commit() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let reviewed = PrunerSettings {
            system_prompt: Some("Preserve the custom prompt".into()),
            ..Default::default()
        };
        reviewed.save(dir.path())?;
        let first = PrunerSettings {
            backend: PrunerBackend::Llm,
            model: Some("first-model".into()),
            provider: Some("openai".into()),
            ..reviewed.clone()
        };
        let second = PrunerSettings {
            backend: PrunerBackend::Llm,
            model: Some("second-model".into()),
            ..first.clone()
        };
        let barrier = std::sync::Barrier::new(3);
        let (first_saved, second_saved) = std::thread::scope(|scope| -> io::Result<_> {
            let a = scope.spawn(|| {
                barrier.wait();
                first.save_if_unchanged(dir.path(), &reviewed)
            });
            let b = scope.spawn(|| {
                barrier.wait();
                second.save_if_unchanged(dir.path(), &reviewed)
            });
            barrier.wait();
            Ok((
                a.join()
                    .map_err(|_| io::Error::other("first writer panicked"))??,
                b.join()
                    .map_err(|_| io::Error::other("second writer panicked"))??,
            ))
        })?;
        assert_ne!(first_saved, second_saved);
        assert_eq!(
            PrunerSettings::load(dir.path())?,
            if first_saved { first } else { second }
        );
        Ok(())
    }

    #[test]
    fn invalid_edits_preserve_saved_settings() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let saved = PrunerSettings {
            backend: PrunerBackend::Llm,
            model: Some("valid-model".into()),
            provider: Some("openai".into()),
            reasoning_effort: None,
            system_prompt: None,
        };
        saved.save(dir.path())?;
        for bad in [
            PrunerSettings {
                backend: PrunerBackend::Llm,
                model: Some("not a model".into()),
                ..Default::default()
            },
            PrunerSettings {
                provider: Some("two providers".into()),
                ..Default::default()
            },
            PrunerSettings {
                system_prompt: Some("   ".into()),
                ..Default::default()
            },
            PrunerSettings {
                system_prompt: Some("x".repeat(65_537)),
                ..Default::default()
            },
        ] {
            assert!(bad.save(dir.path()).is_err());
            assert_eq!(PrunerSettings::load(dir.path())?, saved);
        }
        std::fs::write(dir.path().join("pruner.json"), "broken")?;
        assert!(PrunerSettings::load(dir.path()).is_err());
        Ok(())
    }
}
