//! Chat-scoped Smart Prune history, using the shared picker and pager.

use ratatui::style::Stylize;
use ratatui::text::Line;

use super::ChatWidget;
use crate::app_event::AppEvent;
use crate::bottom_pane::SelectionItem;
use crate::bottom_pane::SelectionViewParams;
use crate::bottom_pane::popup_consts::standard_popup_hint_line;
use crate::elpis_app_event::ElpisAppEvent;
use crate::history_cell::HistoryCell;
use crate::legacy_core::smart_prune_log::PruneLogRecord;
use crate::pager_overlay::Overlay;
use crate::pager_overlay::escape_first_pager_keymap;

pub(crate) const LOG_VIEW_ID: &str = "smart-prune-log";
pub(crate) const GLOBAL_LOG_VIEW_ID: &str = "smart-prune-global-log";

pub(crate) fn record_overlay(
    record: &PruneLogRecord,
    diffs: Vec<Option<String>>,
    keymap: &crate::keymap::PagerKeymap,
) -> Overlay {
    Overlay::new_static_with_renderables(
        vec![Box::new(ComparisonCell {
            record: record.clone(),
            diffs,
        })],
        "Smart Prune record".to_string(),
        escape_first_pager_keymap(keymap),
    )
}

#[cfg(test)]
pub(crate) fn record_lines(record: &PruneLogRecord) -> Vec<Line<'static>> {
    let diffs = record
        .items
        .iter()
        .map(|item| item.diff())
        .collect::<Vec<_>>();
    record_lines_with_diffs(record, &diffs)
}

fn record_lines_with_diffs(
    record: &PruneLogRecord,
    diffs: &[Option<String>],
) -> Vec<Line<'static>> {
    let summary = crate::legacy_core::smart_prune_log::PruneLogSummary::from(record);
    let mut lines = vec![safe_text(&record.heading()).bold().into(), Line::default()];
    if let Some(note) = &record.note {
        lines.push(safe_text(note).dim().into());
        lines.push(Line::default());
    }
    for (item, diff) in record.items.iter().zip(diffs) {
        lines.push(safe_text(&item.description).bold().into());
        if summary.estimated_saved_tokens.is_some() {
            lines.push(
                format!(
                    "~{} → ~{} tokens · {}",
                    item.source_tokens,
                    item.admitted_tokens,
                    safe_text(&item.decision)
                )
                .into(),
            );
        } else {
            lines.push(safe_text(&item.decision).into());
        }
        if let Some(compact) = &item.compact {
            lines.push(Line::styled(
                "Compact output received by the main model",
                crate::style::section_style(),
            ));
            lines.extend(compact.split('\n').map(|line| Line::from(safe_text(line))));
        } else {
            lines.push("No compact output recorded.".dim().into());
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
        if let Some(diff) = diff {
            lines.push(Line::styled(
                "Changes (original → compact)",
                crate::style::section_style(),
            ));
            lines.extend(diff.split('\n').map(|line| Line::from(safe_text(line))));
        } else if item.compact.is_some() {
            lines.push("Text changes unavailable for this record.".dim().into());
        }
        lines.push(Line::default());
    }
    lines.push(
        match (
            summary.estimated_source_tokens,
            summary.estimated_saved_tokens,
        ) {
            (Some(before), Some(saved)) => {
                let share = if before == 0 {
                    0.0
                } else {
                    saved as f64 * 100.0 / before as f64
                };
                format!("Estimated: saved {saved} of {before} tokens ({share:.1}%)")
                    .bold()
                    .into()
            }
            _ => "Estimated savings unavailable".dim().into(),
        },
    );
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
        self.smart_prune_detail_request = None;
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
        request_id: uuid::Uuid,
        records: Vec<PruneLogRecord>,
        unreadable: usize,
    ) -> SelectionViewParams {
        let initial_selected_idx = records.len().checked_sub(1).map(|index| index + 1);
        let empty = records.is_empty();
        let mut items: Vec<SelectionItem> = records
            .into_iter()
            .map(|record| {
                let summary = crate::legacy_core::smart_prune_log::PruneLogSummary::from(&record);
                let savings = summary.estimated_saved_tokens.map_or_else(
                    || "Savings unavailable".to_string(),
                    |saved| format!("~{saved} tokens saved"),
                );
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
                        savings,
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
        items.insert(
            0,
            SelectionItem {
                name: "All chats…".to_string(),
                description: Some("Browse Smart Prune evidence across chats".to_string()),
                actions: vec![Box::new(move |tx| {
                    tx.send(AppEvent::Elpis(ElpisAppEvent::OpenGlobalSmartPruneLog(
                        request_id, None,
                    )));
                })],
                dismiss_on_select: false,
                ..Default::default()
            },
        );
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
            Ok((records, unreadable)) => {
                Self::smart_prune_log_params(request_id, records, unreadable)
            }
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

    pub(crate) fn open_global_smart_prune_log(&mut self, cursor: Option<String>) {
        let request_id = uuid::Uuid::new_v4();
        self.smart_prune_log_request = Some(request_id);
        self.smart_prune_detail_request = None;
        let params = SelectionViewParams {
            view_id: Some(GLOBAL_LOG_VIEW_ID),
            title: Some("Smart Prune log · All chats".to_string()),
            subtitle: Some("Loading attempts…".to_string()),
            footer_hint: Some(standard_popup_hint_line()),
            ..Default::default()
        };
        match self.bottom_pane.active_view_id() {
            Some(LOG_VIEW_ID) => {
                self.bottom_pane
                    .replace_selection_view_if_active(LOG_VIEW_ID, params);
            }
            Some(GLOBAL_LOG_VIEW_ID) => {
                self.bottom_pane
                    .replace_selection_view_if_active(GLOBAL_LOG_VIEW_ID, params);
            }
            _ => self.bottom_pane.show_selection_view(params),
        }
        self.app_event_tx
            .send(AppEvent::Elpis(ElpisAppEvent::LoadGlobalSmartPruneLog(
                request_id, cursor,
            )));
    }

    pub(crate) fn global_smart_prune_log_is_current(&self, request_id: uuid::Uuid) -> bool {
        self.smart_prune_log_request == Some(request_id)
            && self.bottom_pane.active_view_id() == Some(GLOBAL_LOG_VIEW_ID)
    }

    pub(crate) fn smart_prune_picker_is_current(&self, request_id: uuid::Uuid) -> bool {
        self.smart_prune_log_request == Some(request_id)
            && matches!(
                self.bottom_pane.active_view_id(),
                Some(LOG_VIEW_ID | GLOBAL_LOG_VIEW_ID)
            )
    }

    pub(crate) fn begin_global_smart_prune_detail(
        &mut self,
        request_id: uuid::Uuid,
    ) -> Option<uuid::Uuid> {
        if !self.global_smart_prune_log_is_current(request_id) {
            return None;
        }
        let detail_id = uuid::Uuid::new_v4();
        self.smart_prune_detail_request = Some(detail_id);
        Some(detail_id)
    }

    pub(crate) fn begin_local_smart_prune_detail(&mut self) -> (uuid::Uuid, Option<uuid::Uuid>) {
        let detail_id = uuid::Uuid::new_v4();
        self.smart_prune_detail_request = Some(detail_id);
        let picker = (self.bottom_pane.active_view_id() == Some(LOG_VIEW_ID))
            .then_some(self.smart_prune_log_request)
            .flatten();
        (detail_id, picker)
    }

    pub(crate) fn local_smart_prune_detail_is_current(
        &self,
        detail_id: uuid::Uuid,
        picker: Option<uuid::Uuid>,
    ) -> bool {
        self.smart_prune_detail_request == Some(detail_id)
            && picker.is_none_or(|request_id| {
                self.smart_prune_log_request == Some(request_id)
                    && self.bottom_pane.active_view_id() == Some(LOG_VIEW_ID)
            })
    }

    pub(crate) fn global_smart_prune_detail_is_current(
        &self,
        request_id: uuid::Uuid,
        detail_id: uuid::Uuid,
    ) -> bool {
        self.global_smart_prune_log_is_current(request_id)
            && self.smart_prune_detail_request == Some(detail_id)
    }

    pub(crate) fn finish_global_smart_prune_log(
        &mut self,
        request_id: uuid::Uuid,
        result: Result<crate::legacy_core::smart_prune_log::PruneLogPage, String>,
    ) {
        if !self.global_smart_prune_log_is_current(request_id) {
            return;
        }
        let params = match result {
            Ok(page) => {
                let empty = page.data.is_empty();
                let mut items: Vec<SelectionItem> = page
                    .data
                    .into_iter()
                    .map(|record| {
                        let saved = record.estimated_saved_tokens.map_or_else(
                            || "Savings unavailable".to_string(),
                            |n| format!("~{n} tokens saved"),
                        );
                        let attempt_id = record.attempt_id.clone();
                        let thread_id = record.thread_id.clone();
                        SelectionItem {
                            name: format!(
                                "{} · {}",
                                safe_text(&record.timestamp),
                                safe_text(&record.chat_title)
                            ),
                            description: Some(format!("{} · {}", saved, safe_text(&record.model))),
                            search_value: Some(format!(
                                "{} {} {}",
                                record.chat_title, record.thread_id, record.model
                            )),
                            actions: vec![Box::new(move |tx| {
                                tx.send(AppEvent::Elpis(
                                    ElpisAppEvent::ReadGlobalSmartPruneRecord(
                                        request_id,
                                        attempt_id.clone(),
                                        thread_id.clone(),
                                    ),
                                ));
                            })],
                            dismiss_on_select: false,
                            ..Default::default()
                        }
                    })
                    .collect();
                if let Some(cursor) = page.next_cursor {
                    items.push(SelectionItem {
                        name: "Next page…".to_string(),
                        actions: vec![Box::new(move |tx| {
                            tx.send(AppEvent::Elpis(ElpisAppEvent::OpenGlobalSmartPruneLog(
                                request_id,
                                Some(cursor.clone()),
                            )));
                        })],
                        dismiss_on_select: false,
                        ..Default::default()
                    });
                }
                SelectionViewParams {
                    view_id: Some(GLOBAL_LOG_VIEW_ID),
                    title: Some("Smart Prune log · All chats".to_string()),
                    subtitle: Some(
                        if empty {
                            "No pruning attempts found."
                        } else {
                            "All chats · newest first · Enter opens the evidence"
                        }
                        .to_string(),
                    ),
                    items,
                    is_searchable: true,
                    max_visible_rows: 12,
                    footer_note: (page.unreadable > 0).then(|| {
                        format!("{} unreadable audit record(s) skipped.", page.unreadable).into()
                    }),
                    footer_hint: Some(standard_popup_hint_line()),
                    ..Default::default()
                }
            }
            Err(error) => SelectionViewParams {
                view_id: Some(GLOBAL_LOG_VIEW_ID),
                title: Some("Smart Prune log · All chats".to_string()),
                subtitle: Some(format!("Cannot read pruning evidence: {error}")),
                ..Default::default()
            },
        };
        self.bottom_pane
            .replace_selection_view_if_active(GLOBAL_LOG_VIEW_ID, params);
    }
}

pub(crate) const INLINE_LINK_PREFIX: &str = "https://elpis.invalid/smart-prune/";

#[derive(Debug)]
pub(crate) struct SmartPruneCell(pub(crate) codex_protocol::elpis_smart_prune::SmartPruneEvent);

impl crate::history_cell::HistoryCell for SmartPruneCell {
    fn display_lines(&self, _width: u16) -> Vec<Line<'static>> {
        vec![Line::from(safe_text(&self.0.summary()).dim())]
    }
    fn raw_lines(&self) -> Vec<Line<'static>> {
        self.display_lines(u16::MAX)
    }
    fn display_hyperlink_lines(
        &self,
        _width: u16,
    ) -> Vec<crate::terminal_hyperlinks::HyperlinkLine> {
        let mut line = crate::terminal_hyperlinks::HyperlinkLine::new(Line::default());
        let url = format!(
            "{INLINE_LINK_PREFIX}{}/{}",
            urlencoding::encode(&self.0.attempt_id),
            urlencoding::encode(&self.0.call_id)
        );
        line.push_span(safe_text(&self.0.summary()).dim(), Some(&url));
        vec![line]
    }
}

#[derive(Debug)]
struct ComparisonCell {
    record: PruneLogRecord,
    diffs: Vec<Option<String>>,
}
impl crate::render::renderable::Renderable for ComparisonCell {
    fn render(&self, area: ratatui::layout::Rect, buf: &mut ratatui::buffer::Buffer) {
        use ratatui::widgets::Widget;
        ratatui::widgets::Paragraph::new(comparison_lines(&self.record, &self.diffs, area.width))
            .wrap(ratatui::widgets::Wrap { trim: false })
            .render(area, buf);
    }
    fn desired_height(&self, width: u16) -> u16 {
        ratatui::widgets::Paragraph::new(comparison_lines(&self.record, &self.diffs, width))
            .wrap(ratatui::widgets::Wrap { trim: false })
            .line_count(width)
            .try_into()
            .unwrap_or(u16::MAX)
    }
}

fn comparison_lines(
    record: &PruneLogRecord,
    diffs: &[Option<String>],
    width: u16,
) -> Vec<Line<'static>> {
    if width < 60 {
        return record_lines_with_diffs(record, diffs);
    }
    let column = usize::from(width.saturating_sub(3)) / 2;
    let wrap = |text: &str| -> Vec<String> {
        text.split('\n')
            .flat_map(|line| {
                textwrap::wrap(&safe_text(line), column)
                    .into_iter()
                    .map(std::borrow::Cow::into_owned)
                    .collect::<Vec<_>>()
            })
            .collect()
    };
    let summary = crate::legacy_core::smart_prune_log::PruneLogSummary::from(record);
    let total = match (
        summary.estimated_source_tokens,
        summary.estimated_saved_tokens,
    ) {
        (Some(before), Some(saved)) => {
            let share = if before == 0 {
                0.0
            } else {
                saved as f64 * 100.0 / before as f64
            };
            format!("Estimated: saved {saved} of {before} tokens ({share:.1}%)")
        }
        _ => "Estimated savings unavailable".to_string(),
    };
    let mut lines = vec![
        safe_text(&record.heading()).bold().into(),
        total.bold().into(),
    ];
    if let Some(note) = &record.note {
        lines.push(safe_text(note).dim().into());
    }
    for (item, diff) in record.items.iter().zip(diffs) {
        lines.push(Line::default());
        lines.push(safe_text(&item.description).bold().into());
        lines.push(safe_text(&item.decision).dim().into());
        let original_label = if summary.estimated_source_tokens.is_some() {
            format!("Original output (~{} tokens)", item.source_tokens)
        } else {
            "Original output".to_string()
        };
        let compact_label = if summary.estimated_admitted_tokens.is_some() {
            format!("Compact output (~{} tokens)", item.admitted_tokens)
        } else {
            "Compact output".to_string()
        };
        let original = wrap(&format!("{original_label}\n{}", item.original));
        let compact = wrap(&format!(
            "{compact_label}\n{}",
            item.compact
                .as_deref()
                .unwrap_or("No compact output recorded.")
        ));
        for index in 0..original.len().max(compact.len()) {
            let left = original.get(index).map(String::as_str).unwrap_or("");
            let right = compact.get(index).map(String::as_str).unwrap_or("");
            let pad = column.saturating_sub(crate::width::display_width(left));
            lines.push(format!("{left}{} │ {right}", " ".repeat(pad)).into());
        }
        if let Some(diff) = diff {
            lines.push("Changes (original → compact)".bold().into());
            lines.extend(diff.split('\n').map(|line| Line::from(safe_text(line))));
        } else if item.compact.is_some() {
            lines.push("Text changes unavailable for this record.".dim().into());
        }
    }
    lines.push(safe_text(&record.identifiers()).dim().into());
    lines
}

impl ChatWidget {
    pub(crate) fn on_smart_prune(
        &mut self,
        prune: codex_protocol::elpis_smart_prune::SmartPruneEvent,
    ) {
        self.flush_active_cell();
        self.add_to_history(SmartPruneCell(prune));
    }
}

/// Attach a late batch decision to the retained call rather than the newest sibling.
pub(crate) fn attach_to_tool(
    cells: &mut [std::sync::Arc<dyn crate::history_cell::HistoryCell>],
    prune: &codex_protocol::elpis_smart_prune::SmartPruneEvent,
) -> bool {
    let Some(cell) = cells.iter_mut().rev().find(|cell| {
        cell.activity_ids().iter().any(|id| {
            id.split_once(':')
                .is_some_and(|(_, call)| call == prune.call_id)
        })
    }) else {
        return false;
    };
    let (inner, mut rows) = if let Some(attached) = cell.as_any().downcast_ref::<PrunedToolCell>() {
        (attached.inner.clone(), attached.rows.clone())
    } else {
        (cell.clone(), Vec::new())
    };
    if !rows.iter().any(|row| row.item_id() == prune.item_id()) {
        rows.push(prune.clone());
    }
    *cell = std::sync::Arc::new(PrunedToolCell { inner, rows });
    true
}

#[derive(Debug)]
struct PrunedToolCell {
    inner: std::sync::Arc<dyn crate::history_cell::HistoryCell>,
    rows: Vec<codex_protocol::elpis_smart_prune::SmartPruneEvent>,
}
impl PrunedToolCell {
    fn rows(&self, width: u16) -> Vec<crate::terminal_hyperlinks::HyperlinkLine> {
        self.rows
            .iter()
            .flat_map(|prune| SmartPruneCell(prune.clone()).display_hyperlink_lines(width))
            .collect()
    }

    fn exec_lines(
        &self,
        width: u16,
        mode: crate::history_cell::HistoryRenderMode,
    ) -> Option<Vec<crate::terminal_hyperlinks::HyperlinkLine>> {
        let exec = self
            .inner
            .as_any()
            .downcast_ref::<crate::exec_cell::ExecCell>()?;
        let rows = self
            .rows
            .iter()
            .map(|prune| {
                (
                    prune.call_id.clone(),
                    SmartPruneCell(prune.clone()).display_hyperlink_lines(width),
                )
            })
            .collect::<Vec<_>>();
        Some(exec.detailed_lines_with_prunes(width, mode, &rows))
    }
}
impl crate::history_cell::HistoryCell for PrunedToolCell {
    fn activity_ids(&self) -> Vec<String> {
        self.inner.activity_ids()
    }
    fn activity_disclosure(&self, width: u16) -> Option<crate::history_cell::ActivityDisclosure> {
        self.inner.activity_disclosure(width)
    }
    fn compact_hyperlink_lines(
        &self,
        width: u16,
    ) -> Vec<crate::terminal_hyperlinks::HyperlinkLine> {
        let mut lines = self.inner.compact_hyperlink_lines(width);
        lines.extend(self.rows(width));
        lines
    }
    fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
        crate::terminal_hyperlinks::visible_lines(self.display_hyperlink_lines(width))
    }
    fn display_hyperlink_lines(
        &self,
        width: u16,
    ) -> Vec<crate::terminal_hyperlinks::HyperlinkLine> {
        let mut lines = self.inner.display_hyperlink_lines(width);
        lines.extend(self.rows(width));
        lines
    }
    fn transcript_hyperlink_lines(
        &self,
        width: u16,
    ) -> Vec<crate::terminal_hyperlinks::HyperlinkLine> {
        if let Some(lines) = self.exec_lines(width, crate::history_cell::HistoryRenderMode::Rich) {
            return lines;
        }
        let mut lines = self.inner.transcript_hyperlink_lines(width);
        lines.extend(self.rows(width));
        lines
    }
    fn raw_lines(&self) -> Vec<Line<'static>> {
        if let Some(lines) = self.exec_lines(u16::MAX, crate::history_cell::HistoryRenderMode::Raw)
        {
            return crate::history_cell::plain_lines(crate::terminal_hyperlinks::visible_lines(
                lines,
            ));
        }
        let mut lines = self.inner.raw_lines();
        lines.extend(
            self.rows
                .iter()
                .flat_map(|prune| SmartPruneCell(prune.clone()).raw_lines()),
        );
        lines
    }
}
