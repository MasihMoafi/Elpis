//! Persistent, user-controlled view of Elpis-owned portable context.

use super::*;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;

use crate::color::is_light;
use crate::terminal_palette::StdoutColorLevel;
use crate::terminal_palette::best_color_for_level;
use crate::terminal_palette::default_bg;
use crate::terminal_palette::stdout_color_level;

const LEDGER_MIN_TERMINAL_WIDTH: u16 = 80;
const LEDGER_WIDTH: u16 = 52;

/// User-facing grouping for portable sources. Core categories retain their
/// admission semantics; this layer only keeps manually selected files from
/// being presented as Elpis-owned session continuity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum LedgerSourceGroup {
    SessionContinuity,
    UserFiles,
    DurableMemory,
    Instructions,
}

impl LedgerSourceGroup {
    pub(super) const ALL: [Self; 4] = [
        Self::SessionContinuity,
        Self::UserFiles,
        Self::DurableMemory,
        Self::Instructions,
    ];

    pub(super) fn for_source(source: &crate::legacy_core::elpis_context::ContinuitySource) -> Self {
        use crate::legacy_core::elpis_context::ContinuitySourceCategory as C;
        if source.origin == "manual addition" {
            return Self::UserFiles;
        }
        match source.category {
            C::Files => Self::SessionContinuity,
            C::Memory => Self::DurableMemory,
            C::Instructions => Self::Instructions,
        }
    }

    pub(super) fn display_name(self) -> &'static str {
        match self {
            Self::SessionContinuity => "SESSION CONTINUITY",
            Self::UserFiles => "USER FILES",
            Self::DurableMemory => "DURABLE MEMORY",
            Self::Instructions => "INSTRUCTIONS",
        }
    }

    fn color(self) -> Color {
        match self {
            Self::SessionContinuity => Color::Rgb(52, 168, 83),
            Self::UserFiles => Color::Rgb(59, 130, 246),
            Self::DurableMemory => Color::Rgb(215, 119, 87),
            Self::Instructions => Color::Rgb(255, 193, 7),
        }
    }
}

/// The ledger's rendered content: the lines themselves, the line range each source
/// occupies (for selection scrolling), and `(line index, file:// destination)` for
/// every source row that maps to a real file on disk.
pub(super) struct LedgerLines {
    lines: Vec<Line<'static>>,
    source_line_ranges: Vec<std::ops::Range<usize>>,
    source_links: Vec<(usize, String)>,
    smart_prune_line: usize,
    smart_prune_columns: std::ops::Range<usize>,
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
    last_smart_prune_row: std::cell::Cell<Option<u16>>,
    last_smart_prune_columns: std::cell::Cell<Option<(u16, u16)>>,
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
            last_smart_prune_row: std::cell::Cell::new(None),
            last_smart_prune_columns: std::cell::Cell::new(None),
        }
    }
}

impl ContextLedgerState {
    fn clear_rendered_geometry(&self) {
        self.last_area.set(None);
        self.last_scroll.set(0);
        self.last_source_ranges.borrow_mut().clear();
        self.last_smart_prune_row.set(None);
        self.last_smart_prune_columns.set(None);
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
            self.context_ledger.clear_rendered_geometry();
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
                self.context_ledger.clear_rendered_geometry();
            } else {
                self.context_ledger.focused = true;
            }
            self.context_ledger.pending_g = false;
            self.request_redraw();
            return true;
        }
        let ledger_is_rendered = self.context_ledger.visible
            && self
                .last_rendered_width
                .get()
                .is_some_and(|width| width >= LEDGER_MIN_TERMINAL_WIDTH as usize);
        if !self.context_ledger.focused || !ledger_is_rendered {
            return false;
        }

        if key_event.modifiers.is_empty() && matches!(key_event.code, KeyCode::Char('p')) {
            self.toggle_smart_prune();
            return true;
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
                    let manual_memory_path = self
                        .manual_memory_cache
                        .bound_target
                        .as_ref()
                        .map(|target| target.view.memory_path.clone());
                    let all_admitted = all_bulk_context_sources_admitted(
                        &sources,
                        manual_memory_path.as_deref(),
                        self.manual_memory_can_toggle(),
                    );
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
                let manual_memory_path = self
                    .manual_memory_cache
                    .bound_target
                    .as_ref()
                    .map(|target| target.view.memory_path.clone());
                let all_admitted = all_bulk_context_sources_admitted(
                    &sources,
                    manual_memory_path.as_deref(),
                    self.manual_memory_can_toggle(),
                );
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
            KeyCode::Char('c') => {
                let source = &sources[self.context_ledger.selected];
                let is_manual_memory = is_manual_memory_source(
                    source,
                    self.manual_memory_cache
                        .bound_target
                        .as_ref()
                        .map(|target| target.view.memory_path.as_path()),
                );
                if is_manual_memory {
                    self.begin_manual_memory_create();
                } else {
                    self.context_ledger.focused = false;
                    return false;
                }
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
        let admitted_segments = LedgerSourceGroup::ALL
            .into_iter()
            .filter(|group| *group != LedgerSourceGroup::DurableMemory)
            .map(|group| {
                let admitted = sources
                    .iter()
                    .filter(|source| {
                        LedgerSourceGroup::for_source(source) == group && source.admitted
                    })
                    .map(|source| source.estimated_tokens)
                    .sum::<u64>();
                (admitted, group.color())
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
            "p Smart Prune · Up/Down move · Space/Enter toggle · i all · w why · Esc exit"
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
        ];
        // The core snapshot is authoritative. A config write can be superseded by a
        // higher-precedence thread layer, so do not optimistically render the staged
        // user-layer value while the core refresh is still being reconciled.
        let smart_prune_enabled = self.smart_prune.enabled;
        let smart_prune_button = if !self.smart_prune_synced {
            "[···] SYNC"
        } else if smart_prune_enabled {
            "[━━━●] ON"
        } else {
            "[●━━━] OFF"
        };
        let smart_prune_label = "SMART PRUNE";
        let smart_prune_pad = content_width
            .saturating_sub(smart_prune_label.chars().count() + smart_prune_button.chars().count())
            .max(1);
        let smart_prune_line = lines.len();
        let smart_prune_column_start = smart_prune_label.chars().count() + smart_prune_pad;
        let smart_prune_columns =
            smart_prune_column_start..smart_prune_column_start + smart_prune_button.chars().count();
        let [violet, teal, emerald, green] =
            smart_prune_on_colors(default_bg(), stdout_color_level());
        let switch_spans = if !self.smart_prune_synced {
            vec![Span::styled(
                smart_prune_button,
                Style::default().fg(teal).bold(),
            )]
        } else if smart_prune_enabled {
            vec![
                Span::styled("[", Style::default().fg(teal)),
                Span::styled("━", Style::default().fg(violet)),
                Span::styled("━", Style::default().fg(teal)),
                Span::styled("━", Style::default().fg(emerald)),
                Span::styled("●] ON", Style::default().fg(green).bold()),
            ]
        } else {
            vec![Span::styled(smart_prune_button, muted)]
        };
        let mut smart_prune_spans = vec![
            Span::styled(smart_prune_label, Style::default().fg(teal).bold()),
            Span::raw(" ".repeat(smart_prune_pad)),
        ];
        smart_prune_spans.extend(switch_spans);
        lines.push(Line::from(smart_prune_spans));
        let smart_prune_detail = if !self.smart_prune_synced {
            "Reading current thread state".to_string()
        } else if self.smart_prune.examined_outputs > 0 {
            format!(
                "Admitted {} of {} outputs · source ≈{} → kept ≈{} · saved ≈{}",
                self.smart_prune.admitted_outputs,
                self.smart_prune.examined_outputs,
                format_tokens(self.smart_prune.approx_source_tokens),
                format_tokens(self.smart_prune.approx_admitted_tokens),
                format_tokens(self.smart_prune.approx_saved_tokens),
            )
        } else if smart_prune_enabled {
            "Before first send · sent history stays stable".to_string()
        } else {
            "Tool results pass through unchanged".to_string()
        };
        lines.push(Line::from(Span::styled(smart_prune_detail, muted)));
        if self.smart_prune_synced
            && let Some(latest) = self.smart_prune.latest.as_ref()
        {
            let short_id = latest.admission_id.get(..8).unwrap_or(&latest.admission_id);
            let status = if latest.response_linkage_verified {
                "response linked"
            } else if latest.request_linkage_verified {
                "request linked"
            } else if latest.request_sequence.is_some() {
                "request evidence pending"
            } else {
                "awaiting first main send"
            };
            lines.push(Line::from(Span::styled(
                format!("Latest {short_id} · {status}"),
                muted,
            )));
        }
        let smart_prune_hint = if !self.smart_prune_synced {
            "Syncing… · /smart-prune on|off sets an explicit state"
        } else if self.is_user_turn_pending_or_running() {
            "Available after turn · active turn policy is fixed"
        } else {
            "p toggle · /smart-prune on|off"
        };
        lines.push(Line::from(Span::styled(smart_prune_hint, muted)));
        lines.push(Line::from(""));
        lines.extend([
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
        ]);

        if sources.is_empty() {
            lines.push(Line::from("No portable context is available.".dim()));
        }
        let mut source_line_ranges = vec![0..0; sources.len()];
        for group in LedgerSourceGroup::ALL {
            let category_sources = sources
                .iter()
                .enumerate()
                .filter(|(_, source)| LedgerSourceGroup::for_source(source) == group)
                .collect::<Vec<_>>();
            if category_sources.is_empty() {
                continue;
            }
            let admitted_tokens = category_sources
                .iter()
                .filter(|(_, source)| source.admitted)
                .map(|(_, source)| source.estimated_tokens)
                .sum::<u64>();
            let cat_style = Style::default().fg(group.color());
            lines.push(Line::from(vec![
                Span::styled("■ ", cat_style),
                Span::styled(group.display_name(), cat_style.bold()),
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
                // Per-source estimates stay exact so similarly sized files remain
                // distinguishable; category and context totals remain compact.
                let right = format!(
                    "≈{} est. tokens {state}",
                    format_source_count(source.estimated_tokens),
                );
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
                        format!(
                            "≈{} est. tokens ",
                            format_source_count(source.estimated_tokens),
                        ),
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
                    lines.push(Line::from(format!("Lifetime: {}", source.lifetime).dim()));
                    lines.push(Line::from(format!("Origin: {}", source.origin).dim()));
                    lines.push(Line::from(
                        format!(
                            "Size: {} bytes · Estimate: ≈{} tokens (trimmed characters ÷ 4, capped)",
                            format_source_count(source.bytes),
                            format_source_count(source.estimated_tokens),
                        )
                        .dim(),
                    ));
                    lines.push(Line::from(
                        format!("Source: {}", source.path.display()).dim(),
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
            smart_prune_line,
            smart_prune_columns,
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
            smart_prune_line,
            smart_prune_columns,
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
        let rows_before_smart_prune = Paragraph::new(lines[..smart_prune_line].to_vec())
            .wrap(Wrap { trim: true })
            .line_count(content_width);
        let visible_smart_prune_row = u16::try_from(rows_before_smart_prune)
            .ok()
            .and_then(|row| row.checked_sub(scroll_lines))
            .filter(|row| *row < area.height)
            .map(|row| area.y.saturating_add(row));
        self.context_ledger
            .last_smart_prune_row
            .set(visible_smart_prune_row);
        let switch_start = u16::try_from(smart_prune_columns.start)
            .ok()
            .map(|column| area.x.saturating_add(1).saturating_add(column));
        let switch_end = u16::try_from(smart_prune_columns.end)
            .ok()
            .map(|column| area.x.saturating_add(1).saturating_add(column));
        self.context_ledger
            .last_smart_prune_columns
            .set(switch_start.zip(switch_end));
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
        if self.context_ledger.last_smart_prune_row.get() == Some(row)
            && self
                .context_ledger
                .last_smart_prune_columns
                .get()
                .is_some_and(|(start, end)| col >= start && col < end)
        {
            self.toggle_smart_prune();
            return true;
        }
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

    pub(crate) fn continuity_sources(
        &self,
    ) -> Vec<crate::legacy_core::elpis_context::ContinuitySource> {
        self.manual_memory_cache.sources.clone()
    }

    pub(crate) fn manual_memory_bound_target(&self) -> Option<&ManualMemoryRequestTarget> {
        self.manual_memory_cache.bound_target.as_ref()
    }

    pub(crate) fn manual_memory_phase(&self) -> ManualMemoryPhase {
        self.manual_memory_cache.phase
    }

    pub(crate) fn manual_memory_status(
        &self,
    ) -> Option<&crate::legacy_core::elpis_context::ManualMemoryStatus> {
        self.manual_memory_cache.status.as_ref()
    }

    pub(crate) fn manual_memory_unavailable_reason(&self) -> Option<ManualMemoryUnavailableReason> {
        self.manual_memory_cache.unavailable_reason
    }

    pub(crate) fn manual_memory_refresh_requested(&self) -> bool {
        self.manual_memory_cache.refresh_requested
    }

    pub(crate) fn manual_memory_context_report_pending(&self) -> bool {
        self.manual_memory_cache.pending_context_report
    }

    pub(crate) fn manual_memory_pending_mutation(&self) -> Option<ManualMemoryMutation> {
        self.manual_memory_cache.pending_mutation
    }

    pub(crate) fn manual_memory_submission_blocked(&self) -> bool {
        matches!(
            self.manual_memory_cache.pending_mutation,
            Some(ManualMemoryMutation::Admission { .. })
        )
    }

    pub(crate) fn seed_manual_memory_pending_mutation(
        &mut self,
        pending_mutation: Option<ManualMemoryMutation>,
    ) {
        self.manual_memory_cache.pending_mutation = pending_mutation;
        match pending_mutation {
            Some(ManualMemoryMutation::Create) => {
                self.manual_memory_cache.phase = ManualMemoryPhase::Creating;
            }
            Some(ManualMemoryMutation::Admission { .. }) => {
                self.manual_memory_cache.phase = ManualMemoryPhase::Loading;
                self.manual_memory_cache.status = None;
                self.manual_memory_cache.sources.clear();
                self.manual_memory_cache.unavailable_reason = None;
            }
            None if self.manual_memory_cache.phase == ManualMemoryPhase::Creating => {
                self.manual_memory_cache.phase = ManualMemoryPhase::Loading;
                self.manual_memory_cache.status = None;
                self.manual_memory_cache.sources.clear();
                self.manual_memory_cache.unavailable_reason = None;
            }
            None => {}
        }
        self.request_redraw();
    }

    pub(crate) fn bind_manual_memory_loading(
        &mut self,
        target: ManualMemoryRequestTarget,
        pending_context_report: bool,
        pending_mutation: Option<ManualMemoryMutation>,
    ) {
        self.manual_memory_cache = ManualMemoryCache {
            bound_target: Some(target),
            phase: if pending_mutation == Some(ManualMemoryMutation::Create) {
                ManualMemoryPhase::Creating
            } else {
                ManualMemoryPhase::Loading
            },
            pending_mutation,
            pending_context_report,
            ..ManualMemoryCache::default()
        };
        self.request_redraw();
    }

    fn mark_manual_memory_loading(&mut self) -> Option<ManualMemoryRequestTarget> {
        let target = self.manual_memory_cache.bound_target.clone()?;
        self.manual_memory_cache.phase = ManualMemoryPhase::Loading;
        self.manual_memory_cache.status = None;
        self.manual_memory_cache.sources.clear();
        self.manual_memory_cache.unavailable_reason = None;
        self.manual_memory_cache.refresh_requested = true;
        if self.manual_memory_cache.pending_mutation == Some(ManualMemoryMutation::Create) {
            self.manual_memory_cache.phase = ManualMemoryPhase::Creating;
        }
        self.request_redraw();
        Some(target)
    }

    pub(crate) fn begin_manual_memory_create(&mut self) -> bool {
        if self.manual_memory_cache.pending_mutation.is_some()
            || self
                .manual_memory_cache
                .status
                .as_ref()
                .is_none_or(|status| {
                    status.state
                        != crate::legacy_core::elpis_context::ManualMemoryAdmissionState::Missing
                })
        {
            return false;
        }
        let Some(target) = self.manual_memory_cache.bound_target.clone() else {
            return false;
        };
        self.manual_memory_cache.pending_mutation = Some(ManualMemoryMutation::Create);
        self.manual_memory_cache.phase = ManualMemoryPhase::Creating;
        self.request_redraw();
        self.app_event_tx
            .send(AppEvent::ManualMemoryCreateRequested(target));
        true
    }

    pub(crate) fn begin_manual_memory_admission(&mut self, admitted: bool) -> bool {
        if self.manual_memory_cache.pending_mutation.is_some() {
            return false;
        }
        let Some(status) = self.manual_memory_cache.status.as_ref() else {
            return false;
        };
        let current = match status.state {
            crate::legacy_core::elpis_context::ManualMemoryAdmissionState::Missing => return false,
            crate::legacy_core::elpis_context::ManualMemoryAdmissionState::AvailableNotAdmitted => {
                false
            }
            crate::legacy_core::elpis_context::ManualMemoryAdmissionState::Admitted => true,
        };
        if current == admitted {
            return false;
        }
        let Some(target) = self.manual_memory_cache.bound_target.clone() else {
            return false;
        };
        self.manual_memory_cache.pending_mutation =
            Some(ManualMemoryMutation::Admission { admitted });
        self.manual_memory_cache.phase = ManualMemoryPhase::Loading;
        self.manual_memory_cache.status = None;
        self.manual_memory_cache.sources.clear();
        self.manual_memory_cache.unavailable_reason = None;
        self.request_redraw();
        self.app_event_tx
            .send(AppEvent::ManualMemoryAdmissionRequested(target, admitted));
        true
    }

    pub(crate) fn clear_manual_memory_pending_mutation(&mut self) {
        self.manual_memory_cache.pending_mutation = None;
        self.request_redraw();
    }

    pub(crate) fn request_manual_memory_status_refresh(&mut self) {
        if self.manual_memory_cache.refresh_requested {
            return;
        }
        if let Some(target) = self.mark_manual_memory_loading() {
            self.app_event_tx
                .send(AppEvent::ManualMemoryStatusRefreshRequested(target));
        }
    }

    pub(crate) fn request_fresh_context_usage_report(&mut self) {
        if self.manual_memory_cache.pending_context_report {
            return;
        }
        let Some(target) = self.mark_manual_memory_loading() else {
            self.add_info_message(
                "Context status is still initializing.".to_string(),
                /*hint*/ None,
            );
            return;
        };
        self.manual_memory_cache.pending_context_report = true;
        self.app_event_tx
            .send(AppEvent::RequestContextUsageReport(target));
    }

    pub(crate) fn apply_manual_memory_status_completion(
        &mut self,
        target: &ManualMemoryRequestTarget,
        completion: ManualMemoryStatusCompletion,
    ) -> bool {
        if self.manual_memory_cache.bound_target.as_ref() != Some(target)
            || self.manual_memory_cache.refresh_requested
        {
            return false;
        }
        match completion {
            ManualMemoryStatusCompletion::Ready { status, sources } => {
                self.manual_memory_cache.phase = ManualMemoryPhase::Ready;
                self.manual_memory_cache.status = Some(status);
                self.manual_memory_cache.sources = sources;
                self.manual_memory_cache.unavailable_reason = None;
            }
            ManualMemoryStatusCompletion::Unavailable(reason) => {
                self.manual_memory_cache.phase = ManualMemoryPhase::Unavailable;
                self.manual_memory_cache.status = None;
                self.manual_memory_cache.sources.clear();
                self.manual_memory_cache.unavailable_reason = Some(reason);
            }
        }
        self.request_redraw();
        true
    }

    pub(crate) fn take_pending_context_report(&mut self) -> bool {
        std::mem::take(&mut self.manual_memory_cache.pending_context_report)
    }

    /// The server-reported instruction sources, converted for `elpis_context` — the
    /// same list `/usage` renders, so the ledger cannot disagree with it.
    pub(crate) fn instruction_source_paths_as_path_bufs(&self) -> Vec<std::path::PathBuf> {
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
        if self.reject_manual_memory_writer_conflict() {
            return;
        }
        let manual_memory_path = self
            .manual_memory_cache
            .bound_target
            .as_ref()
            .map(|target| target.view.memory_path.clone());
        let mut ordinary_write_attempted = false;
        for source in sources.iter().filter(|source| {
            source.selectable
                && !is_manual_memory_source(source, manual_memory_path.as_deref())
                && source.admitted != admitted
        }) {
            ordinary_write_attempted = true;
            if let Err(error) = crate::legacy_core::elpis_context::set_continuity_source_admitted(
                Some(self.config.memory_dir.as_path()),
                self.config.cwd.as_path(),
                &source.name,
                admitted,
            ) {
                self.add_error_message(format!("Could not update context admission: {error}"));
                self.request_manual_memory_status_refresh();
                return;
            }
        }
        let memory_enqueued = self.manual_memory_can_toggle()
            && sources.iter().any(|source| {
                is_manual_memory_source(source, manual_memory_path.as_deref())
                    && source.admitted != admitted
            })
            && self.begin_manual_memory_admission(admitted);
        if ordinary_write_attempted && !memory_enqueued {
            self.request_manual_memory_status_refresh();
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
        if self.reject_manual_memory_writer_conflict() {
            return;
        }
        let is_manual_memory = is_manual_memory_source(
            source,
            self.manual_memory_cache
                .bound_target
                .as_ref()
                .map(|target| target.view.memory_path.as_path()),
        );
        if is_manual_memory {
            self.add_info_message(
                "Manual Memory cannot be removed here; exclude it or edit its file.".to_string(),
                /*hint*/ None,
            );
            return;
        }
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
                self.request_manual_memory_status_refresh();
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
                self.request_manual_memory_status_refresh();
            }
        }
    }

    fn set_context_source_admitted(
        &mut self,
        source: &crate::legacy_core::elpis_context::ContinuitySource,
        admitted: bool,
    ) -> bool {
        if self.reject_manual_memory_writer_conflict() {
            return false;
        }
        let is_manual_memory = is_manual_memory_source(
            source,
            self.manual_memory_cache
                .bound_target
                .as_ref()
                .map(|target| target.view.memory_path.as_path()),
        );
        if is_manual_memory {
            if self.manual_memory_can_toggle() {
                return self.begin_manual_memory_admission(admitted);
            }
            self.add_info_message(
                "Manual Memory does not exist yet; press c to create it.".to_string(),
                /*hint*/ None,
            );
            return false;
        }
        let updated = match crate::legacy_core::elpis_context::set_continuity_source_admitted(
            Some(self.config.memory_dir.as_path()),
            self.config.cwd.as_path(),
            &source.name,
            admitted,
        ) {
            Ok(()) => true,
            Err(error) => {
                self.add_error_message(format!("Could not update context admission: {error}"));
                false
            }
        };
        self.request_manual_memory_status_refresh();
        updated
    }

    fn manual_memory_can_toggle(&self) -> bool {
        self.manual_memory_cache
            .status
            .as_ref()
            .is_some_and(|status| {
                status.state
                    != crate::legacy_core::elpis_context::ManualMemoryAdmissionState::Missing
            })
    }

    pub(super) fn reject_manual_memory_writer_conflict(&mut self) -> bool {
        if self.manual_memory_cache.pending_mutation.is_none() {
            return false;
        }
        self.add_info_message(
            "Context admission is busy while Manual Memory is changing.".to_string(),
            /*hint*/ None,
        );
        true
    }
}

fn is_manual_memory_source(
    source: &crate::legacy_core::elpis_context::ContinuitySource,
    manual_memory_path: Option<&std::path::Path>,
) -> bool {
    manual_memory_path == Some(source.path.as_path())
}

fn is_bulk_context_source_actionable(
    source: &crate::legacy_core::elpis_context::ContinuitySource,
    manual_memory_path: Option<&std::path::Path>,
    manual_memory_actionable: bool,
) -> bool {
    source.selectable
        && (!is_manual_memory_source(source, manual_memory_path) || manual_memory_actionable)
}

fn all_bulk_context_sources_admitted(
    sources: &[crate::legacy_core::elpis_context::ContinuitySource],
    manual_memory_path: Option<&std::path::Path>,
    manual_memory_actionable: bool,
) -> bool {
    let mut actionable = sources.iter().filter(|source| {
        is_bulk_context_source_actionable(source, manual_memory_path, manual_memory_actionable)
    });
    actionable
        .next()
        .is_some_and(|first| first.admitted && actionable.all(|source| source.admitted))
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

fn format_source_count(value: u64) -> String {
    let digits = value.to_string();
    let first = digits.len() % 3;
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    if first != 0 {
        grouped.push_str(&digits[..first]);
    }
    for chunk in digits.as_bytes()[first..].chunks(3) {
        if !grouped.is_empty() {
            grouped.push(',');
        }
        grouped.push_str(std::str::from_utf8(chunk).expect("digits are UTF-8"));
    }
    grouped
}

fn smart_prune_on_colors(
    terminal_bg: Option<(u8, u8, u8)>,
    color_level: StdoutColorLevel,
) -> [Color; 4] {
    if matches!(
        color_level,
        StdoutColorLevel::Ansi16 | StdoutColorLevel::Unknown
    ) {
        return [Color::Green; 4];
    }

    let palette = if terminal_bg.is_some_and(is_light) {
        [(109, 40, 217), (13, 116, 144), (5, 122, 85), (21, 128, 61)]
    } else {
        [
            (139, 92, 246),
            (20, 184, 166),
            (16, 185, 129),
            (74, 222, 128),
        ]
    };
    palette.map(|color| best_color_for_level(color, color_level))
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
    fn smart_prune_palette_uses_a_readable_low_color_fallback() {
        assert_eq!(
            smart_prune_on_colors(
                Some((0, 0, 0)),
                crate::terminal_palette::StdoutColorLevel::Ansi16,
            ),
            [Color::Green; 4]
        );
    }

    #[test]
    fn smart_prune_palette_adapts_for_a_light_terminal() {
        assert_eq!(
            smart_prune_on_colors(
                Some((255, 255, 255)),
                crate::terminal_palette::StdoutColorLevel::TrueColor,
            ),
            [
                Color::Rgb(109, 40, 217),
                Color::Rgb(13, 116, 144),
                Color::Rgb(5, 122, 85),
                Color::Rgb(21, 128, 61),
            ]
        );
    }

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
