//! Skill-related configuration types shared across crates.

use std::collections::HashSet;
use std::num::NonZeroUsize;

use crate::ConfigLayerSource;
use crate::ConfigLayerStack;
use codex_utils_absolute_path::AbsolutePathBuf;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use tracing::warn;

const fn default_enabled() -> bool {
    true
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct SkillConfig {
    /// Path-based selector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<AbsolutePathBuf>,
    /// Name-based selector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct SkillsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled: Option<BundledSkillsConfig>,

    /// Whether turns receive the automatic skills instructions block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_instructions: Option<bool>,

    /// Elpis: whether discovered skills are enabled before any `[[skills.config]]` rule.
    /// Elpis sets `false` so only skills the user turns on reach the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_enabled: Option<bool>,

    /// Elpis: more directories whose immediate children hold `SKILL.md` files (v0.3.0), such as
    /// the skills a user chose outside `~/.agents/skills`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_roots: Vec<AbsolutePathBuf>,

    /// Elpis: ordered roots of the development-rule Markdown files listed in the Context Ledger.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dev_rule_roots: Vec<AbsolutePathBuf>,

    /// Maximum tokens used by the available-skills catalog. Defaults to 2% of
    /// the model context window and is capped at 10,000 tokens when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<NonZeroUsize>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub config: Vec<SkillConfig>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct BundledSkillsConfig {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

impl Default for BundledSkillsConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl TryFrom<toml::Value> for SkillsConfig {
    type Error = toml::de::Error;

    fn try_from(value: toml::Value) -> Result<Self, Self::Error> {
        SkillsConfig::deserialize(value)
    }
}

/// Selects configured skills by their name or canonical document path.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SkillConfigRuleSelector {
    Name(String),
    Path(AbsolutePathBuf),
    /// Elpis: every discovered skill (`[skills] default_enabled`).
    All,
}

/// Enables or disables every skill matched by its selector.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SkillConfigRule {
    pub selector: SkillConfigRuleSelector,
    pub enabled: bool,
}

/// Ordered effective skill enablement rules from configuration layers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct SkillConfigRules {
    pub entries: Vec<SkillConfigRule>,
}

impl SkillConfigRules {
    /// Applies rules in order; later rules override earlier rules for matching skills.
    ///
    /// Explicit path selectors remain effective even when no current skill matches.
    pub fn resolve_disabled_paths<'a>(
        &self,
        skills: impl IntoIterator<Item = (&'a str, &'a AbsolutePathBuf)> + Clone,
    ) -> HashSet<AbsolutePathBuf> {
        let mut disabled_paths = HashSet::new();

        for entry in &self.entries {
            match &entry.selector {
                SkillConfigRuleSelector::Path(path) => {
                    if entry.enabled {
                        disabled_paths.remove(path);
                    } else {
                        disabled_paths.insert(path.clone());
                    }
                }
                SkillConfigRuleSelector::All => {
                    for (_, path) in skills.clone() {
                        if entry.enabled {
                            disabled_paths.remove(path);
                        } else {
                            disabled_paths.insert(path.clone());
                        }
                    }
                }
                SkillConfigRuleSelector::Name(name) => {
                    for (skill_name, path) in skills.clone() {
                        if skill_name != name {
                            continue;
                        }
                        if entry.enabled {
                            disabled_paths.remove(path);
                        } else {
                            disabled_paths.insert(path.clone());
                        }
                    }
                }
            }
        }

        disabled_paths
    }
}

/// Returns whether bundled skills are enabled by the effective configuration.
pub fn bundled_skills_enabled_from_stack(config_layer_stack: &ConfigLayerStack) -> bool {
    let effective_config = config_layer_stack.effective_config();
    let Some(skills_value) = effective_config
        .as_table()
        .and_then(|table| table.get("skills"))
    else {
        return true;
    };

    let skills: SkillsConfig = match skills_value.clone().try_into() {
        Ok(skills) => skills,
        Err(err) => {
            warn!("invalid skills config: {err}");
            return true;
        }
    };

    skills.bundled.unwrap_or_default().enabled
}

fn skills_default_enabled_from_stack(config_layer_stack: &ConfigLayerStack) -> Option<bool> {
    let skills = config_layer_stack
        .effective_config()
        .as_table()?
        .get("skills")?
        .clone();
    match SkillsConfig::try_from(skills) {
        Ok(skills) => skills.default_enabled,
        Err(err) => {
            warn!("invalid skills config: {err}");
            None
        }
    }
}

/// Elpis: `[skills] dev_rule_roots` from the effective configuration. Empty means the
/// managed fallback: `<home>/skills/dev` plus `ELPIS_DEV_SKILLS_DIRS`.
pub fn dev_rule_roots_from_stack(config_layer_stack: &ConfigLayerStack) -> Vec<AbsolutePathBuf> {
    let effective_config = config_layer_stack.effective_config();
    let Some(skills_value) = effective_config
        .as_table()
        .and_then(|table| table.get("skills"))
    else {
        return Vec::new();
    };
    match SkillsConfig::try_from(skills_value.clone()) {
        Ok(skills) => skills.dev_rule_roots,
        Err(err) => {
            warn!("invalid skills config: {err}");
            Vec::new()
        }
    }
}

/// Resolves skill enablement rules from user and session configuration layers.
pub fn skill_config_rules_from_stack(config_layer_stack: &ConfigLayerStack) -> SkillConfigRules {
    let mut entries = Vec::new();
    // Elpis: a default off rule comes first, so every per-skill rule overrides it.
    if skills_default_enabled_from_stack(config_layer_stack) == Some(false) {
        entries.push(SkillConfigRule {
            selector: SkillConfigRuleSelector::All,
            enabled: false,
        });
    }
    for layer in config_layer_stack.all_layers_low_to_high() {
        if !matches!(
            layer.name,
            ConfigLayerSource::User { .. } | ConfigLayerSource::SessionFlags
        ) {
            continue;
        }

        let Some(skills_value) = layer.config.get("skills") else {
            continue;
        };
        let skills: SkillsConfig = match skills_value.clone().try_into() {
            Ok(skills) => skills,
            Err(err) => {
                warn!("invalid skills config: {err}");
                continue;
            }
        };

        for entry in skills.config {
            let Some(selector) = skill_config_rule_selector(&entry) else {
                continue;
            };
            // Preserve layer order so a later name selector can override an earlier path selector
            // for the same loaded skill.
            entries.retain(|entry: &SkillConfigRule| entry.selector != selector);
            entries.push(SkillConfigRule {
                selector,
                enabled: entry.enabled,
            });
        }
    }

    SkillConfigRules { entries }
}

fn skill_config_rule_selector(entry: &SkillConfig) -> Option<SkillConfigRuleSelector> {
    match (entry.path.as_ref(), entry.name.as_deref()) {
        (Some(path), None) => Some(SkillConfigRuleSelector::Path(
            path.canonicalize().unwrap_or_else(|_| path.clone()),
        )),
        (None, Some(name)) => {
            let name = name.trim();
            if name.is_empty() {
                warn!("ignoring empty skills.config name override");
                None
            } else {
                Some(SkillConfigRuleSelector::Name(name.to_string()))
            }
        }
        (Some(_), Some(_)) => {
            warn!("ignoring skills.config entry with both path and name selectors");
            None
        }
        (None, None) => {
            warn!("ignoring skills.config entry without a path or name selector");
            None
        }
    }
}

#[cfg(test)]
#[path = "skills_config_tests.rs"]
mod tests;
