//! Persistent, user-controlled view of Elpis-owned portable context.

use super::*;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;

const LEDGER_MIN_TERMINAL_WIDTH: u16 = 80;
const LEDGER_WIDTH: u16 = 52;

/// The ledger's rendered content: the lines themselves, the line range each source
/// occupies (for selection scrolling), and `(line index, file:// destination)` for
/// every source row that maps to a real file on disk.
pub(super) struct LedgerLines {
    lines: Vec<Line<'static>>,
    source_line_ranges: Vec<std::ops::Range<usize>>,
    source_links: Vec<(usize, String)>,
}

pub(super) struct ContextLedgerState {
    visible: bool,
    focused: bool,
    selected: usize,
    pending_g: bool,
    why_visible: bool,
    last_area: std::cell::Cell<Option<Rect>>,
    last_scroll: std::cell::Cell<u16>,
    last_source_ranges: std::cell::RefCell<Vec<(usize, std::ops::Range<usize>)>>,
}

impl Default for ContextLedgerState {
    fn default() -> Self {
        Self {
            // Open by default; Tab or Alt+C hides it.
            visible: true,
            focused: false,
            selected: 0,
            pending_g: false,
            why_visible: false,
            last_area: std::cell::Cell::new(None),
            last_scroll: std::cell::Cell::new(0),
            last_source_ranges: std::cell::RefCell::new(Vec::new()),
        }
    }
}

impl ChatWidget {
    /// The ledger is a sidebar shown by default and toggled with `Tab` or `Alt+C`:
    /// one press hides it, the next shows and focuses it. `Tab` defers to the
    /// composer's queue-the-draft action while a turn is running (or during the
    /// startup queueing window), since that binding needs `Tab` too; `Alt+C`
    /// always toggles the ledger regardless. On narrower terminals the ledger
    /// takes a proportional slice instead of a fixed 52 columns so the composer
    /// keeps room.
    pub(super) fn context_ledger_width(&self, terminal_width: u16) -> u16 {
        if !self.context_ledger.visible || terminal_width < LEDGER_MIN_TERMINAL_WIDTH {
            return 0;
        }
        LEDGER_WIDTH.min(terminal_width * 2 / 5)
    }

    pub(super) fn context_ledger_desired_height(&self, ledger_width: u16) -> u16 {
        self.context_ledger_lines_with_height(ledger_width)
            .map(|(height, _)| height)
            .unwrap_or(0)
    }

    /// Builds the ledger once for a render pass and returns both its measured height
    /// and the lines needed to paint it. The normal render path needs both values;
    /// keeping them together avoids rescanning continuity files between layout and
    /// painting.
    pub(super) fn context_ledger_lines_with_height(
        &self,
        ledger_width: u16,
    ) -> Option<(u16, LedgerLines)> {
        if !self.context_ledger.visible || ledger_width == 0 {
            return None;
        }
        // Build the real lines and measure them with the same wrap settings the
        // renderer uses. Hand-counting rows here is what mis-anchored the panel: the
        // estimate had to mirror the renderer by hand, and it silently missed wrapped
        // rows and the expanded "WHY INCLUDED" block.
        let content_width = ledger_width.saturating_sub(1).max(1);
        let ledger_lines = self.ledger_lines(content_width as usize);
        let height = u16::try_from(
            Paragraph::new(ledger_lines.lines.clone())
                .wrap(Wrap { trim: true })
                .line_count(content_width),
        )
        .unwrap_or(u16::MAX);
        Some((height, ledger_lines))
    }

    pub(super) fn handle_context_ledger_key_event(&mut self, key_event: KeyEvent) -> bool {
        if key_event.kind != KeyEventKind::Press {
            return false;
        }
        let is_toggle_key = (matches!(key_event.code, KeyCode::Tab)
            && key_event.modifiers.is_empty()
            && !self.bottom_pane.should_queue_on_tab())
            || key_hint::alt(KeyCode::Char('c')).is_press(key_event);
        if is_toggle_key
            && self.bottom_pane.no_modal_or_popup_active()
            && self
                .last_rendered_width
                .get()
                .is_some_and(|width| width >= LEDGER_MIN_TERMINAL_WIDTH as usize)
        {
            // Visible-but-unfocused → focus; focused → hide; hidden → show + focus.
            if !self.context_ledger.visible {
                self.context_ledger.visible = true;
                self.context_ledger.focused = true;
            } else if self.context_ledger.focused {
                self.context_ledger.visible = false;
                self.context_ledger.focused = false;
                self.context_ledger.last_area.set(None);
            } else {
                self.context_ledger.focused = true;
            }
            self.context_ledger.pending_g = false;
            self.request_redraw();
            return true;
        }
        if !self.context_ledger.focused {
            return false;
        }

        let sources = self.continuity_sources();
        let selectable = sources
            .iter()
            .enumerate()
            .filter_map(|(index, source)| source.selectable.then_some(index))
            .collect::<Vec<_>>();
        if selectable.is_empty() {
            if matches!(key_event.code, KeyCode::Esc) {
                self.context_ledger.focused = false;
                self.request_redraw();
                return true;
            }
            return false;
        }
        if !selectable.contains(&self.context_ledger.selected) {
            self.context_ledger.selected = selectable[0];
        }

        if self.context_ledger.pending_g {
            self.context_ledger.pending_g = false;
            match key_event.code {
                KeyCode::Char('i') => {
                    let selectable_sources = sources
                        .iter()
                        .filter(|source| source.selectable)
                        .collect::<Vec<_>>();
                    let all_admitted = !selectable_sources.is_empty()
                        && selectable_sources.iter().all(|source| source.admitted);
                    self.set_all_context_sources_admitted(&sources, !all_admitted);
                    self.request_redraw();
                    return true;
                }
                KeyCode::Char('e') => {
                    self.set_all_context_sources_admitted(&sources, false);
                    self.request_redraw();
                    return true;
                }
                _ => {}
            }
        }

        match key_event.code {
            KeyCode::Esc => {
                self.context_ledger.focused = false;
            }
            KeyCode::Char('i') => {
                let selectable_sources = sources
                    .iter()
                    .filter(|source| source.selectable)
                    .collect::<Vec<_>>();
                let all_admitted = !selectable_sources.is_empty()
                    && selectable_sources.iter().all(|source| source.admitted);
                self.set_all_context_sources_admitted(&sources, !all_admitted);
            }
            KeyCode::Char('g') => {
                self.context_ledger.pending_g = true;
            }
            KeyCode::Char('w') => {
                self.context_ledger.why_visible = !self.context_ledger.why_visible;
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.move_context_ledger_selection(&selectable, -1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.move_context_ledger_selection(&selectable, 1);
            }
            KeyCode::Char(' ') | KeyCode::Enter => {
                let source = &sources[self.context_ledger.selected];
                self.set_context_source_admitted(source, !source.admitted);
            }
            KeyCode::Backspace | KeyCode::Delete => {
                let source = sources[self.context_ledger.selected].clone();
                self.remove_context_source(&source, &selectable);
            }
            _ => {
                if matches!(key_event.code, KeyCode::Char(_)) {
                    self.context_ledger.focused = false;
                }
                return false;
            }
        }
        self.request_redraw();
        true
    }

    /// Builds the ledger's lines for a given content width, plus the line range each
    /// source occupies. Single source of truth: both `context_ledger_desired_height`
    /// and `render_context_ledger` call this, so the height used to bottom-anchor the
    /// panel can never disagree with what is actually drawn.
    ///
    /// `content_width` is the width inside the left border, used to right-align each
    /// row's tokens/state against the same edge instead of stacking them on their own line.
    fn ledger_lines(&self, content_width: usize) -> LedgerLines {
        let mut source_links: Vec<(usize, String)> = Vec::new();
        let sources = self.continuity_sources();
        let total_tokens = sources
            .iter()
            .filter(|source| {
                source.admitted
                    && source.category
                        != crate::legacy_core::elpis_context::ContinuitySourceCategory::Memory
            })
            .map(|source| source.estimated_tokens)
            .sum::<u64>();
        // Plain ANSI cyan so the ledger matches the teal used by the identity line,
        // composer accents, and the rest of the UI in the user's terminal theme.
        let cyan = Style::default().fg(Color::Cyan);
        let amber = Style::default().fg(Color::Rgb(245, 158, 11));
        let muted = Style::default().fg(Color::Rgb(100, 116, 139));
        let messages_color = Color::Rgb(130, 125, 189);
        let context_window = self
            .status_line_context_window_size()
            .unwrap_or(258_400)
            .max(1) as u64;
        // Use the same measured request-context value as `/context` and the status
        // line.  Portable source estimates are attribution only; they must not
        // inflate the headline or percentage beyond what is actually in context.
        let used_tokens = (self
            .token_info
            .as_ref()
            .map(|info| info.last_token_usage.tokens_in_context_window())
            .unwrap_or(0)
            .max(0) as u64)
            .min(context_window);
        let has_request_snapshot = self.token_info.is_some();
        let admitted_display_tokens = total_tokens.min(used_tokens);
        // Everything in the window that isn't admitted portable context is the
        // conversation itself — the biggest consumer, previously invisible here.
        let conversation_tokens = used_tokens.saturating_sub(admitted_display_tokens);
        let used_percent = self.status_line_context_used_percent().unwrap_or(0);
        let admitted_segments = crate::legacy_core::elpis_context::ContinuitySourceCategory::ALL
            .into_iter()
            .filter(|category| {
                *category != crate::legacy_core::elpis_context::ContinuitySourceCategory::Memory
            })
            .map(|category| {
                let admitted = sources
                    .iter()
                    .filter(|source| source.category == category && source.admitted)
                    .map(|source| source.estimated_tokens)
                    .sum::<u64>();
                (admitted, category_color(category))
            })
            .collect::<Vec<_>>();
        let mut bar_segments = vec![(conversation_tokens, messages_color)];
        bar_segments.extend(scale_usage_segments(
            &admitted_segments,
            admitted_display_tokens,
        ));
        let context_header = if has_request_snapshot {
            format!("≈{} tokens in context", format_tokens(used_tokens))
        } else if total_tokens == 0 {
            // Keep the compact idle layout used by the existing popups while making
            // the zero state explicit: no provider request has been measured yet.
            "Total ≈0 tokens admitted".to_string()
        } else {
            format!(
                "context not measured · ≈{} portable admitted",
                format_tokens(total_tokens)
            )
        };
        let interaction_hint = if self.context_ledger.focused {
            "Up/Down move · Space/Enter toggle · i all · w why · Backspace remove · Esc exit"
        } else {
            "Tab focus · Alt+C focus/hide · Ctrl+click open file"
        };
        let mut lines = vec![
            Line::from(vec![
                Span::styled("CONTEXT LEDGER", cyan.bold()),
                Span::raw("  "),
                Span::styled(context_header, cyan),
            ]),
            Line::from(Span::styled(interaction_hint, muted)),
            Line::from(""),
            Line::from(vec![
                Span::styled("CONTEXT WINDOW", cyan.bold()),
                Span::raw("  "),
                Span::styled(
                    format!(
                        "≈{} of {} used ({used_percent}%)",
                        format_tokens(used_tokens),
                        format_tokens(context_window),
                    ),
                    muted,
                ),
            ]),
            usage_bar_line(content_width, context_window, &bar_segments),
            {
                let name = "Conversation (messages)";
                // Same unit as every other row and header; without it this row reads
                // "≈0" two lines under a total reading "≈4.4k tokens".
                let right = format!("≈{} tokens", format_tokens(conversation_tokens));
                let pad = content_width
                    .saturating_sub(2 + 2 + name.chars().count() + right.chars().count())
                    .max(1);
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled("■ ", Style::default().fg(messages_color)),
                    Span::raw(name),
                    Span::raw(" ".repeat(pad)),
                    Span::styled(right, muted),
                ])
            },
            Line::from(""),
        ];

        if sources.is_empty() {
            lines.push(Line::from("No portable context is available.".dim()));
        }
        let mut source_line_ranges = vec![0..0; sources.len()];
        for category in crate::legacy_core::elpis_context::ContinuitySourceCategory::ALL {
            let category_sources = sources
                .iter()
                .enumerate()
                .filter(|(_, source)| source.category == category)
                .collect::<Vec<_>>();
            if category_sources.is_empty() {
                continue;
            }
            let admitted_tokens = category_sources
                .iter()
                .filter(|(_, source)| source.admitted)
                .map(|(_, source)| source.estimated_tokens)
                .sum::<u64>();
            let cat_style = Style::default().fg(category_color(category));
            lines.push(Line::from(vec![
                Span::styled("■ ", cat_style),
                Span::styled(category.display_name(), cat_style.bold()),
                Span::raw("  "),
                Span::styled(
                    format!("≈{} tokens admitted", format_tokens(admitted_tokens)),
                    muted,
                ),
            ]));
            for (index, source) in category_sources {
                let source_line_start = lines.len();
                let selected = self.context_ledger.focused && index == self.context_ledger.selected;
                let marker = if source.selectable {
                    if source.admitted { "[x]" } else { "[ ]" }
                } else {
                    "[-]"
                };
                let state = if source.admitted {
                    "INCLUDED"
                } else {
                    "EXCLUDED"
                };
                let state_style = if source.admitted { cyan } else { amber };
                let marker_style = if source.admitted { cat_style } else { muted };
                let prefix = if selected { "› " } else { "  " };
                // The unit belongs on the row, not only on the category header: a row
                // reading "≈52" under a header reading "≈0 tokens admitted" reads as a
                // contradiction rather than as "this file is 52 tokens, none admitted".
                let right = format!("≈{} tokens {state}", format_tokens(source.estimated_tokens));
                // "› " + "[x]" + " " ahead of the name; truncate long names from the
                // left with '…' so the token count and state stay right-aligned.
                let fixed = prefix.chars().count() + marker.chars().count() + 1;
                let name_budget = content_width
                    .saturating_sub(fixed + right.chars().count() + 1)
                    .max(1);
                let name_chars = source.name.chars().count();
                let shown_name = if name_chars > name_budget {
                    let tail_start = name_chars - name_budget.saturating_sub(1);
                    let tail: String = source.name.chars().skip(tail_start).collect();
                    format!("…{tail}")
                } else {
                    source.name.clone()
                };
                let pad = content_width
                    .saturating_sub(fixed + shown_name.chars().count())
                    .saturating_sub(right.chars().count())
                    .max(1);
                // The whole row opens the file: ctrl+click anywhere on it, the same
                // affordance /usage gives. Blank padding cells are skipped by
                // mark_buffer_hyperlinks, so only the visible text is clickable.
                if let Ok(destination) = url::Url::from_file_path(&source.path) {
                    source_links.push((lines.len(), destination.to_string()));
                }
                lines.push(Line::from(vec![
                    Span::styled(prefix, cyan),
                    Span::styled(marker, marker_style),
                    Span::raw(" "),
                    Span::styled(
                        shown_name,
                        if selected {
                            cyan.bold().underlined()
                        } else {
                            Style::default().underlined()
                        },
                    ),
                    Span::raw(" ".repeat(pad)),
                    Span::styled(
                        format!("≈{} tokens ", format_tokens(source.estimated_tokens)),
                        muted,
                    ),
                    Span::styled(state, state_style),
                ]));

                if selected && self.context_ledger.why_visible {
                    let inclusion = if source.admitted {
                        "Included"
                    } else {
                        "Excluded; when enabled, included"
                    };
                    lines.push(Line::from(Span::styled("WHY INCLUDED", cyan.bold())));
                    lines.push(Line::from(Span::styled(source.name.clone(), cyan)));
                    lines.push(Line::from(
                        format!("{inclusion} because {}.", source.reason).dim(),
                    ));
                    lines.push(Line::from(
                        format!(
                            "Lifetime: {} · Source: {}",
                            source.lifetime,
                            source.path.display()
                        )
                        .dim(),
                    ));
                    // Only the expanded block needs separating from the next row;
                    // rows sit adjacent so the categories do not dominate the panel.
                    lines.push(Line::from(""));
                }

                source_line_ranges[index] = source_line_start..lines.len();
            }
            lines.push(Line::from(""));
        }

        while lines
            .last()
            .map(|l| {
                l.spans.is_empty() || (l.spans.len() == 1 && l.spans[0].content.trim().is_empty())
            })
            .unwrap_or(false)
        {
            lines.pop();
        }

        LedgerLines {
            lines,
            source_line_ranges,
            source_links,
        }
    }

    #[cfg(test)]
    pub(super) fn render_context_ledger(&self, area: Rect, buf: &mut Buffer) {
        let content_width = area.width.saturating_sub(1).max(1);
        self.render_context_ledger_lines(area, buf, self.ledger_lines(content_width as usize));
    }

    pub(super) fn render_context_ledger_lines(
        &self,
        area: Rect,
        buf: &mut Buffer,
        ledger_lines: LedgerLines,
    ) {
        let content_width = area.width.saturating_sub(1).max(1);
        let LedgerLines {
            lines,
            source_line_ranges,
            source_links,
        } = ledger_lines;
        let cyan = Style::default().fg(Color::Cyan);

        let scroll_lines = self
            .context_ledger
            .focused
            .then(|| {
                source_line_ranges
                    .get(self.context_ledger.selected)
                    .map(|range| {
                        selected_source_scroll_offset(
                            &lines,
                            range.clone(),
                            content_width,
                            area.height.max(1),
                        )
                    })
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        self.context_ledger.last_area.set(Some(area));
        self.context_ledger.last_scroll.set(scroll_lines);
        let tracked_ranges = source_line_ranges
            .into_iter()
            .enumerate()
            .filter(|(_, r)| !r.is_empty())
            .collect();
        *self.context_ledger.last_source_ranges.borrow_mut() = tracked_ranges;

        Paragraph::new(lines.clone())
            .block(Block::default().borders(Borders::LEFT).border_style(cyan))
            .wrap(Wrap { trim: true })
            .scroll((scroll_lines, 0))
            .render(area, buf);

        // Attach OSC 8 destinations to the already-drawn cells. Done against the inner
        // area (past the left border) so columns line up with the rendered text.
        if !source_links.is_empty() && area.width > 1 {
            let inner = Rect::new(area.x + 1, area.y, content_width, area.height);
            let links: std::collections::HashMap<usize, String> =
                source_links.into_iter().collect();
            let hyperlink_lines = lines
                .into_iter()
                .enumerate()
                .map(|(index, line)| {
                    let mut hyperlink_line = crate::terminal_hyperlinks::HyperlinkLine::new(line);
                    if let Some(destination) = links.get(&index) {
                        hyperlink_line.hyperlinks.push(
                            crate::terminal_hyperlinks::TerminalHyperlink {
                                columns: 0..content_width as usize,
                                destination: destination.clone(),
                            },
                        );
                    }
                    hyperlink_line
                })
                .collect::<Vec<_>>();
            crate::terminal_hyperlinks::mark_buffer_hyperlinks(
                buf,
                inner,
                &hyperlink_lines,
                scroll_lines as usize,
            );
        }
    }

    pub(crate) fn handle_context_ledger_mouse_click(&mut self, row: u16, col: u16) -> bool {
        let Some(area) = self.context_ledger.last_area.get() else {
            return false;
        };
        if col < area.x || col >= area.x + area.width || row < area.y || row >= area.y + area.height
        {
            return false;
        }

        let scroll = self.context_ledger.last_scroll.get();
        let relative_line = (row.saturating_sub(area.y).saturating_sub(1) + scroll) as usize;

        let target_index = {
            let ranges = self.context_ledger.last_source_ranges.borrow();
            ranges
                .iter()
                .find(|(_, range)| range.contains(&relative_line))
                .map(|&(index, _)| index)
        };

        if let Some(index) = target_index {
            let sources = self.continuity_sources();
            if let Some(source) = sources.get(index) {
                if source.selectable {
                    self.context_ledger.focused = true;
                    self.context_ledger.selected = index;
                    let new_state = !source.admitted;
                    self.set_context_source_admitted(source, new_state);
                    self.request_redraw();
                    return true;
                }
            }
        }
        false
    }

    pub(super) fn continuity_sources(
        &self,
    ) -> Vec<crate::legacy_core::elpis_context::ContinuitySource> {
        crate::legacy_core::elpis_context::continuity_sources_with_dev_rule_roots(
            Some(self.config.memory_dir.as_path()),
            self.config.cwd.as_path(),
            &self.instruction_source_paths_as_path_bufs(),
            &self.config.dev_rule_roots(),
        )
    }

    /// The server-reported instruction sources, converted for `elpis_context` — the
    /// same list `/usage` renders, so the ledger cannot disagree with it.
    pub(super) fn instruction_source_paths_as_path_bufs(&self) -> Vec<std::path::PathBuf> {
        self.instruction_source_paths
            .iter()
            .filter_map(|uri| uri.to_abs_path().ok())
            .map(|path| path.as_path().to_path_buf())
            .collect()
    }

    fn move_context_ledger_selection(&mut self, selectable: &[usize], delta: isize) {
        let current = selectable
            .iter()
            .position(|index| *index == self.context_ledger.selected)
            .unwrap_or(0) as isize;
        let next = (current + delta).rem_euclid(selectable.len() as isize) as usize;
        self.context_ledger.selected = selectable[next];
    }

    fn set_all_context_sources_admitted(
        &mut self,
        sources: &[crate::legacy_core::elpis_context::ContinuitySource],
        admitted: bool,
    ) {
        for source in sources.iter().filter(|source| source.selectable) {
            if !self.set_context_source_admitted(source, admitted) {
                break;
            }
        }
    }

    /// Backspace/Delete on a manually added row drops it from the ledger for good.
    /// Discovered rows (project rules, goal, checkpoint) are rediscovered on the next
    /// scan, so deleting them would silently reappear — those stay toggle-only.
    fn remove_context_source(
        &mut self,
        source: &crate::legacy_core::elpis_context::ContinuitySource,
        selectable: &[usize],
    ) {
        match crate::legacy_core::elpis_context::remove_continuity_source(
            Some(self.config.memory_dir.as_path()),
            self.config.cwd.as_path(),
            &source.name,
        ) {
            Ok(true) => {
                // The removed row is gone, so keep the cursor inside the shorter list.
                if self.context_ledger.selected >= selectable.len() {
                    self.move_context_ledger_selection(selectable, -1);
                }
                self.refresh_context_window_display();
            }
            Ok(false) => {
                self.add_info_message(
                    format!(
                        "{} is discovered automatically — press space to exclude it instead.",
                        source.name
                    ),
                    None,
                );
            }
            Err(error) => {
                self.add_error_message(format!("Could not remove context source: {error}"));
            }
        }
    }

    fn set_context_source_admitted(
        &mut self,
        source: &crate::legacy_core::elpis_context::ContinuitySource,
        admitted: bool,
    ) -> bool {
        match crate::legacy_core::elpis_context::set_continuity_source_admitted(
            Some(self.config.memory_dir.as_path()),
            self.config.cwd.as_path(),
            &source.name,
            admitted,
        ) {
            Ok(()) => {
                self.refresh_context_window_display();
                true
            }
            Err(error) => {
                self.add_error_message(format!("Could not update context admission: {error}"));
                false
            }
        }
    }
}

fn category_color(category: crate::legacy_core::elpis_context::ContinuitySourceCategory) -> Color {
    use crate::legacy_core::elpis_context::ContinuitySourceCategory as C;
    match category {
        C::Files => Color::Rgb(52, 168, 83),
        C::Memory => Color::Rgb(215, 119, 87),
        C::Instructions => Color::Rgb(255, 193, 7),
    }
}

/// One-line horizontal usage bar: a colored segment per (tokens, color) entry,
/// proportional to the context window; the remainder renders as free space.
fn usage_bar_line(
    content_width: usize,
    context_window: u64,
    segments: &[(u64, Color)],
) -> Line<'static> {
    let bar_width = content_width.saturating_sub(2).max(10);
    let mut spans = vec![Span::raw("  ")];
    let mut cells_used = 0usize;
    for (tokens, color) in segments {
        if *tokens == 0 || cells_used >= bar_width {
            continue;
        }
        let cells = ((*tokens as usize * bar_width) / context_window.max(1) as usize)
            .max(1)
            .min(bar_width - cells_used);
        spans.push(Span::styled("█".repeat(cells), Style::default().fg(*color)));
        cells_used += cells;
    }
    if cells_used < bar_width {
        spans.push(Span::styled(
            "░".repeat(bar_width - cells_used),
            Style::default().fg(Color::Rgb(100, 116, 139)),
        ));
    }
    Line::from(spans)
}

/// Scale attribution segments down to the measured amount they represent.  This
/// keeps the colored breakdown honest when source byte estimates exceed the exact
/// request-context count after pruning.
fn scale_usage_segments(segments: &[(u64, Color)], target: u64) -> Vec<(u64, Color)> {
    let source_total = segments.iter().map(|(tokens, _)| *tokens).sum::<u64>();
    if source_total == 0 || target >= source_total {
        return segments.to_vec();
    }

    let mut scaled = segments
        .iter()
        .map(|(tokens, color)| {
            (
                ((*tokens as u128 * target as u128) / source_total as u128) as u64,
                *color,
            )
        })
        .collect::<Vec<_>>();
    let assigned = scaled.iter().map(|(tokens, _)| *tokens).sum::<u64>();
    let remainder = target.saturating_sub(assigned);
    if remainder > 0 {
        if let Some((tokens, _)) = scaled.iter_mut().rev().find(|(tokens, _)| *tokens > 0) {
            *tokens = tokens.saturating_add(remainder);
        } else if let Some((tokens, _)) = scaled.last_mut() {
            *tokens = remainder;
        }
    }
    scaled
}

fn format_tokens(tokens: u64) -> String {
    if tokens < 1_000 {
        tokens.to_string()
    } else {
        format!("{:.1}k", tokens as f64 / 1_000.0)
    }
}

fn selected_source_scroll_offset(
    lines: &[Line<'_>],
    source_range: std::ops::Range<usize>,
    width: u16,
    visible_rows: u16,
) -> u16 {
    let start = source_range.start.min(lines.len());
    let end = source_range.end.max(start).min(lines.len());
    let selected_start = wrapped_line_count(&lines[..start], width);
    let selected_end = wrapped_line_count(&lines[..end], width);
    selected_end
        .saturating_sub(visible_rows.max(1))
        .min(selected_start)
}

fn wrapped_line_count(lines: &[Line<'_>], width: u16) -> u16 {
    u16::try_from(
        Paragraph::new(lines.to_vec())
            .wrap(Wrap { trim: true })
            .line_count(width.max(1)),
    )
    .unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_source_scrolls_into_a_short_ledger() {
        let lines = (0..8)
            .map(|index| Line::from(format!("line {index}")))
            .collect::<Vec<_>>();
        assert_eq!(selected_source_scroll_offset(&lines, 1..3, 52, 4), 0);
        assert_eq!(selected_source_scroll_offset(&lines, 6..8, 52, 4), 4);
    }

    #[test]
    fn ledger_scroll_accounts_for_wrapped_grouped_lines() {
        let lines = vec![
            Line::from("CONTEXT LEDGER"),
            Line::from("FILES"),
            Line::from("[x] short.rs"),
            Line::from("tokens"),
            Line::from("INSTRUCTIONS"),
            Line::from("[x] a source name that wraps on a narrow ledger"),
            Line::from("tokens"),
        ];
        let wide = selected_source_scroll_offset(&lines, 5..7, 52, 4);
        let narrow = selected_source_scroll_offset(&lines, 5..7, 12, 4);
        assert!(narrow > wide);
        assert_eq!(selected_source_scroll_offset(&[], 0..4, 52, 4), 0);
    }

    #[test]
    fn scaled_usage_segments_match_measured_context() {
        let scaled = scale_usage_segments(&[(70, Color::Green), (30, Color::Yellow)], 25);
        assert_eq!(scaled.iter().map(|(tokens, _)| *tokens).sum::<u64>(), 25);
    }
}
