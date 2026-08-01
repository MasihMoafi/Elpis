// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use codex_core_skills::model::SkillMetadata;
use codex_protocol::protocol::SkillScope;
use codex_utils_fuzzy_match::fuzzy_match;
use std::collections::HashMap;
use std::collections::HashSet;

/// Skill names that appear more than once across the given list — e.g. a bundled
/// skill and a same-named personal one. Used to qualify only the names that would
/// otherwise be indistinguishable in a picker; a name that appears once is untouched.
pub(crate) fn skill_name_collisions<'a>(
    skills: impl IntoIterator<Item = &'a SkillMetadata>,
) -> HashSet<String> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for skill in skills {
        *counts.entry(skill.name.as_str()).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(name, _)| name.to_string())
        .collect()
}

fn skill_scope_label(scope: SkillScope) -> &'static str {
    match scope {
        SkillScope::User => "yours",
        SkillScope::System => "bundled",
        SkillScope::Repo => "repo",
        SkillScope::Admin => "admin",
    }
}

pub(crate) fn skill_display_name(
    skill: &SkillMetadata,
    colliding_names: &HashSet<String>,
) -> String {
    let qualifier = colliding_names
        .contains(&skill.name)
        .then(|| format!(" ({})", skill_scope_label(skill.scope)))
        .unwrap_or_default();

    if let Some(display_name) = skill
        .interface
        .as_ref()
        .and_then(|interface| interface.display_name.as_deref())
    {
        return format!("{display_name}{qualifier}");
    }

    if let Some((plugin_name, skill_name)) = skill.name.split_once(':')
        && !plugin_name.is_empty()
        && !skill_name.is_empty()
    {
        return format!("{skill_name} ({plugin_name})");
    }

    format!("{}{qualifier}", skill.name)
}

pub(crate) fn skill_description(skill: &SkillMetadata) -> &str {
    skill
        .interface
        .as_ref()
        .and_then(|interface| interface.short_description.as_deref())
        .or(skill.short_description.as_deref())
        .unwrap_or(&skill.description)
}

pub(crate) fn match_skill(
    filter: &str,
    display_name: &str,
    skill_name: &str,
) -> Option<(Option<Vec<usize>>, i32)> {
    if let Some((indices, score)) = fuzzy_match(display_name, filter) {
        return Some((Some(indices), score));
    }
    if display_name != skill_name
        && let Some((_indices, score)) = fuzzy_match(skill_name, filter)
    {
        return Some((None, score));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::PathBufExt;
    use crate::test_support::test_path_buf;

    fn skill(name: &str, scope: SkillScope) -> SkillMetadata {
        SkillMetadata {
            name: name.to_string(),
            description: "Example skill used in tests.".to_string(),
            short_description: None,
            interface: None,
            dependencies: None,
            policy: None,
            path_to_skills_md: test_path_buf(&format!("/tmp/{name}/SKILL.md")).abs(),
            scope,
            plugin_id: None,
        }
    }

    #[test]
    fn same_named_skills_from_different_scopes_get_a_scope_qualifier() {
        let skills = vec![
            skill("skill-creator", SkillScope::System),
            skill("skill-creator", SkillScope::User),
            skill("doc-style", SkillScope::User),
        ];
        let colliding = skill_name_collisions(&skills);

        assert_eq!(
            skill_display_name(&skills[0], &colliding),
            "skill-creator (bundled)"
        );
        assert_eq!(
            skill_display_name(&skills[1], &colliding),
            "skill-creator (yours)"
        );
        // A name with no collision keeps its plain form, unchanged from before
        // cross-scope disambiguation existed.
        assert_eq!(skill_display_name(&skills[2], &colliding), "doc-style");
    }
}
