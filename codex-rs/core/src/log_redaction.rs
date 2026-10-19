//! Redact disposable logs and audits, never the model's working input.

use std::sync::LazyLock;

use regex_lite::Captures;
use regex_lite::Regex;

// Keep aligned with tools/elpis-claude/log-redaction.mjs. Shared fixtures cover both.
static RULES: LazyLock<Vec<(&str, Regex, bool)>> = LazyLock::new(|| {
    [
        ("env", r"(?im)^([ \t]*(?:export[ \t]+)?(?:[A-Za-z_][A-Za-z0-9_]*)?(?:KEY|TOKEN|SECRET)[ \t]*=[ \t]*)([^\r\n]+)", true),
        ("x-api-key", r#"(?i)(\bx-api-key[ \t]*:[ \t]*["']?)([^\s"'`,;}\[\]<>\\]+)"#, true),
        ("bearer", r#"(?i)(\bBearer[ \t]+)([^\s"'`,;}\[\]<>\\]+)"#, true),
        ("anthropic", r"\bsk-ant-[A-Za-z0-9_-]+", false),
        ("openrouter", r"\bsk-or-[A-Za-z0-9_-]+", false),
        ("openai", r"\bsk-[A-Za-z0-9_-]+", false),
        ("google", r"\bAIza[A-Za-z0-9_-]{20,}", false),
        ("github", r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)", false),
        ("aws", r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", false),
    ]
    .into_iter()
    .map(|(kind, pattern, prefix)| (kind, Regex::new(pattern).expect("log redaction rule"), prefix))
    .collect()
});
static JSON_STRING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""(?:\\.|[^"\\])*""#).expect("JSON string pattern"));
static SENSITIVE_FIELD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:KEY|TOKEN|SECRET)$").expect("secret field pattern"));
static MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[redacted:[a-z-]+\]$").expect("redaction marker"));

/// Returns a sanitized copy, including JSON string values and nested serialized JSON.
/// Only changed JSON string tokens are serialized again; all other bytes survive.
pub fn redact_secrets(input: &str) -> String {
    let mut previous: Option<(usize, Option<&str>)> = None;
    let mut clean = JSON_STRING
        .replace_all(input, |captures: &Captures<'_>| {
            let token = captures.get(0).expect("JSON token");
            let Ok(value) = serde_json::from_str::<String>(token.as_str()) else {
                previous = None;
                return token.as_str().to_string();
            };
            let field = previous.and_then(|(end, kind)| {
                (input[end..token.start()].trim() == ":")
                    .then_some(kind)
                    .flatten()
            });
            previous = input[token.end()..].trim_start().starts_with(':').then(|| {
                let kind = if value.eq_ignore_ascii_case("x-api-key") {
                    Some("x-api-key")
                } else if SENSITIVE_FIELD.is_match(&value) {
                    Some("env")
                } else {
                    None
                };
                (token.end(), kind)
            });
            let clean = match field {
                Some(kind) if !value.is_empty() && !MARKER.is_match(&value) => {
                    format!("[redacted:{kind}]")
                }
                _ => redact_secrets(&value),
            };
            if clean == value {
                token.as_str().to_string()
            } else {
                serde_json::to_string(&clean).expect("JSON string serialization")
            }
        })
        .into_owned();
    for (kind, pattern, prefix) in RULES.iter() {
        clean = pattern
            .replace_all(&clean, |captures: &Captures<'_>| {
                if *prefix && MARKER.is_match(captures[2].trim()) {
                    return captures[0].to_string();
                }
                format!(
                    "{}[redacted:{kind}]",
                    if *prefix { &captures[1] } else { "" }
                )
            })
            .into_owned();
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn shared_log_redaction_policy() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../tools/elpis-claude/test/fixtures/log-secrets.json"
        ))
        .unwrap();
        for (index, fixture) in fixtures.as_array().unwrap().iter().enumerate() {
            let input = fixture["input"].as_str().unwrap();
            let expected = fixture["expected"].as_str().unwrap();
            assert!(redact_secrets(input) == expected, "fixture {index}");
            assert!(
                redact_secrets(expected) == expected,
                "idempotent fixture {index}"
            );
        }
    }
}
