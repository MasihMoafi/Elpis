use serde::Deserialize;
use serde::Serialize;
use std::io;
use std::io::Write;
use std::path::Path;

/// Reloaded before each turn; absent settings preserve native compaction policy.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PressureCompaction {
    pub remaining_percent: Option<f64>,
}

impl PressureCompaction {
    pub fn parse(value: &str) -> io::Result<Self> {
        let remaining_percent =
            value
                .trim()
                .trim_end_matches('%')
                .parse::<f64>()
                .map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Use /compact N with 0 < N < 70.",
                    )
                })?;
        let settings = Self {
            remaining_percent: Some(remaining_percent),
        };
        settings.validate()?;
        Ok(settings)
    }

    fn validate(&self) -> io::Result<()> {
        if self
            .remaining_percent
            .is_some_and(|value| !value.is_finite() || value <= 0.0 || value >= 70.0)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Use /compact N with 0 < N < 70.",
            ));
        }
        Ok(())
    }

    pub fn load(home: &Path) -> io::Result<Self> {
        let bytes = match std::fs::read(home.join("compaction.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error),
        };
        let settings: Self = serde_json::from_slice(&bytes)?;
        settings.validate()?;
        Ok(settings)
    }

    pub fn save(&self, home: &Path) -> io::Result<()> {
        self.validate()?;
        std::fs::create_dir_all(home)?;
        let mut file = tempfile::NamedTempFile::new_in(home)?;
        serde_json::to_writer_pretty(&mut file, self)?;
        file.write_all(b"\n")?;
        file.as_file().sync_all()?;
        file.persist(home.join("compaction.json"))
            .map_err(|error| error.error)?;
        Ok(())
    }

    pub fn should_compact(&self, used: i64, window: Option<i64>) -> bool {
        let (Some(percent), Some(window)) = (self.remaining_percent, window) else {
            return false;
        };
        window > 0
            && (window.saturating_sub(used.max(0)).max(0) as f64) * 100.0 <= window as f64 * percent
    }
}
