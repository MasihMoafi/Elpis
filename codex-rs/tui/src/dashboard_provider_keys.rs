//! Owner-only provider API keys entered from the dashboard. Keys live in one
//! 0600 file under the Elpis home, are applied through the in-process provider
//! override, and are never returned, logged, or put in an error message.
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use codex_model_provider_info::ModelProviderInfo;
use serde::Deserialize;
use serde::Serialize;

const FILE_NAME: &str = "provider-keys.json";
const MAX_BODY: u64 = 16_384;
const MAX_KEY_BYTES: usize = 8_192;
/// Fixed-width mask, so a rendered value never leaks the stored key's length.
const MASK: &str = "••••••••";

/// A provider the owner can key from the dashboard. Only providers that read a
/// key from an environment variable can use one; the rest (OpenAI sign-in,
/// Amazon Bedrock, local runtimes) authenticate elsewhere and are left out.
#[derive(Clone, Debug, Eq, PartialEq)]
struct KeyedProvider {
    id: String,
    name: String,
    env_key: String,
}

pub(super) struct Registry {
    home: PathBuf,
    providers: Vec<KeyedProvider>,
}

static REGISTRY: Mutex<Option<Registry>> = Mutex::new(None);

pub(super) fn configure(home: &Path, providers: &HashMap<String, ModelProviderInfo>) {
    let registry = build(home, providers);
    apply_stored(&registry);
    if let Ok(mut slot) = REGISTRY.lock() {
        *slot = Some(registry);
    }
}

pub(super) fn build(home: &Path, providers: &HashMap<String, ModelProviderInfo>) -> Registry {
    let mut keyed: Vec<KeyedProvider> = providers
        .iter()
        .filter_map(|(id, provider)| {
            let env_key = provider.env_key.clone()?;
            let name = provider.name.trim();
            Some(KeyedProvider {
                id: id.clone(),
                name: if name.is_empty() {
                    id.clone()
                } else {
                    name.to_string()
                },
                env_key,
            })
        })
        .collect();
    keyed.sort_by(|left, right| left.id.cmp(&right.id));
    Registry {
        home: home.to_path_buf(),
        providers: keyed,
    }
}

/// Loads every stored key into the process-wide provider override, so a key the
/// owner pasted in an earlier session is live before the first request.
pub(super) fn apply_stored(registry: &Registry) {
    let Ok(stored) = load(&registry.home) else {
        return;
    };
    for provider in &registry.providers {
        if let Some(key) = stored.get(&provider.id) {
            codex_model_provider_info::set_api_key_override(&provider.env_key, Some(key.clone()));
        }
    }
}

pub(super) fn path(home: &Path) -> PathBuf {
    home.join(FILE_NAME)
}

fn load(home: &Path) -> io::Result<BTreeMap<String, String>> {
    let file = match std::fs::File::open(path(home)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BODY + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BODY {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Stored provider keys exceed 16 KiB.",
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
    file.persist(path(home)).map_err(|error| error.error)?;
    Ok(())
}

/// At most the last four characters, behind a fixed-width mask.
fn mask(key: &str) -> String {
    let characters: Vec<char> = key.chars().collect();
    if characters.len() > 8 {
        let tail: String = characters[characters.len() - 4..].iter().collect();
        format!("{MASK}{tail}")
    } else {
        MASK.to_string()
    }
}

#[derive(Debug, Serialize)]
struct ProviderKeyRow {
    id: String,
    name: String,
    env_var: String,
    /// `elpis`, `environment`, or `none`.
    source: &'static str,
    masked: Option<String>,
}

fn rows(registry: &Registry) -> Vec<ProviderKeyRow> {
    let stored = load(&registry.home).unwrap_or_default();
    registry
        .providers
        .iter()
        .map(|provider| {
            let (source, value) = match stored.get(&provider.id) {
                Some(key) => ("elpis", Some(key.clone())),
                None => match std::env::var(&provider.env_key)
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                {
                    Some(key) => ("environment", Some(key)),
                    None => ("none", None),
                },
            };
            ProviderKeyRow {
                id: provider.id.clone(),
                name: provider.name.clone(),
                env_var: provider.env_key.clone(),
                source,
                masked: value.as_deref().map(mask),
            }
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderKeyEdit {
    provider: String,
    /// `None` clears the stored key and hands the provider back to its
    /// environment variable.
    #[serde(default)]
    api_key: Option<String>,
}

pub(super) fn route(request: &mut tiny_http::Request, port: u16) -> super::DashboardResponse {
    let registry = REGISTRY.lock().ok();
    let registry = registry.as_ref().and_then(|slot| slot.as_ref());
    route_in(registry, request, port)
}

pub(super) fn route_in(
    registry: Option<&Registry>,
    request: &mut tiny_http::Request,
    port: u16,
) -> super::DashboardResponse {
    let error = |status, message: &str| {
        super::response(
            status,
            "text/plain; charset=utf-8",
            message.as_bytes().to_vec(),
        )
    };
    let Some(token) = request.url().strip_prefix("/provider-keys/") else {
        return error(404, "Not found");
    };
    if !super::valid_host(request, port) || !super::evidence::valid_token(token) {
        return error(403, "Forbidden");
    }
    let Some(registry) = registry else {
        return error(503, "Open a dashboard from the active session first");
    };
    match request.method() {
        tiny_http::Method::Get => {}
        tiny_http::Method::Post => {
            let origin = format!("http://127.0.0.1:{port}");
            let same_origin = request
                .headers()
                .iter()
                .any(|header| header.field.equiv("Origin") && header.value.as_str() == origin);
            let json = request.headers().iter().any(|header| {
                header.field.equiv("Content-Type")
                    && header.value.as_str().split(';').next() == Some("application/json")
            });
            if !same_origin || !json {
                return error(403, "Same-origin JSON required");
            }
            if request
                .body_length()
                .is_none_or(|size| size as u64 > MAX_BODY)
            {
                return error(413, "Key body too large or missing length");
            }
            let mut bytes = Vec::new();
            if request
                .as_reader()
                .take(MAX_BODY + 1)
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.len() as u64 > MAX_BODY
            {
                return error(400, "Cannot read the request");
            }
            // The body carries the key, so a parse failure is reported without it.
            let Ok(edit) = serde_json::from_slice::<ProviderKeyEdit>(&bytes) else {
                return error(400, "Send a provider id and an api_key");
            };
            let Some(provider) = registry
                .providers
                .iter()
                .find(|provider| provider.id == edit.provider)
            else {
                return error(404, "This provider does not take an API key");
            };
            if let Some(key) = &edit.api_key
                && (key.is_empty()
                    || key.len() > MAX_KEY_BYTES
                    || !key.bytes().all(|byte| (33..=126).contains(&byte)))
            {
                return error(400, "An API key is 1-8192 visible ASCII characters");
            }
            let Ok(mut stored) = load(&registry.home) else {
                return error(500, "Cannot read the stored keys");
            };
            match &edit.api_key {
                Some(key) => stored.insert(provider.id.clone(), key.clone()),
                None => stored.remove(&provider.id),
            };
            if store(&registry.home, &stored).is_err() {
                return error(500, "Cannot save the key");
            }
            codex_model_provider_info::set_api_key_override(&provider.env_key, edit.api_key);
        }
        _ => return error(405, "Method not allowed"),
    }
    match serde_json::to_vec(&serde_json::json!({ "providers": rows(registry) })) {
        Ok(body) => super::response(200, "application/json; charset=utf-8", body),
        Err(_) => error(500, "Cannot read the stored keys"),
    }
}
