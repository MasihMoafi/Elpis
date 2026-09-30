//! Provider API keys.
//!
//! A key comes from, in order: a bearer token core attached (a provider configured with
//! `experimental_bearer_token` or command auth), a key saved from the terminal, then the
//! provider's environment variable. Saved keys use v0.3.0's store: one owner-only
//! `provider-keys.json` in the Elpis home mapping provider ID to key, so a v0.3.0 file can be
//! copied over as is. Keys are never logged or put in an error message.

use std::collections::BTreeMap;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use crate::route::Route;

const FILE_NAME: &str = "provider-keys.json";
const MAX_FILE_BYTES: u64 = 16_384;
const MAX_KEY_BYTES: usize = 8_192;

/// Where a provider's key comes from, for display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    /// Saved from the terminal into the Elpis home.
    Saved,
    /// Read from the provider's environment variable.
    Environment,
    /// No key is available.
    Missing,
}

pub fn provider_keys_path(home: &Path) -> PathBuf {
    home.join(FILE_NAME)
}

/// Resolves the key for one gateway request.
pub(crate) fn resolve(
    home: &Path,
    route: &Route,
    env: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    if let Some(bearer) = &route.bearer {
        return Some(bearer.clone());
    }
    if let Some(saved) = load(home)
        .ok()
        .and_then(|mut keys| keys.remove(&route.provider_id))
    {
        return Some(saved);
    }
    route
        .env_key
        .as_deref()
        .and_then(env)
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

/// Where the key for `provider_id` would come from, without revealing it.
pub fn key_source(home: &Path, provider_id: &str, env_key: Option<&str>) -> KeySource {
    if load(home).is_ok_and(|keys| keys.contains_key(provider_id)) {
        KeySource::Saved
    } else if env_key
        .and_then(|name| std::env::var(name).ok())
        .is_some_and(|key| !key.trim().is_empty())
    {
        KeySource::Environment
    } else {
        KeySource::Missing
    }
}

/// Saves a key the owner pasted into the terminal. It is live for the next request in every
/// Elpis process using this home, and survives a relaunch.
pub fn save_provider_key(home: &Path, provider_id: &str, key: &str) -> io::Result<()> {
    let key = key.trim();
    if key.is_empty()
        || key.len() > MAX_KEY_BYTES
        || !key.bytes().all(|byte| (33..=126).contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "an API key must be 1-8192 visible ASCII characters",
        ));
    }
    let mut keys = load(home)?;
    keys.insert(provider_id.to_string(), key.to_string());
    store(home, &keys)
}

/// Forgets a saved key. The environment variable, if set, applies again.
pub fn remove_provider_key(home: &Path, provider_id: &str) -> io::Result<()> {
    let mut keys = load(home)?;
    if keys.remove(provider_id).is_some() {
        store(home, &keys)?;
    }
    Ok(())
}

fn load(home: &Path) -> io::Result<BTreeMap<String, String>> {
    let file = match std::fs::File::open(provider_keys_path(home)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "saved provider keys exceed 16 KiB",
        ));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn store(home: &Path, keys: &BTreeMap<String, String>) -> io::Result<()> {
    std::fs::create_dir_all(home)?;
    let bytes = serde_json::to_vec_pretty(keys)?;
    let mut file = tempfile::NamedTempFile::new_in(home)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.as_file().sync_all()?;
    file.persist(provider_keys_path(home))
        .map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
#[path = "keys_tests.rs"]
mod tests;
