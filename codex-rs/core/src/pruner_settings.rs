//! User-selected optimizer settings. These never change the main chat model.
use std::io;
use std::path::Path;

use serde::Deserialize;
use serde::Serialize;

pub const DEFAULT_SYSTEM_PROMPT: &str = r#"You are Elpis Smart Prune. Compress fresh tool results before their first use by the main model.

Return exactly one JSON object and no markdown:
{"items":[{"call_id":"...","decision":"compact","content":"..."},{"call_id":"...","decision":"unchanged"}]}

Return exactly one item for every supplied call_id. Use "compact" only when content can be made materially smaller while retaining every fact, error, path, identifier, number, caveat, and next-step detail that may matter to the active request. The compact content must stand alone. Use "unchanged" whenever lossless semantic reduction is uncertain. Never request deletion and never invent facts."#;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PrunerSettings {
    pub model: Option<String>,
    pub system_prompt: Option<String>,
}

impl PrunerSettings {
    pub fn validate(&self) -> io::Result<()> {
        if let Some(model) = &self.model {
            if model.is_empty()
                || model.len() > 200
                || model.chars().any(char::is_whitespace)
                || model.chars().any(char::is_control)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Use a nonempty model ID without whitespace (maximum 200 bytes).",
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
        use std::io::Write;
        self.validate()?;
        std::fs::create_dir_all(home)?;
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
    fn saves_and_loads_only_optimizer_settings() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        assert_eq!(PrunerSettings::load(dir.path())?, PrunerSettings::default());
        std::fs::write(dir.path().join("config.toml"), "model = 'chat-model'\n")?;
        let settings = PrunerSettings {
            model: Some("pruner-model".into()),
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
    fn invalid_edits_preserve_saved_settings() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let saved = PrunerSettings {
            model: Some("valid-model".into()),
            system_prompt: None,
        };
        saved.save(dir.path())?;
        for bad in [
            PrunerSettings {
                model: Some("not a model".into()),
                system_prompt: None,
            },
            PrunerSettings {
                model: None,
                system_prompt: Some("   ".into()),
            },
            PrunerSettings {
                model: None,
                system_prompt: Some("x".repeat(65_537)),
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
