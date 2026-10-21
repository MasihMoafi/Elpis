//! Selected-thread conversation, bounded history, live activity and attention evidence.

use super::*;
use codex_app_server_protocol::ThreadItem;

impl AgentsOverviewView {
    pub(in crate::app::agents_overview_view) fn render_details(
        &self,
        area: Rect,
        buf: &mut Buffer,
    ) {
        let Some(row) = self.selected_row() else {
            return;
        };
        let requested_scroll = {
            let mut state = self.state();
            if state.details_thread != Some(row.thread_id) {
                state.details_thread = Some(row.thread_id);
                state.details_scroll = 0;
            }
            state.details_area = area;
            state.details_scroll
        };
        let width = usize::from(area.width);
        let own_style = self.provider_style(row, Style::default());
        let parent = self
            .parent_index(self.selected)
            .map(|index| &self.rows[index]);
        let has_parent = row.thread.parent_thread_id.is_some();
        let asked_by = parent.map_or(
            if has_parent { "unloaded parent" } else { "you" },
            AgentsOverviewRow::model_display_name,
        );
        let mut lines = vec![
            Line::from(vec![
                Span::styled("● ", own_style),
                display_title(&row.thread).to_string().bold(),
            ]),
            Line::from(vec![
                Span::styled(row.model_label(), own_style),
                format!(" · {} · asked by {asked_by}", Self::provider_label(row)).dim(),
            ]),
        ];
        // Metadata stays compact so long model IDs cannot consume the conversation.
        let mut rendered = Vec::new();
        for header in lines.drain(..) {
            rendered.push(HyperlinkLine::new(
                crate::line_truncation::truncate_line_with_ellipsis_if_overflow(header, width),
            ));
        }
        let parent_label = if let Some(parent) = parent {
            format!("Parent: {}", display_title(&parent.thread))
        } else if let Some(parent_id) = &row.thread.parent_thread_id {
            format!("Parent: {parent_id} (not loaded)")
        } else {
            "Started by you".to_string()
        };
        let children = self
            .rows
            .iter()
            .filter(|child| {
                child.thread.parent_thread_id.as_deref() == Some(row.thread.id.as_str())
            })
            .collect::<Vec<_>>();
        let mut relationships = vec![Line::from(parent_label.dim())];
        if !children.is_empty() {
            let names = children
                .iter()
                .map(|child| display_title(&child.thread))
                .collect::<Vec<_>>()
                .join(", ");
            let running = children
                .iter()
                .filter(|child| {
                    AgentsOverviewGroup::for_thread(&child.thread) == AgentsOverviewGroup::Working
                })
                .count();
            relationships.push(Line::from(
                format!("Children: {names} · {running} running").dim(),
            ));
        }
        // Wrap relationships so every name remains visible even in the narrow details pane.
        rendered.extend(plain_hyperlink_lines(crate::wrapping::word_wrap_lines(
            relationships,
            width,
        )));
        let mut conversation = Vec::new();
        let has_user = row
            .thread
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .any(|item| matches!(item, ThreadItem::UserMessage { .. }));
        let has_agent_message = row
            .thread
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .any(|item| matches!(item, ThreadItem::AgentMessage { .. }));
        let activity_preview = row
            .details
            .lines
            .iter()
            .any(|line| line.to_string() == "Latest activity");
        if !has_user && !row.thread.preview.trim().is_empty() {
            conversation.push(HyperlinkLine::new(
                format!(
                    "{asked_by} → {}  {}",
                    row.model_display_name(),
                    if has_parent { "delegate" } else { "ask" }
                )
                .into(),
            ));
            let mut prompt = crate::markdown_render::render_markdown_lines_with_width_and_cwd(
                &super::super::super::agents_overview_details::preview_markdown(
                    &row.thread.preview,
                ),
                Some(width),
                Some(row.thread.cwd.as_path()),
            );
            if prompt.len() > 2 {
                prompt.truncate(2);
                prompt[1] = HyperlinkLine::new("…".dim().into());
            }
            conversation.extend(prompt);
        }
        let mut first_input = true;
        let mut agent_heading = false;
        for turn in &row.thread.turns {
            for item in &turn.items {
                let shows_agent = match item {
                    ThreadItem::UserMessage { .. } => false,
                    ThreadItem::Reasoning { summary, .. } => {
                        !activity_preview && summary.iter().any(|text| !text.trim().is_empty())
                    }
                    _ => true,
                };
                if shows_agent && !agent_heading {
                    conversation.push(HyperlinkLine::new(Line::default()));
                    conversation.push(HyperlinkLine::new(Line::from(Span::styled(
                        format!("▎ {}", row.model_display_name()),
                        own_style,
                    ))));
                    agent_heading = true;
                }
                match item {
                    ThreadItem::UserMessage {
                        content, client_id, ..
                    } => {
                        let human_steer = client_id.as_deref().is_some_and(|id| {
                            id.starts_with(
                                super::super::super::agents_overview::HUMAN_STEER_ID_PREFIX,
                            )
                        });
                        let from = if human_steer { "you" } else { asked_by };
                        let action = if human_steer {
                            "steer"
                        } else if first_input && has_parent {
                            "delegate"
                        } else if first_input {
                            "ask"
                        } else {
                            "steer"
                        };
                        let style = parent
                            .filter(|_| !human_steer)
                            .map_or(Style::default(), |parent| {
                                self.provider_style(parent, Style::default())
                            });
                        conversation.push(HyperlinkLine::new(Line::default()));
                        conversation.push(HyperlinkLine::new(Line::from(vec![
                            Span::styled(format!("▎ {from}"), style),
                            " → ".dim(),
                            Span::styled(row.model_display_name().to_owned(), own_style),
                            format!("  {action}").dim(),
                        ])));
                        let prompt =
                            crate::chatwidget::ChatWidget::user_message_display_from_inputs(
                                content,
                            )
                            .message;
                        conversation.extend(
                            crate::markdown_render::render_markdown_lines_with_width_and_cwd(
                                &prompt,
                                Some(width.saturating_sub(2)),
                                Some(row.thread.cwd.as_path()),
                            ),
                        );
                        first_input = false;
                        agent_heading = false;
                    }
                    ThreadItem::AgentMessage { text, .. } => {
                        conversation.extend(
                            crate::markdown_render::render_markdown_lines_with_width_and_cwd(
                                text,
                                Some(width),
                                Some(row.thread.cwd.as_path()),
                            ),
                        );
                    }
                    ThreadItem::CommandExecution {
                        command,
                        aggregated_output,
                        status,
                        ..
                    } => {
                        let verb = match status {
                            codex_app_server_protocol::CommandExecutionStatus::InProgress => {
                                "Running"
                            }
                            codex_app_server_protocol::CommandExecutionStatus::Declined => {
                                "Did not run"
                            }
                            _ => "Ran",
                        };
                        conversation.push(HyperlinkLine::new(format!("• {verb} {command}").into()));
                        if let Some(output) = aggregated_output {
                            for line in output.lines().take(2) {
                                conversation
                                    .push(HyperlinkLine::new(format!("  └ {line}").dim().into()));
                            }
                        }
                    }
                    ThreadItem::Reasoning { summary, .. } if !activity_preview => {
                        for text in summary {
                            conversation.extend(
                                crate::markdown_render::render_markdown_lines_with_width_and_cwd(
                                    &format!("• {text}"),
                                    Some(width),
                                    Some(row.thread.cwd.as_path()),
                                ),
                            );
                        }
                    }
                    ThreadItem::McpToolCall { server, tool, .. } => conversation.push(
                        HyperlinkLine::new(format!("• Called {server}.{tool}").into()),
                    ),
                    ThreadItem::DynamicToolCall { tool, .. } => {
                        conversation.push(HyperlinkLine::new(format!("• Called {tool}").into()))
                    }
                    ThreadItem::FileChange {
                        changes, status, ..
                    } => {
                        let verb = if *status
                            == codex_app_server_protocol::PatchApplyStatus::Completed
                        {
                            "Edited"
                        } else if *status == codex_app_server_protocol::PatchApplyStatus::InProgress
                        {
                            "Editing"
                        } else {
                            "Did not edit"
                        };
                        for change in changes {
                            conversation.push(HyperlinkLine::new(
                                format!("• {verb} {}", change.path).into(),
                            ));
                        }
                    }
                    _ => {}
                }
            }
        }
        if !has_agent_message {
            if let Some((text, cwd)) = &row.details.last_message {
                conversation.extend(plain_hyperlink_lines(vec![
                    Line::default(),
                    "Last message".dim().into(),
                ]));
                conversation.extend(
                    crate::markdown_render::render_markdown_lines_with_width_and_cwd(
                        text,
                        Some(width),
                        Some(cwd.as_path()),
                    ),
                );
            }
        }
        let live_start = conversation.len();
        let (status, glyph) = Self::status(row);
        let live = if matches!(row.thread.status, ThreadStatus::Active { .. }) {
            row.thread
                .turns
                .iter()
                .rev()
                .find(|turn| turn.status == codex_app_server_protocol::TurnStatus::InProgress)
                .and_then(|turn| turn.started_at)
                .map(|start| format!(" · {}s", (chrono::Utc::now().timestamp() - start).max(0)))
                .unwrap_or_default()
        } else {
            String::new()
        };
        conversation.push(HyperlinkLine::new(Line::default()));
        conversation.push(HyperlinkLine::new(Line::from(vec![
            Span::styled(format!("▎ {}  ", row.model_display_name()), own_style),
            Span::styled(
                format!("{} {}{live}", glyph.content, status.to_lowercase()),
                Self::status_style(row, Style::default()),
            ),
        ])));
        if self.state().connection_notice.is_none() {
            conversation.extend(plain_hyperlink_lines(row.details.lines.clone()));
        }
        conversation.extend(plain_hyperlink_lines(row.details.usage_lines.clone()));
        let mut body = Vec::new();
        let mut footer_start = 0;
        for (index, line) in conversation.into_iter().enumerate() {
            if index == live_start {
                footer_start = body.len();
            }
            let wrapped = crate::wrapping::word_wrap_lines([line.line.clone()], width);
            body.extend(remap_wrapped_line(&line, wrapped));
        }
        let available = usize::from(area.height).saturating_sub(rendered.len());
        let (mut scroll, mut max_scroll) = (0, 0);
        if body.len() > available {
            // Clip complete display lines without attaching a link to an ellipsis. Live state, attention and usage
            // keep their existing priority below; the conversation above them scrolls under the mouse wheel, with an
            // ellipsis where lines are hidden (Masih, 21 October: scroll "to see what it did").
            let footer = body.split_off(footer_start);
            let room = available.saturating_sub(footer.len());
            if room > 2 {
                // The last page keeps one line for the ellipsis above it.
                max_scroll = body.len() + 1 - room;
                scroll = requested_scroll.min(max_scroll);
            }
            let ellipsis = || HyperlinkLine::new("…".dim().into());
            let (above, below) = (scroll > 0, scroll == 0 || scroll < max_scroll);
            let shown = room.saturating_sub(usize::from(above) + usize::from(below));
            let mut window = Vec::new();
            if above {
                window.push(ellipsis());
            }
            window.extend(body.drain(scroll..(scroll + shown).min(body.len())));
            if below && available > 0 {
                window.push(ellipsis());
            }
            window.extend(
                footer
                    .into_iter()
                    .take(available.saturating_sub(window.len())),
            );
            body = window;
        }
        {
            let mut state = self.state();
            state.details_scroll = scroll;
            state.details_max_scroll = max_scroll;
        }
        rendered.extend(body);
        Paragraph::new(visible_lines(rendered.clone())).render(area, buf);
        mark_buffer_hyperlinks(buf, area, &rendered, 0);
    }
}
