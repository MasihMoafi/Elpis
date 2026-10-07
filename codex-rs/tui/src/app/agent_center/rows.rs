//! Grouped live tasks with stable title, model, status and age columns. Helpers hang under
//! the task that started them; each agent's dot and model share its model's colour.
//! Full titles use the flexible column; the model, then the other metadata, drop at narrow
//! widths. The final cell stays blank inside the full-width selection highlight.

use super::navigation::CenterRow;
use super::render::line;
use super::render::row;
use super::*;
use crate::bottom_pane::selection_style;
use crate::resume_picker::format_relative_time;
use crate::status::format_directory_display;
use std::collections::HashMap;

/// A status glyph and the longest label, `◆ Needs input`.
const STATUS_WIDTH: u16 = 13;
const UPDATED_WIDTH: u16 = 9;
/// Fits `Claude Opus 5.5 · xhigh`; longer labels end in an ellipsis.
const MODEL_WIDTH: u16 = 24;

struct Columns {
    title: Rect,
    model: Rect,
    status: Rect,
    updated: Rect,
}

fn columns(area: Rect) -> Columns {
    let gutter = area.width.min(/*other*/ 4);
    let metadata = area.width >= 56;
    let with_model = area.width >= 80;
    let updated_width = if metadata { UPDATED_WIDTH } else { 0 };
    let status_width = if metadata { STATUS_WIDTH } else { 0 };
    let model_width = if with_model { MODEL_WIDTH } else { 0 };
    let updated = Rect::new(
        area.right() - updated_width,
        area.y,
        updated_width,
        area.height,
    );
    let status = Rect::new(
        updated.x - if metadata { status_width + 2 } else { 0 },
        area.y,
        status_width,
        area.height,
    );
    let model = Rect::new(
        status.x - if with_model { model_width + 2 } else { 0 },
        area.y,
        model_width,
        area.height,
    );
    let title_end = if with_model {
        model.x - 2
    } else if metadata {
        status.x - 2
    } else {
        area.right()
    };
    Columns {
        title: Rect::new(
            area.x + gutter,
            area.y,
            title_end.saturating_sub(area.x + gutter),
            area.height,
        ),
        model,
        status,
        updated,
    }
}

impl AgentsOverviewView {
    /// Tree branches for each visible helper: `├─` or `└─` for itself, after `│ ` or two
    /// spaces for each ancestor below the top-level task.
    fn tree_prefixes(&self, visible: &[usize]) -> HashMap<usize, String> {
        let position = visible
            .iter()
            .enumerate()
            .map(|(position, index)| (*index, position))
            .collect::<HashMap<_, _>>();
        // Trees are contiguous and depth first, so a later sibling comes before any shallower row.
        let continues = |index: usize| {
            let depth = self.rows[index].depth;
            position.get(&index).is_some_and(|position| {
                visible[position + 1..]
                    .iter()
                    .take_while(|next| **next != usize::MAX && self.rows[**next].depth >= depth)
                    .any(|next| self.rows[*next].depth == depth)
            })
        };
        visible
            .iter()
            .copied()
            .filter(|index| *index != usize::MAX && self.rows[*index].depth > 0)
            .map(|index| {
                let mut parts = vec![if continues(index) { "├─" } else { "└─" }];
                let mut ancestor = self.rows[index].parent;
                while let Some(current) = ancestor.filter(|current| self.rows[*current].depth > 0) {
                    parts.push(if continues(current) { "│ " } else { "  " });
                    ancestor = self.rows[current].parent;
                }
                parts.reverse();
                (index, parts.concat())
            })
            .collect()
    }

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
            let header = columns(row(area, /*offset*/ 0, /*height*/ 1));
            line("Task".dim(), header.title, buf);
            line("Model".dim(), header.model, buf);
            line("Status".dim(), header.status, buf);
            Line::from("Updated".dim())
                .right_aligned()
                .render(header.updated, buf);
        }
        let prefixes = self.tree_prefixes(&indices);
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
                let group = match state.grouping {
                    AgentsOverviewGrouping::Project => {
                        format_directory_display(
                            &self.project_groups[index].heading,
                            /*max_width*/ None,
                        )
                    }
                    AgentsOverviewGrouping::Status => task.tree_group.label().to_owned(),
                    AgentsOverviewGrouping::Model => {
                        model_name(&self.rows[task.root].thread).to_owned()
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
                let group = if state.grouping == AgentsOverviewGrouping::Project {
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
            let selected = index == self.selected;
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
            line(
                Line::from(if selected { "›" } else { " " }).style(style),
                rect,
                buf,
            );
            // Branches, then the agent's dot, then the title, all shifted by the nesting.
            let branches = prefixes.get(&index).map(String::as_str).unwrap_or_default();
            let indent = branches.width() as u16;
            let branch_x = rect.width.min(/*other*/ 2);
            line(
                Line::from(branches.to_owned()).style(if selected { style } else { style.dim() }),
                Rect::new(
                    rect.x + branch_x,
                    rect.y,
                    (rect.width - branch_x).min(indent),
                    /*height*/ 1,
                ),
                buf,
            );
            let Columns {
                title: mut title,
                model,
                status: status_area,
                updated,
            } = columns(rect);
            // Without a status column, the agent's dot takes the status glyph's shape.
            let dot = if status_area.is_empty() {
                Self::status(task).1
            } else {
                "●"
            };
            let dot_x = rect.width.min(2 + indent);
            line(
                Line::from(Span::styled(dot, self.agent_style(task, style))),
                Rect::new(
                    rect.x + dot_x,
                    rect.y,
                    (rect.width - dot_x).min(/*other*/ 1),
                    /*height*/ 1,
                ),
                buf,
            );
            let shift = title.width.min(indent);
            title.x += shift;
            title.width -= shift;
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
            line(
                Line::from(display_title(&task.thread).to_owned()).style(style),
                title,
                buf,
            );
            if let Some(label) = task.model_label() {
                line(
                    Line::from(Span::styled(label, self.agent_style(task, style))),
                    model,
                    buf,
                );
            }
            line(
                Line::from(self.status_spans(task, style, selected)),
                status_area,
                buf,
            );
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
