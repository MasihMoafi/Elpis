//! Chat-scoped Smart Prune history, using the shared picker and pager.

use ratatui::style::Stylize;
use ratatui::text::Line;

use super::ChatWidget;
use crate::app_event::AppEvent;
use crate::bottom_pane::SelectionItem;
use crate::bottom_pane::SelectionViewParams;
use crate::bottom_pane::popup_consts::standard_popup_hint_line;
use crate::elpis_app_event::ElpisAppEvent;
use crate::legacy_core::smart_prune_log::PruneLogRecord;
use crate::pager_overlay::Overlay;
use crate::pager_overlay::escape_first_pager_keymap;

pub(crate) const LOG_VIEW_ID: &str = "smart-prune-log";

pub(crate) fn record_overlay(
    record: &PruneLogRecord,
    keymap: &crate::keymap::PagerKeymap,
) -> Overlay {
    Overlay::new_static_with_lines(
        record_lines(record),
        "Smart Prune record".to_string(),
        escape_first_pager_keymap(keymap),
    )
}

pub(crate) fn record_lines(record: &PruneLogRecord) -> Vec<Line<'static>> {
    let mut lines = vec![safe_text(&record.heading()).bold().into(), Line::default()];
    if let Some(note) = &record.note {
        lines.push(note.clone().dim().into());
        lines.push(Line::default());
    }
    for item in &record.items {
        lines.push(safe_text(&item.description).bold().into());
        lines.push(
            format!(
                "{} → {} tokens · {}",
                item.source_tokens,
                item.admitted_tokens,
                safe_text(&item.decision)
            )
            .into(),
        );
        if let Some(compact) = &item.compact {
            lines.push(Line::styled(
                "Compact output received by the main model",
                crate::style::section_style(),
            ));
            lines.extend(compact.split('\n').map(|line| Line::from(safe_text(line))));
        } else {
            lines.push("Original kept; no compact version was used.".dim().into());
        }
        lines.push(Line::styled(
            "Original output",
            crate::style::section_style(),
        ));
        lines.extend(
            item.original
                .split('\n')
                .map(|line| Line::from(safe_text(line))),
        );
        lines.push(Line::default());
    }
    lines.push(record.total_line().bold().into());
    lines.push(safe_text(&record.identifiers()).dim().into());
    lines
}

fn safe_text(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ch.is_control() && ch != '\t' {
                '�'
            } else {
                ch
            }
        })
        .collect()
}

impl ChatWidget {
    pub(super) fn open_smart_prune_log(&mut self) {
        let Some(thread_id) = self.thread_id() else {
            self.add_info_message(
                "Smart Prune log is available after this chat starts.".to_string(),
                None,
            );
            return;
        };
        let request_id = uuid::Uuid::new_v4();
        self.smart_prune_log_request = Some(request_id);
        self.bottom_pane.show_selection_view(SelectionViewParams {
            view_id: Some(LOG_VIEW_ID),
            title: Some("Smart Prune log".to_string()),
            subtitle: Some("Loading this chat's attempts…".to_string()),
            footer_hint: Some(standard_popup_hint_line()),
            ..Default::default()
        });
        self.app_event_tx
            .send(AppEvent::Elpis(ElpisAppEvent::LoadSmartPruneLog(
                thread_id, request_id,
            )));
    }

    pub(crate) fn smart_prune_log_params(
        records: Vec<PruneLogRecord>,
        unreadable: usize,
    ) -> SelectionViewParams {
        let initial_selected_idx = records.len().checked_sub(1);
        let empty = records.is_empty();
        let items = records
            .into_iter()
            .map(|record| {
                SelectionItem {
                    name: format!("{} · {}", record.timestamp, record.turn_label()),
                    search_value: Some(format!(
                        "{} {}",
                        record.heading(),
                        record
                            .items
                            .iter()
                            .map(|item| item.description.as_str())
                            .collect::<Vec<_>>()
                            .join(" ")
                    )),
                    description: Some(format!(
                        "{} · {} ({}) · {}",
                        record.total_line(),
                        record.model,
                        record.reasoning_effort,
                        record
                            .items
                            .first()
                            .map(|item| item.description.as_str())
                            .unwrap_or("Details unavailable")
                    )),
                    actions: vec![Box::new(move |tx| {
                        tx.send(AppEvent::Elpis(ElpisAppEvent::OpenSmartPruneRecord(
                            Box::new(record.clone()),
                        )));
                    })],
                    // Leave the history picker underneath the pager so Escape returns here.
                    dismiss_on_select: false,
                    ..Default::default()
                }
            })
            .collect();
        SelectionViewParams {
            view_id: Some(LOG_VIEW_ID),
            title: Some("Smart Prune log".to_string()),
            subtitle: Some(
                if empty {
                    "No pruning attempts in this chat yet."
                } else {
                    "This chat · oldest first · Enter opens original and compact output"
                }
                .to_string(),
            ),
            items,
            initial_selected_idx,
            is_searchable: true,
            max_visible_rows: 12,
            footer_note: (unreadable > 0)
                .then(|| format!("{unreadable} unreadable audit record(s) skipped.").into()),
            footer_hint: Some(standard_popup_hint_line()),
            ..Default::default()
        }
    }

    pub(crate) fn finish_smart_prune_log(
        &mut self,
        request_id: uuid::Uuid,
        records: Result<(Vec<PruneLogRecord>, usize), String>,
    ) {
        if self.smart_prune_log_request != Some(request_id) {
            return;
        }
        let params = match records {
            Ok((records, unreadable)) => Self::smart_prune_log_params(records, unreadable),
            Err(error) => SelectionViewParams {
                view_id: Some(LOG_VIEW_ID),
                title: Some("Smart Prune log".to_string()),
                subtitle: Some(format!("Cannot read pruning evidence: {error}")),
                ..Default::default()
            },
        };
        // A late disk read must not reopen a picker the user already dismissed.
        self.bottom_pane
            .replace_selection_view_if_present(LOG_VIEW_ID, params);
    }
}
