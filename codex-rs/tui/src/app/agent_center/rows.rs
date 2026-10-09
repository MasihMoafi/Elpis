//! Grouped live tasks with shared identity colors and stable title, model, status and age
//! columns. Full titles use the flexible column; the model, then the other metadata, drops at
//! narrow widths.
//! The final cell stays blank inside the full-width selection highlight.

use super::navigation::CenterRow;
use super::render::line;
use super::render::row;
use super::*;
use crate::bottom_pane::selection_style;
use crate::resume_picker::format_relative_time;
use crate::status::format_directory_display;

/// Fits `Claude Opus 5.5`; longer catalog names end in an ellipsis.
const MODEL_WIDTH: u16 = 18;

struct Columns {
    title: Rect,
    model: Rect,
    status: Rect,
    updated: Rect,
}

/// Keep model names visible on narrow terminals by sharing the flexible title space.
fn columns(area: Rect) -> Columns {
    let metadata = if area.width >= 56 { 24 } else { 0 };
    let gutter = area.width.min(/*other*/ 4);
    let flexible = area.width - gutter - metadata;
    let model_width = if area.width >= 32 {
        MODEL_WIDTH.min(flexible.saturating_sub(2) / 2)
    } else {
        0
    };
    let model = if model_width > 0 { model_width + 2 } else { 0 };
    let title = Rect::new(
        area.x + gutter,
        area.y,
        area.width - gutter - metadata - model,
        area.height,
    );
    let updated = Rect::new(
        area.right() - metadata.min(/*other*/ 9),
        area.y,
        metadata.min(/*other*/ 9),
        area.height,
    );
    let status = Rect::new(
        title.right() + metadata.min(/*other*/ 2) + model,
        area.y,
        if metadata == 24 { 11 } else { 0 },
        area.height,
    );
    Columns {
        title,
        model: Rect::new(
            title.right() + if model_width > 0 { 2 } else { 0 },
            area.y,
            model_width,
            area.height,
        ),
        status,
        updated,
    }
}

impl AgentsOverviewView {
    pub(super) fn render_center_rows(&self, area: Rect, buf: &mut Buffer) {
        let row_width = area.width;
        let area = Rect {
            width: row_width.saturating_sub(/*rhs*/ 1),
            ..area
        };
        if area.is_empty() {
            return;
        }
        let indices = self.selectable_indices();
        let mut state = self.state();
        if indices.is_empty() {
            line(
                if state.connection_notice.is_some() {
                    "Reconnecting…"
                } else if state.loading && self.rows.is_empty() {
                    "Loading tasks…"
                } else if state.refresh_failed {
                    "Could not load tasks"
                } else if self.rows.is_empty() {
                    "No tasks yet"
                } else {
                    "No matching tasks"
                }
                .dim(),
                area,
                buf,
            );
            return;
        }
        let entries = self.center_rows(&indices, state.grouping);
        let selected = entries
            .iter()
            .position(|row| match row {
                CenterRow::Task(index) => *index == self.selected,
                CenterRow::ShowMore => self.selected == usize::MAX,
                _ => false,
            })
            .unwrap_or_default();
        let padding = u16::from(area.height >= 3);
        let viewport = row(area, padding, area.height - padding * 2);
        if padding > 0 {
            let columns = columns(row(area, /*offset*/ 0, /*height*/ 1));
            line("Tasks".dim(), columns.title, buf);
            line("Model".dim(), columns.model, buf);
            line("Status".dim(), columns.status, buf);
            Line::from("Updated".dim())
                .right_aligned()
                .render(columns.updated, buf);
        }
        let reference = chrono::Utc::now();
        let height = usize::from(viewport.height);
        state.page_height = height;
        let mut start = state.scroll.min(entries.len().saturating_sub(height));
        if selected < start {
            start = if height > 1
                && selected > 0
                && matches!(entries[selected - 1], CenterRow::Group(_))
            {
                selected - 1
            } else {
                selected
            };
        }
        if selected >= start + height {
            start = selected.saturating_add(/*rhs*/ 1).saturating_sub(height);
        }
        state.scroll = start;
        for (offset, entry) in entries.iter().skip(start).take(height).enumerate() {
            let index = match entry {
                CenterRow::Group(index) | CenterRow::Task(index) => *index,
                CenterRow::Gap => continue,
                CenterRow::ShowMore => {
                    let rect = row(viewport, offset as u16, /*height*/ 1);
                    let selected = self.selected == usize::MAX;
                    let style = if selected {
                        selection_style()
                    } else {
                        Style::default()
                    };
                    buf.set_style(
                        Rect {
                            width: row_width,
                            ..rect
                        },
                        style,
                    );
                    let label = if state.loading {
                        "Loading more…"
                    } else if state.refresh_failed {
                        "Show more (retry)"
                    } else {
                        "Show more"
                    };
                    let marker = if selected { "›" } else { " " };
                    line(
                        Line::from(format!("{marker}   {label}")).style(style),
                        rect,
                        buf,
                    );
                    continue;
                }
            };
            let task = &self.rows[index];
            let rect = row(viewport, offset as u16, /*height*/ 1);
            if matches!(entry, CenterRow::Group(_)) {
                let group = if self.is_pinned(index) {
                    "Pinned".to_owned()
                } else {
                    match state.grouping {
                        AgentsOverviewGrouping::Project => {
                            format_directory_display(
                                &self.project_groups[index].heading,
                                /*max_width*/ None,
                            )
                        }
                        AgentsOverviewGrouping::Status => task.group.label().to_owned(),
                        AgentsOverviewGrouping::Model => task.model_display_name().to_owned(),
                    }
                };
                let count = indices
                    .iter()
                    .filter(|&&candidate| {
                        candidate != usize::MAX && self.same_group(state.grouping, candidate, index)
                    })
                    .count();
                let total = (0..self.rows.len())
                    .filter(|&candidate| self.same_group(state.grouping, candidate, index))
                    .count();
                let count = if count == total {
                    count.to_string()
                } else {
                    format!("{count} of {total}")
                };
                let group = if state.grouping == AgentsOverviewGrouping::Project
                    && !self.is_pinned(index)
                {
                    crate::text_formatting::center_truncate_path(
                        &group,
                        usize::from(rect.width)
                            .saturating_sub(count.width() + 2)
                            .min(/*other*/ 64),
                    )
                } else {
                    group
                };
                line(format!("{group}  {count}").dim(), rect, buf);
                continue;
            }
            let style = if index == self.selected {
                selection_style()
            } else {
                Style::default()
            };
            buf.set_style(
                Rect {
                    width: row_width,
                    ..rect
                },
                style,
            );
            let (status, mut dot) = Self::status(task);
            if index == self.selected {
                dot.style = style;
            }
            line(
                Line::from(if index == self.selected { "›" } else { " " }).style(style),
                rect,
                buf,
            );
            line(
                Line::from(dot),
                Rect::new(
                    rect.x + rect.width.min(/*other*/ 2),
                    rect.y,
                    rect.width.saturating_sub(/*rhs*/ 2).min(/*other*/ 1),
                    /*height*/ 1,
                ),
                buf,
            );
            let Columns {
                mut title,
                model,
                status: status_area,
                updated,
            } = columns(rect);
            if task.has_voice && title.width >= 8 {
                let badge = Rect::new(
                    title.right() - 8,
                    title.y,
                    /*width*/ 8,
                    /*height*/ 1,
                );
                title.width -= 8;
                line(Line::from("  voice").style(style), badge, buf);
            }
            let title_style = if index == self.selected {
                style
            } else {
                self.title_style(task.thread_id)
            };
            line(
                Line::from(display_title(&task.thread).to_owned()).style(title_style),
                title,
                buf,
            );
            line(
                Line::from(task.model_display_name().to_owned()).style(style),
                model,
                buf,
            );
            line(Line::from(status).style(style), status_area, buf);
            if !updated.is_empty() {
                let age = format_relative_time(
                    reference,
                    chrono::DateTime::from_timestamp(task.thread.updated_at, /*nsecs*/ 0),
                );
                Line::from(age)
                    .style(if index == self.selected {
                        style
                    } else {
                        style.dim()
                    })
                    .right_aligned()
                    .render(updated, buf);
            }
        }
        if padding > 0 && start > 0 {
            line("↑".dim(), row(area, /*offset*/ 0, /*height*/ 1), buf);
        }
        if padding > 0 && start + height < entries.len() {
            line(
                "↓".dim(),
                row(
                    area,
                    area.height.saturating_sub(/*rhs*/ 1),
                    /*height*/ 1,
                ),
                buf,
            );
        }
    }
}
