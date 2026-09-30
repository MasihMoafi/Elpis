//! Elpis: the onboarding API-key field shows dots, not the key.
//!
//! A key is a secret on a screen that is often shared or recorded, so it is masked as it is
//! typed. The last four characters stay readable so a paste can be told apart from the wrong one.
//!
//! Copied from Elpis v0.3.0 `onboarding/auth.rs` (`mask_api_key`), tag `stage0-stop-bleeding`.
//! `auth.rs` reaches this module through a seam marked `Elpis:`.

/// Renders a key as dots, keeping the last four characters when the key is long
/// enough that those four do not give it away.
pub(super) fn mask_api_key(value: &str) -> String {
    let visible = 4;
    let count = value.chars().count();
    if count <= visible * 2 {
        return "•".repeat(count);
    }
    let masked = "•".repeat(count - visible);
    let tail: String = value.chars().skip(count - visible).collect();
    format!("{masked}{tail}")
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    #[test]
    fn a_typed_api_key_is_never_shown_in_full() {
        let key = "sk-proj-1234567890abcdef";
        let masked = super::mask_api_key(key);
        assert!(!masked.contains("sk-proj"));
        assert!(masked.ends_with("cdef"));
        assert_eq!(masked.chars().count(), key.chars().count());
        // A short value gives nothing away at all.
        assert_eq!(super::mask_api_key("abcd"), "••••");
    }
}
