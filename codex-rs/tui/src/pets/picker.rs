//! Builds the `/pets` picker dialog for the TUI.
//!
//! The picker deliberately merges three sources into one list:
//! built-in catalog pets, a synthetic "disable" entry, and user-managed custom
//! pets. It does not load preview images itself; instead it emits selection
//! change events so the surrounding chat widget can coordinate async asset
//! downloads, preview loading, and final config persistence.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::app_event::AppEvent;
use crate::bottom_pane::SelectionAction;
use crate::bottom_pane::SelectionItem;
use crate::bottom_pane::SelectionViewParams;
use crate::bottom_pane::SideContentWidth;
use crate::bottom_pane::popup_consts::standard_popup_hint_line;

use super::DEFAULT_PET_ID;
use super::DISABLED_PET_ID;
use super::catalog;
use super::model::CUSTOM_PET_PREFIX;
use super::model::Pet;
use super::model::custom_pet_selector;
use super::preview::PetPickerPreviewState;

pub(crate) const PET_PICKER_VIEW_ID: &str = "pet-picker";
const PET_PICKER_PREVIEW_WIDTH: u16 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PetPickerEntry {
    selector: String,
    legacy_selector: Option<String>,
    display_name: String,
    description: Option<String>,
}

/// Build the selection popup parameters for `/pets`.
///
/// The picker preselects `DEFAULT_PET_ID` when no pet is configured so the UI
/// has a sensible starting point without implying that Codex is already the
/// active ambient pet. Callers should treat the returned actions as the only
/// supported mutation path; bypassing them would skip preview-loading and
/// selection-specific event wiring.
pub(crate) fn build_pet_picker_params(
    current_pet: Option<&str>,
    codex_home: &Path,
    preview_state: PetPickerPreviewState,
) -> SelectionViewParams {
    let preferred_pet = current_pet.unwrap_or(DEFAULT_PET_ID);
    let mut entries = available_pet_entries(codex_home);
    entries.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    if let Some(disabled_idx) = entries
        .iter()
        .position(|entry| entry.selector == DISABLED_PET_ID)
    {
        let disabled_entry = entries.remove(disabled_idx);
        entries.insert(0, disabled_entry);
    }

    let mut initial_selected_idx = None;
    let preview_pet_ids = entries
        .iter()
        .map(|entry| entry.selector.clone())
        .collect::<Vec<_>>();
    let on_selection_changed: crate::bottom_pane::OnSelectionChangedCallback = Some(Box::new(
        move |idx: usize, tx: &crate::app_event_sender::AppEventSender| {
            if let Some(pet_id) = preview_pet_ids.get(idx) {
                tx.send(AppEvent::PetPreviewRequested {
                    pet_id: pet_id.clone(),
                });
            }
        },
    ));

    let items = entries
        .into_iter()
        .enumerate()
        .map(|(idx, entry)| {
            let is_current = current_pet.is_some_and(|current_pet| {
                current_pet == entry.selector
                    || entry.legacy_selector.as_deref() == Some(current_pet)
            });
            if preferred_pet == entry.selector
                || entry.legacy_selector.as_deref() == Some(preferred_pet)
            {
                initial_selected_idx = Some(idx);
            }
            let pet_id = entry.selector.clone();
            let search_value = if pet_id == DISABLED_PET_ID {
                "disable disabled hide hidden off none".to_string()
            } else {
                entry.selector
            };
            let actions: Vec<SelectionAction> = if pet_id == DISABLED_PET_ID {
                vec![Box::new(|tx| {
                    tx.send(AppEvent::PetDisabled);
                })]
            } else {
                vec![Box::new(move |tx| {
                    tx.send(AppEvent::PetSelected {
                        pet_id: pet_id.clone(),
                    });
                })]
            };
            SelectionItem {
                name: entry.display_name,
                description: entry.description,
                is_current,
                dismiss_on_select: true,
                search_value: Some(search_value),
                actions,
                ..Default::default()
            }
        })
        .collect();

    SelectionViewParams {
        view_id: Some(PET_PICKER_VIEW_ID),
        title: Some("Select Pet".to_string()),
        subtitle: Some("Choose a pet to wake in the terminal.".to_string()),
        footer_hint: Some(standard_popup_hint_line()),
        items,
        is_searchable: true,
        search_placeholder: Some("Type to filter pets...".to_string()),
        initial_selected_idx,
        side_content: Box::new(preview_state.renderable()),
        side_content_width: SideContentWidth::Fixed(PET_PICKER_PREVIEW_WIDTH),
        side_content_min_width: 28,
        stacked_side_content: Some(Box::new(())),
        preserve_side_content_bg: true,
        on_selection_changed,
        ..SelectionViewParams::picker()
    }
}

fn available_pet_entries(codex_home: &Path) -> Vec<PetPickerEntry> {
    let mut entries = catalog::BUILTIN_PETS
        .iter()
        .map(|pet| PetPickerEntry {
            selector: pet.id.to_string(),
            legacy_selector: None,
            display_name: pet.display_name.to_string(),
            description: Some(pet.description.to_string()),
        })
        .collect::<Vec<_>>();
    entries.push(PetPickerEntry {
        selector: DISABLED_PET_ID.to_string(),
        legacy_selector: None,
        display_name: "Disable terminal pets".to_string(),
        description: None,
    });
    entries.extend(custom_pet_entries(codex_home));
    entries
}

fn custom_pet_entries(codex_home: &Path) -> Vec<PetPickerEntry> {
    let mut entries_by_selector = HashMap::new();
    for (directory_name, manifest_file) in [("avatars", "avatar.json"), ("pets", "pet.json")] {
        let Ok(children) = fs::read_dir(codex_home.join(directory_name)) else {
            continue;
        };
        for child in children.flatten() {
            let path = child.path();
            if !path.join(manifest_file).is_file() {
                continue;
            }
            let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if id == DISABLED_PET_ID || id.starts_with(CUSTOM_PET_PREFIX) {
                continue;
            }
            let selector = custom_pet_selector(id);
            let Ok(pet) =
                Pet::load_with_codex_home(&selector, /*codex_home*/ Some(codex_home))
            else {
                continue;
            };
            entries_by_selector.insert(
                selector.clone(),
                PetPickerEntry {
                    selector,
                    legacy_selector: Some(id.to_string()),
                    display_name: pet.display_name,
                    description: (!pet.description.is_empty()).then_some(pet.description),
                },
            );
        }
    }

    entries_by_selector.into_values().collect()
}
