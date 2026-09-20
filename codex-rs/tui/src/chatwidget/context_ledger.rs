//! Persistent, user-controlled view of Elpis-owned portable context.

use super::context_usage::context_used_percent;
use super::context_usage::reconcile_context_categories;
use super::context_usage::run_built_context_categories;
use super::context_usage::smart_prune_attempt_evidence_path;
use super::context_usage::weighted_cell_counts;
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
        let index = match self {
            Self::SessionContinuity => 0,
            Self::UserFiles => 1,
            Self::DurableMemory => 2,
            Self::Instructions => 3,
        };
        smart_prune_on_colors(default_bg(), stdout_color_level())[index]
    }

    fn marker(self) -> &'static str {
        match self {
            Self::SessionContinuity => "⬟",
            Self::UserFiles => "●",
            Self::DurableMemory => "◆",
            Self::Instructions => "✦",
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
    subagents_line: usize,
    subagents_columns: std::ops::Range<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PendingContextAdmission {
    original: bool,
    desired: bool,
}

pub(super) struct ContextLedgerState {
    visible: bool,
    focused: bool,
    selected: usize,
    /// The Smart Prune switch sits above the source rows and is part of the same
    /// keyboard cursor, so it can be reached and toggled without the mouse.
    smart_prune_selected: bool,
    /// The subagent switch is the cursor's second stop, directly below Smart
    /// Prune, so both settings are reachable without leaving the ledger.
    subagents_selected: bool,
    pending_g: bool,
    why_visible: bool,
    last_area: std::cell::Cell<Option<Rect>>,
    last_scroll: std::cell::Cell<u16>,
    last_source_ranges: std::cell::RefCell<Vec<(usize, std::ops::Range<usize>)>>,
    last_smart_prune_row: std::cell::Cell<Option<u16>>,
    last_smart_prune_columns: std::cell::Cell<Option<(u16, u16)>>,
    last_subagents_row: std::cell::Cell<Option<u16>>,
    last_subagents_columns: std::cell::Cell<Option<(u16, u16)>>,
    pub(super) pending_smart_prune_enabled: Option<bool>,
    pub(super) pending_subagents_enabled: Option<bool>,
    pub(super) projected_token_delta: i64,
    pub(super) projection_baseline_turn_id: Option<String>,
    pub(super) pending_context_admissions:
        std::collections::BTreeMap<String, PendingContextAdmission>,
}

impl Default for ContextLedgerState {
    fn default() -> Self {
        Self {
            // Visible by default; keyboard focus stays in the composer.
            visible: true,
            focused: false,
            selected: 0,
            smart_prune_selected: false,
            subagents_selected: false,
            pending_g: false,
            why_visible: false,
            last_area: std::cell::Cell::new(None),
            last_scroll: std::cell::Cell::new(0),
            last_source_ranges: std::cell::RefCell::new(Vec::new()),
            last_smart_prune_row: std::cell::Cell::new(None),
            last_smart_prune_columns: std::cell::Cell::new(None),
            last_subagents_row: std::cell::Cell::new(None),
            last_subagents_columns: std::cell::Cell::new(None),
            pending_smart_prune_enabled: None,
            pending_subagents_enabled: None,
            projected_token_delta: 0,
            projection_baseline_turn_id: None,
            pending_context_admissions: std::collections::BTreeMap::new(),
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
        self.last_subagents_row.set(None);
        self.last_subagents_columns.set(None);
    }
}

impl ChatWidget {
    pub(super) fn focus_composer(&mut self) {
        self.context_ledger.focused = false;
    }

    pub(super) fn context_ledger_has_focus(&self) -> bool {
        self.context_ledger.visible && self.context_ledger.focused
    }

    /// The ledger is a sidebar shown by default and toggled with `Tab` or `Alt+C`:
    /// Tab focuses a visible sidebar, then closes it; Alt+C always toggles it.
    /// On narrower terminals it takes a proportional slice instead of a fixed
    /// 52 columns so the composer keeps room.
    pub(super) fn context_ledger_width(&self, terminal_width: u16) -> u16 {
        if !self.context_ledger.visible
            || self.bottom_pane.has_active_view()
            || terminal_width < LEDGER_MIN_TERMINAL_WIDTH
        {
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
        let is_tab = matches!(key_event.code, KeyCode::Tab) && key_event.modifiers.is_empty();
        let is_toggle_key = is_tab || key_hint::alt(KeyCode::Char('c')).is_press(key_event);
        if is_toggle_key {
            if !self.context_ledger.visible
                || (is_tab && !self.context_ledger.focused && !self.bottom_pane.has_active_view())
            {
                self.context_ledger.visible = true;
                self.context_ledger.focused = true;
                // Start at the top row on screen rather than wherever the
                // underlying source order happens to begin.
                self.context_ledger.smart_prune_selected = false;
                self.context_ledger.subagents_selected = false;
                if let Some(first) = self.selectable_context_source_indexes().first() {
                    self.context_ledger.selected = *first;
                }
            } else {
                self.context_ledger.visible = false;
                self.context_ledger.focused = false;
                self.context_ledger.smart_prune_selected = false;
                self.context_ledger.subagents_selected = false;
                self.context_ledger.clear_rendered_geometry();
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
        if !ledger_is_rendered {
            return false;
        }
        // The panel says "Tab/Esc close", and the owner reads that from the
        // composer too. Esc still belongs to a running turn and to a composer
        // with something in it; when it would otherwise do nothing, it closes
        // the panel that claims it.
        if !self.context_ledger.focused {
            let esc_is_idle = matches!(key_event.code, KeyCode::Esc)
                && !self.bottom_pane.has_active_view()
                && !self.bottom_pane.is_task_running()
                && self.composer_is_empty();
            if esc_is_idle {
                self.close_context_ledger();
                self.request_redraw();
                return true;
            }
            return false;
        }
        if !key_event.modifiers.is_empty() {
            self.context_ledger.pending_g = false;
            return false;
        }

        if matches!(key_event.code, KeyCode::Char('p')) {
            self.toggle_smart_prune();
            return true;
        }

        if matches!(key_event.code, KeyCode::Char('s')) {
            self.toggle_subagents();
            return true;
        }

        // The two switches are the first stops on the cursor, above the sources.
        if self.context_ledger.smart_prune_selected || self.context_ledger.subagents_selected {
            let on_smart_prune = self.context_ledger.smart_prune_selected;
            let selectable = self.selectable_context_source_indexes();
            match key_event.code {
                KeyCode::Esc => self.close_context_ledger(),
                KeyCode::Char(' ') | KeyCode::Enter => {
                    if on_smart_prune {
                        self.toggle_smart_prune();
                    } else {
                        self.toggle_subagents();
                    }
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.move_context_ledger_selection(&selectable, -1);
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    self.move_context_ledger_selection(&selectable, 1);
                }
                KeyCode::Char('w') => {
                    self.context_ledger.why_visible = !self.context_ledger.why_visible;
                }
                _ => {
                    if matches!(key_event.code, KeyCode::Char(_)) {
                        self.context_ledger.focused = false;
                    }
                    return false;
                }
            }
            self.request_redraw();
            return true;
        }

        let sources = self.continuity_sources();
        let selectable = self.selectable_context_source_indexes();
        if selectable.is_empty() {
            if matches!(key_event.code, KeyCode::Esc) {
                self.close_context_ledger();
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
                self.close_context_ledger();
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
        let accounting_sources = self.accounted_continuity_sources();
        let admitted_source_tokens = accounting_sources
            .iter()
            .filter(|source| source.admitted)
            .map(|source| source.estimated_tokens)
            .sum::<u64>();
        // Labels and values identify categories; the palette follows Elpis appearance.
        let brand = crate::style::brand_style().not_bold();
        let background = default_bg();
        let light = background.is_some_and(is_light);
        let muted = Style::default().fg(crate::style::adaptive_palette_color(
            background,
            (80, 81, 75),
            (133, 134, 128),
        ));
        let detail = if light || background.is_none() {
            muted
        } else {
            Style::default().dim()
        };
        let warning = if light || background.is_none() {
            crate::elpis_motion::accent_style().bold()
        } else {
            Style::default().fg(Color::Yellow).bold()
        };
        let context_window = self
            .status_line_context_window_size()
            .map(|window| window as u64);
        // Use the same measured request-context value as `/context` and the status
        // line.  Portable source estimates are attribution only; they must not
        // inflate the headline or percentage beyond what is actually in context.
        let used_tokens = self
            .token_info
            .as_ref()
            .map(|info| info.last_token_usage.tokens_in_context_window())
            .unwrap_or(0)
            .max(0) as u64;
        let has_request_snapshot = self.token_info.is_some();
        let raw_categories = self
            .context_attribution
            .as_ref()
            .map(run_built_context_categories)
            .unwrap_or_default();
        let categories = reconcile_context_categories(&raw_categories, used_tokens);
        let attributed_tokens = self
            .context_attribution
            .as_ref()
            .filter(|_| has_request_snapshot)
            .map(|_| used_tokens);
        let mut attribution_segments = categories
            .iter()
            .map(|category| {
                (
                    category.tokens,
                    super::context_usage::context_display_color(category.color),
                )
            })
            .collect::<Vec<_>>();
        if attribution_segments.is_empty() && has_request_snapshot && used_tokens > 0 {
            attribution_segments.push((used_tokens, Color::DarkGray));
        }
        let source_change_status = if !self.context_ledger.pending_context_admissions.is_empty() {
            Some("changes queued")
        } else if matches!(
            self.manual_memory_cache.pending_mutation,
            Some(ManualMemoryMutation::Admission { .. })
        ) {
            Some("saving change")
        } else if self.context_ledger.projected_token_delta != 0 {
            // Admission estimates describe a future request, not a change to
            // the measured context. Keep its bar and categories in sync with
            // `/context` until core reports the next request's actual usage.
            Some("changes pending")
        } else {
            None
        };
        let context_header = if has_request_snapshot && let Some(status) = source_change_status {
            format!("≈{} tokens now · {status}", format_tokens(used_tokens))
        } else if has_request_snapshot {
            format!("≈{} tokens in context", format_tokens(used_tokens))
        } else if admitted_source_tokens == 0 {
            // Keep the compact idle layout used by the existing popups while making
            // the zero state explicit: no provider request has been measured yet.
            "context not measured · ≈0 source estimates".to_string()
        } else {
            format!(
                "context not measured · ≈{} source estimates",
                format_tokens(admitted_source_tokens)
            )
        };
        let interaction_hint = if self.context_ledger.focused {
            "Up/Down move · Space/Enter toggle · p prune · s subagents · i all · w why · Tab/Esc close"
        } else {
            "Tab controls · Alt+C hide · Ctrl+click open file"
        };
        let mut lines = self.agent_ledger_lines(content_width);
        lines.extend(vec![
            Line::from(vec![
                Span::styled("CONTEXT LEDGER", brand.bold()),
                Span::raw("  "),
                Span::styled(context_header, brand),
            ]),
            Line::from(Span::styled(interaction_hint, muted)),
            Line::from(""),
        ]);
        // A pending request is shown immediately, then reconciled with the next
        // authoritative core snapshot after persistence.
        let pending_smart_prune_enabled = self.context_ledger.pending_smart_prune_enabled;
        let smart_prune_enabled = pending_smart_prune_enabled.unwrap_or(self.smart_prune.enabled);
        let smart_prune_button =
            if !self.smart_prune_synced && pending_smart_prune_enabled.is_none() {
                "[···] SYNC"
            } else if smart_prune_enabled {
                "[━━━●] ON"
            } else {
                "[●━━━] OFF"
            };
        let smart_prune_label = "SMART PRUNE";
        let smart_prune_cursor =
            if self.context_ledger.focused && self.context_ledger.smart_prune_selected {
                "› "
            } else {
                ""
            };
        let smart_prune_pad = content_width
            .saturating_sub(
                smart_prune_label.chars().count()
                    + smart_prune_cursor.chars().count()
                    + smart_prune_button.chars().count(),
            )
            .max(1);
        let smart_prune_line = lines.len();
        let smart_prune_column_start = smart_prune_label.chars().count()
            + smart_prune_pad
            + smart_prune_cursor.chars().count();
        let smart_prune_columns =
            smart_prune_column_start..smart_prune_column_start + smart_prune_button.chars().count();
        let [violet, teal, emerald, green] =
            smart_prune_on_colors(default_bg(), stdout_color_level());
        let toggle_label_spans = |label, enabled| {
            if enabled {
                let mut spans = crate::elpis_motion::animated_text(label, self.config.animations);
                for span in &mut spans {
                    span.style = span.style.add_modifier(ratatui::style::Modifier::BOLD);
                }
                spans
            } else {
                vec![Span::styled(label, Style::default().fg(teal).bold())]
            }
        };
        let switch_spans = if !self.smart_prune_synced && pending_smart_prune_enabled.is_none() {
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
        let mut smart_prune_spans = toggle_label_spans(
            smart_prune_label,
            smart_prune_enabled
                && (self.smart_prune_synced || pending_smart_prune_enabled.is_some()),
        );
        smart_prune_spans.push(Span::raw(" ".repeat(smart_prune_pad)));
        if !smart_prune_cursor.is_empty() {
            smart_prune_spans.push(Span::styled(smart_prune_cursor, brand.bold()));
        }
        smart_prune_spans.extend(switch_spans);
        lines.push(Line::from(smart_prune_spans));
        let smart_prune_detail = if pending_smart_prune_enabled.is_some() {
            "Saving setting · the active turn keeps its current policy".to_string()
        } else if !self.smart_prune_synced {
            "Reading current thread state".to_string()
        } else if self.smart_prune.examined_outputs > 0 {
            format!(
                "{} of {} eligible outputs shortened · ≈{} tokens saved",
                self.smart_prune.admitted_outputs,
                self.smart_prune.examined_outputs,
                format_tokens(self.smart_prune.approx_saved_tokens),
            )
        } else if smart_prune_enabled {
            "Before first main-model send · sent history stays stable".to_string()
        } else {
            "Tool results pass through unchanged".to_string()
        };
        lines.push(Line::from(Span::styled(smart_prune_detail, muted)));
        if self.smart_prune_synced && self.smart_prune.failed_batches > 0 {
            let plural = if self.smart_prune.failed_batches == 1 {
                "batch"
            } else {
                "batches"
            };
            lines.push(Line::from(Span::styled(
                format!(
                    "{} optimizer {plural} failed · originals preserved",
                    self.smart_prune.failed_batches
                ),
                warning,
            )));
        }
        if self.smart_prune_synced && self.smart_prune.optimizer_requests > 0 {
            let usage = if self.smart_prune.optimizer_usage_reports > 0 {
                format!(
                    "{} tokens reported",
                    format_tokens(self.smart_prune.optimizer_usage.total_tokens.max(0) as u64)
                )
            } else {
                "usage unreported".to_string()
            };
            lines.push(Line::from(Span::styled(
                format!(
                    "{} request{} · {} total wait · {usage}",
                    self.smart_prune.optimizer_requests,
                    if self.smart_prune.optimizer_requests == 1 {
                        ""
                    } else {
                        "s"
                    },
                    format_duration_ms(self.smart_prune.optimizer_latency_ms),
                ),
                muted,
            )));
        }
        if self.smart_prune_synced
            && let Some(attempt) = self.smart_prune.latest_attempt.as_ref()
        {
            let status = attempt.status.replace('_', " ");
            let status_style = match attempt.status.as_str() {
                "admitted" => crate::elpis_motion::accent_style(),
                "unchanged" => muted,
                _ => warning,
            };
            lines.push(Line::from(vec![
                Span::styled("Last attempt: ", muted),
                Span::styled(status, status_style),
            ]));
            lines.push(Line::from(Span::styled(
                format!(
                    "{} candidate{} · {} admitted · {}",
                    attempt.candidate_outputs,
                    if attempt.candidate_outputs == 1 {
                        ""
                    } else {
                        "s"
                    },
                    attempt.admitted_outputs,
                    format_duration_ms(attempt.latency_ms),
                ),
                muted,
            )));
            let usage = attempt
                .usage
                .as_ref()
                .map(|usage| {
                    format!(
                        "{} tokens reported",
                        format_tokens(usage.total_tokens.max(0) as u64)
                    )
                })
                .unwrap_or_else(|| "usage unreported".to_string());
            lines.push(Line::from(Span::styled(
                format!(
                    "{} · {} effort · {usage}",
                    attempt.model_slug, attempt.reasoning_effort
                ),
                muted,
            )));
            if let Some(path) = attempt
                .audit_path
                .as_deref()
                .and_then(|path| smart_prune_attempt_evidence_path(&self.config.codex_home, path))
                && let Some(destination) = crate::dashboard_server::evidence_url(
                    &self.config.codex_home,
                    "Smart Prune attempt",
                    &path,
                )
            {
                source_links.push((lines.len(), destination));
                lines.push(Line::from(Span::styled(
                    "Read attempt evidence",
                    crate::elpis_motion::accent_style().underlined(),
                )));
            }
        }
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
        let smart_prune_hint = if pending_smart_prune_enabled.is_some() {
            "Saving… · applies next turn; active turn unchanged"
        } else if !self.smart_prune_synced {
            "Syncing… · /smart-prune on|off sets an explicit state"
        } else if self.is_user_turn_pending_or_running() {
            "p toggle · applies next turn; active turn unchanged"
        } else {
            "p toggle · /smart-prune on|off"
        };
        lines.push(Line::from(Span::styled(smart_prune_hint, muted)));
        lines.push(Line::from(""));

        // Whether the model may hand work to other agents. Flipping it off keeps
        // the whole turn in this thread; the next turn is the first one bound by
        // the new answer, the same as Smart Prune.
        let pending_subagents_enabled = self.context_ledger.pending_subagents_enabled;
        let subagents_enabled =
            pending_subagents_enabled.unwrap_or(self.config.features.enabled(Feature::Collab));
        let subagents_button = if subagents_enabled {
            "[━━━●] ON"
        } else {
            "[●━━━] OFF"
        };
        let subagents_label = "SUBAGENTS";
        let subagents_cursor =
            if self.context_ledger.focused && self.context_ledger.subagents_selected {
                "› "
            } else {
                ""
            };
        let subagents_pad = content_width
            .saturating_sub(
                subagents_label.chars().count()
                    + subagents_cursor.chars().count()
                    + subagents_button.chars().count(),
            )
            .max(1);
        let subagents_line = lines.len();
        let subagents_column_start = subagents_label.chars().count()
            + subagents_pad
            + subagents_cursor.chars().count();
        let subagents_columns =
            subagents_column_start..subagents_column_start + subagents_button.chars().count();
        let subagents_switch_spans = if subagents_enabled {
            vec![
                Span::styled("[", Style::default().fg(teal)),
                Span::styled("━", Style::default().fg(violet)),
                Span::styled("━", Style::default().fg(teal)),
                Span::styled("━", Style::default().fg(emerald)),
                Span::styled("●] ON", Style::default().fg(green).bold()),
            ]
        } else {
            vec![Span::styled(subagents_button, muted)]
        };
        let mut subagents_spans = toggle_label_spans(subagents_label, subagents_enabled);
        subagents_spans.push(Span::raw(" ".repeat(subagents_pad)));
        if !subagents_cursor.is_empty() {
            subagents_spans.push(Span::styled(subagents_cursor, brand.bold()));
        }
        subagents_spans.extend(subagents_switch_spans);
        lines.push(Line::from(subagents_spans));
        // One line, not a block: the ledger's own height is what the owner sees
        // of their sources, and this setting has nothing to report beyond its
        // state. The `s` key is already named in the header hint.
        lines.push(Line::from(Span::styled(
            if pending_subagents_enabled.is_some() {
                "Saving… · applies next turn"
            } else if subagents_enabled {
                "May delegate to other agents"
            } else {
                "All work stays in this thread"
            },
            muted,
        )));
        lines.push(Line::from(""));

        lines.push(Line::from(vec![
            Span::styled("CONTEXT WINDOW", brand.bold()),
            Span::raw("  "),
            Span::styled(
                if let (true, Some(window)) = (has_request_snapshot, context_window) {
                    format!(
                        "≈{} of {} used ({}%)",
                        format_tokens(used_tokens),
                        format_tokens(window),
                        context_used_percent(used_tokens, window),
                    )
                } else if has_request_snapshot {
                    format!("≈{} used · capacity unknown", format_tokens(used_tokens))
                } else {
                    "usage unavailable".to_string()
                },
                muted,
            ),
        ]));
        if let (true, Some(window)) = (has_request_snapshot, context_window) {
            lines.push(usage_bar_line(content_width, window, &attribution_segments));
        }
        if attributed_tokens.is_some() {
            lines.push(Line::from(Span::styled(
                if context_window.is_some() {
                    "MEASURED TOTAL · ESTIMATED CATEGORY SHARES"
                } else {
                    "MEASURED TOTAL · ESTIMATED CATEGORY TOKENS"
                },
                brand.bold(),
            )));
            lines.push(Line::from(Span::styled(
                if context_window.is_some() { "Estimated segments reconcile to measured active context; all shares use the full window" } else { "Estimated categories reconcile to measured active context; capacity unknown" },
                muted,
            )));
            for category in &categories {
                let right = match context_window {
                    Some(window) => format!(
                        "≈{} · {}",
                        format_tokens(category.tokens),
                        format_share(category.tokens, window)
                    ),
                    None => format!("≈{}", format_tokens(category.tokens)),
                };
                let pad = content_width
                    .saturating_sub(2 + 2 + category.label.chars().count() + right.chars().count())
                    .max(1);
                lines.push(Line::from(vec![
                    Span::raw("  "),
                    Span::styled(
                        format!("{} ", category.marker()),
                        Style::default()
                            .fg(super::context_usage::context_display_color(category.color)),
                    ),
                    Span::raw(category.label),
                    Span::raw(" ".repeat(pad)),
                    Span::styled(right, muted),
                ]));
            }
        } else {
            lines.push(Line::from(Span::styled(
                if has_request_snapshot {
                    "Core measured total; category attribution unavailable until the next provider attempt"
                } else {
                    "Context measurement unavailable until the first request snapshot"
                },
                muted,
            )));
        }
        lines.push(Line::from(""));

        if sources.is_empty() {
            lines.push(Line::from(Span::styled(
                "No portable context is available.",
                detail,
            )));
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
                Span::styled(format!("{} ", group.marker()), cat_style),
                Span::styled(group.display_name(), cat_style.bold()),
                Span::raw("  "),
                Span::styled(
                    format!("≈{} tokens admitted", format_tokens(admitted_tokens)),
                    muted,
                ),
            ]));
            for (index, source) in category_sources {
                let source_line_start = lines.len();
                // A switch above can hold the cursor, and then no source does.
                // Without this the mark stayed on whichever row was last chosen
                // and two rows looked selected at once.
                let selected = self.context_ledger.focused
                    && !self.context_ledger.smart_prune_selected
                    && !self.context_ledger.subagents_selected
                    && index == self.context_ledger.selected;
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
                let state_style = if source.admitted {
                    cat_style
                } else if light {
                    muted
                } else {
                    cat_style.dim()
                };
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
                // The row under the cursor wears the Elpis gradient. Bold brand
                // text alone was too close to the rows around it to find at a
                // glance, and every name is underlined already.
                let mut row = vec![
                    Span::styled(prefix, brand),
                    Span::styled(marker, marker_style),
                    Span::raw(" "),
                ];
                if selected {
                    row.extend(crate::elpis_motion::animated_text(
                        &shown_name,
                        self.config.animations,
                    ));
                } else {
                    row.push(Span::styled(
                        shown_name,
                        Style::default()
                            .fg(crate::terminal_palette::default_fg()
                                .map(crate::terminal_palette::best_color)
                                .unwrap_or(if light { Color::Black } else { Color::Reset }))
                            .underlined(),
                    ));
                }
                row.extend(vec![
                    Span::raw(" ".repeat(pad)),
                    Span::styled(
                        format!(
                            "≈{} est. tokens ",
                            format_source_count(source.estimated_tokens),
                        ),
                        muted,
                    ),
                    Span::styled(state, state_style),
                ]);
                lines.push(Line::from(row));

                if selected && self.context_ledger.why_visible {
                    let inclusion = if source.admitted {
                        "Included"
                    } else {
                        "Excluded; when enabled, included"
                    };
                    lines.push(Line::from(Span::styled("WHY INCLUDED", brand.bold())));
                    lines.push(Line::from(Span::styled(source.name.clone(), brand)));
                    lines.push(Line::from(Span::styled(
                        format!("{inclusion} because {}.", source.reason),
                        detail,
                    )));
                    lines.push(Line::from(Span::styled(
                        format!("Lifetime: {}", source.lifetime),
                        detail,
                    )));
                    lines.push(Line::from(Span::styled(
                        format!("Origin: {}", source.origin),
                        detail,
                    )));
                    lines.push(Line::from(Span::styled(
                        format!(
                            "Size: {} bytes · Estimate: ≈{} tokens (trimmed characters ÷ 4, capped)",
                            format_source_count(source.bytes),
                            format_source_count(source.estimated_tokens),
                        ), detail,
                    )));
                    lines.push(Line::from(Span::styled(
                        format!("Source: {}", source.path.display()),
                        detail,
                    )));
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
            subagents_line,
            subagents_columns,
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
            subagents_line,
            subagents_columns,
        } = ledger_lines;
        let brand = crate::style::brand_style().not_bold();

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
        let rows_before_subagents = Paragraph::new(lines[..subagents_line].to_vec())
            .wrap(Wrap { trim: true })
            .line_count(content_width);
        let visible_subagents_row = u16::try_from(rows_before_subagents)
            .ok()
            .and_then(|row| row.checked_sub(scroll_lines))
            .filter(|row| *row < area.height)
            .map(|row| area.y.saturating_add(row));
        self.context_ledger
            .last_subagents_row
            .set(visible_subagents_row);
        let subagents_switch_start = u16::try_from(subagents_columns.start)
            .ok()
            .map(|column| area.x.saturating_add(1).saturating_add(column));
        let subagents_switch_end = u16::try_from(subagents_columns.end)
            .ok()
            .map(|column| area.x.saturating_add(1).saturating_add(column));
        self.context_ledger
            .last_subagents_columns
            .set(subagents_switch_start.zip(subagents_switch_end));
        let tracked_ranges = source_line_ranges
            .into_iter()
            .enumerate()
            .filter(|(_, r)| !r.is_empty())
            .map(|(index, range)| {
                let start =
                    wrapped_line_count(&lines[..range.start.min(lines.len())], content_width);
                let end = wrapped_line_count(&lines[..range.end.min(lines.len())], content_width);
                (index, usize::from(start)..usize::from(end))
            })
            .collect();
        *self.context_ledger.last_source_ranges.borrow_mut() = tracked_ranges;

        Paragraph::new(lines.clone())
            .block(Block::default().borders(Borders::LEFT).border_style(brand))
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
        if self.context_ledger.last_subagents_row.get() == Some(row)
            && self
                .context_ledger
                .last_subagents_columns
                .get()
                .is_some_and(|(start, end)| col >= start && col < end)
        {
            self.toggle_subagents();
            return true;
        }
        let relative_line = (row.saturating_sub(area.y) + scroll) as usize;

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
                    self.context_ledger.smart_prune_selected = false;
                    self.context_ledger.subagents_selected = false;
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

    /// The source under the cursor, if the cursor is on a source rather than on
    /// the Smart Prune switch.
    /// Exercised by tests only; no production path reaches it today.
    #[cfg(test)]
    pub(super) fn selected_continuity_source(
        &self,
    ) -> Option<crate::legacy_core::elpis_context::ContinuitySource> {
        if self.context_ledger.smart_prune_selected {
            return None;
        }
        self.continuity_sources()
            .get(self.context_ledger.selected)
            .cloned()
    }

    pub(crate) fn continuity_sources(
        &self,
    ) -> Vec<crate::legacy_core::elpis_context::ContinuitySource> {
        let mut sources = self.manual_memory_cache.sources.clone();
        for source in &mut sources {
            if let Some(pending) = self
                .context_ledger
                .pending_context_admissions
                .get(&source.name)
            {
                source.admitted = pending.desired;
            }
        }
        if let Some(ManualMemoryMutation::Admission { admitted }) =
            self.manual_memory_cache.pending_mutation
            && let Some(memory_path) = self
                .manual_memory_cache
                .bound_target
                .as_ref()
                .map(|target| target.view.memory_path.as_path())
            && let Some(source) = sources.iter_mut().find(|source| source.path == memory_path)
        {
            source.admitted = admitted;
        }
        sources
    }

    fn accounted_continuity_sources(
        &self,
    ) -> Vec<crate::legacy_core::elpis_context::ContinuitySource> {
        let mut sources = self.manual_memory_cache.sources.clone();
        for source in &mut sources {
            if let Some(pending) = self
                .context_ledger
                .pending_context_admissions
                .get(&source.name)
            {
                source.admitted = pending.original;
            }
        }
        sources
    }

    pub(crate) fn manual_memory_bound_target(&self) -> Option<&ManualMemoryRequestTarget> {
        self.manual_memory_cache.bound_target.as_ref()
    }

    /// Exercised by tests only; no production path reaches it today.
    #[cfg(test)]
    pub(crate) fn manual_memory_phase(&self) -> ManualMemoryPhase {
        self.manual_memory_cache.phase
    }

    /// Exercised by tests only; no production path reaches it today.
    #[cfg(test)]
    pub(crate) fn manual_memory_status(
        &self,
    ) -> Option<&crate::legacy_core::elpis_context::ManualMemoryStatus> {
        self.manual_memory_cache.status.as_ref()
    }

    /// Exercised by tests only; no production path reaches it today.
    #[cfg(test)]
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
        let memory_projection = match (self.manual_memory_cache.pending_mutation, &completion) {
            (
                Some(ManualMemoryMutation::Admission { admitted }),
                ManualMemoryStatusCompletion::Ready { sources, .. },
            ) => {
                let before = self
                    .manual_memory_cache
                    .sources
                    .iter()
                    .find(|source| source.path == target.view.memory_path);
                let after = sources
                    .iter()
                    .find(|source| source.path == target.view.memory_path);
                match (before, after) {
                    (Some(before), Some(after))
                        if before.admitted != admitted && after.admitted == admitted =>
                    {
                        let tokens = i64::try_from(after.estimated_tokens).unwrap_or(i64::MAX);
                        Some(if admitted { tokens } else { -tokens })
                    }
                    _ => None,
                }
            }
            _ => None,
        };
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
        if let Some(delta) = memory_projection {
            self.adjust_context_projection(delta, self.turn_lifecycle.last_turn_id.clone());
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

    /// Selectable rows in the order the panel draws them.
    ///
    /// The panel groups sources under category headers, so walking
    /// `continuity_sources()` in its own order moves the cursor somewhere other
    /// than the next row on screen — which put the Smart Prune switch in the
    /// middle of the run instead of at the top where it is drawn.
    fn selectable_context_source_indexes(&self) -> Vec<usize> {
        let sources = self.continuity_sources();
        LedgerSourceGroup::ALL
            .iter()
            .flat_map(|group| {
                sources
                    .iter()
                    .enumerate()
                    .filter(move |(_, source)| {
                        source.selectable && LedgerSourceGroup::for_source(source) == *group
                    })
                    .map(|(index, _)| index)
            })
            .collect()
    }

    pub(super) fn close_context_ledger(&mut self) {
        self.context_ledger.visible = false;
        self.context_ledger.focused = false;
        self.context_ledger.smart_prune_selected = false;
        self.context_ledger.subagents_selected = false;
        self.context_ledger.pending_g = false;
        self.context_ledger.clear_rendered_geometry();
    }

    /// Position 0 is the Smart Prune switch; the selectable sources follow it.
    /// Walks the ledger cursor. The two switches are its first two stops, in the
    /// order they are drawn, and the admitted sources follow.
    fn move_context_ledger_selection(&mut self, selectable: &[usize], delta: isize) {
        const SWITCH_STOPS: isize = 2;
        let len = selectable.len() as isize + SWITCH_STOPS;
        let current = if self.context_ledger.smart_prune_selected {
            0
        } else if self.context_ledger.subagents_selected {
            1
        } else {
            selectable
                .iter()
                .position(|index| *index == self.context_ledger.selected)
                .unwrap_or(0) as isize
                + SWITCH_STOPS
        };
        let next = (current + delta).rem_euclid(len);
        self.context_ledger.smart_prune_selected = next == 0;
        self.context_ledger.subagents_selected = next == 1;
        if next >= SWITCH_STOPS {
            self.context_ledger.selected = selectable[(next - SWITCH_STOPS) as usize];
        }
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
        if self.is_user_turn_pending_or_running() {
            let manual_memory_actionable = self.manual_memory_can_toggle();
            for source in sources.iter().filter(|source| {
                is_bulk_context_source_actionable(
                    source,
                    manual_memory_path.as_deref(),
                    manual_memory_actionable,
                ) && source.admitted != admitted
            }) {
                self.stage_context_source_admission(source, admitted);
            }
            return;
        }
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
            self.apply_cached_context_source_admission(source, admitted);
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
        if self.is_user_turn_pending_or_running() {
            self.add_info_message(
                "Remove files after the active turn; Space can queue an exclusion now.".to_string(),
                None,
            );
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
                self.apply_cached_context_source_admission(source, /*admitted*/ false);
                self.manual_memory_cache
                    .sources
                    .retain(|cached| cached.name != source.name);
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
        if self.is_user_turn_pending_or_running() {
            return self.stage_context_source_admission(source, admitted);
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
        if updated {
            self.apply_cached_context_source_admission(source, admitted);
        }
        self.request_manual_memory_status_refresh();
        updated
    }

    fn apply_cached_context_source_admission(
        &mut self,
        source: &crate::legacy_core::elpis_context::ContinuitySource,
        admitted: bool,
    ) {
        let delta = self.update_cached_context_source_admission(&source.name, admitted);
        self.adjust_context_projection(delta, self.turn_lifecycle.last_turn_id.clone());
    }

    fn update_cached_context_source_admission(&mut self, name: &str, admitted: bool) -> i64 {
        let mut delta = 0i64;
        for cached in self
            .manual_memory_cache
            .sources
            .iter_mut()
            .filter(|cached| cached.name == name)
        {
            if cached.admitted == admitted {
                continue;
            }
            cached.admitted = admitted;
            let tokens = i64::try_from(cached.estimated_tokens).unwrap_or(i64::MAX);
            delta = delta.saturating_add(if admitted { tokens } else { -tokens });
        }
        delta
    }

    fn stage_context_source_admission(
        &mut self,
        source: &crate::legacy_core::elpis_context::ContinuitySource,
        admitted: bool,
    ) -> bool {
        if source.admitted == admitted {
            return false;
        }
        let name = source.name.clone();
        if let Some(pending) = self
            .context_ledger
            .pending_context_admissions
            .get_mut(&name)
        {
            pending.desired = admitted;
            if pending.desired == pending.original {
                self.context_ledger.pending_context_admissions.remove(&name);
            }
        } else {
            self.context_ledger.pending_context_admissions.insert(
                name,
                PendingContextAdmission {
                    original: source.admitted,
                    desired: admitted,
                },
            );
        }
        true
    }

    pub(super) fn commit_staged_context_admissions(&mut self, completed_turn_id: &str) {
        let pending = std::mem::take(&mut self.context_ledger.pending_context_admissions);
        if pending.is_empty() {
            return;
        }
        let mut projected_delta = 0i64;
        for (name, change) in pending {
            match crate::legacy_core::elpis_context::set_continuity_source_admitted(
                Some(self.config.memory_dir.as_path()),
                self.config.cwd.as_path(),
                &name,
                change.desired,
            ) {
                Ok(()) => {
                    projected_delta = projected_delta.saturating_add(
                        self.update_cached_context_source_admission(&name, change.desired),
                    );
                }
                Err(error) => self.add_error_message(format!(
                    "Could not apply queued context admission for {name}: {error}"
                )),
            }
        }
        self.adjust_context_projection(projected_delta, Some(completed_turn_id.to_string()));
        self.request_manual_memory_status_refresh();
    }

    pub(super) fn reconcile_context_projection_for_turn(&mut self, turn_id: &str) {
        if self.context_ledger.projected_token_delta == 0
            || self.context_ledger.projection_baseline_turn_id.as_deref() == Some(turn_id)
        {
            return;
        }
        self.context_ledger.projected_token_delta = 0;
        self.context_ledger.projection_baseline_turn_id = None;
        self.app_event_tx.send(AppEvent::RefreshContextDashboard);
        self.request_redraw();
    }

    fn adjust_context_projection(&mut self, delta: i64, baseline_turn_id: Option<String>) {
        if delta == 0 {
            return;
        }
        self.context_ledger.projected_token_delta = self
            .context_ledger
            .projected_token_delta
            .saturating_add(delta);
        if self.context_ledger.projected_token_delta == 0 {
            self.context_ledger.projection_baseline_turn_id = None;
        } else {
            self.context_ledger.projection_baseline_turn_id = baseline_turn_id;
        }
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
    let total_tokens = segments
        .iter()
        .map(|(tokens, _)| *tokens)
        .sum::<u64>()
        .min(context_window);
    let cells_used = ((total_tokens as u128 * bar_width as u128
        + u128::from(context_window.max(1)) / 2)
        / u128::from(context_window.max(1))) as usize;
    let counts = weighted_cell_counts(
        &segments
            .iter()
            .map(|(tokens, _)| *tokens)
            .collect::<Vec<_>>(),
        cells_used,
    );
    for ((_, color), cells) in segments.iter().zip(counts) {
        if cells > 0 {
            spans.push(Span::styled("█".repeat(cells), Style::default().fg(*color)));
        }
    }
    if cells_used < bar_width {
        spans.push(Span::styled(
            "░".repeat(bar_width - cells_used),
            super::context_usage::context_free_style(),
        ));
    }
    Line::from(spans)
}

fn format_tokens(tokens: u64) -> String {
    if tokens < 1_000 {
        tokens.to_string()
    } else {
        format!("{:.1}k", tokens as f64 / 1_000.0)
    }
}

fn format_share(tokens: u64, total: u64) -> String {
    if total == 0 {
        return "0.0%".to_string();
    }
    let tenths = (u128::from(tokens) * 1_000 + u128::from(total) / 2) / u128::from(total);
    format!("{}.{:01}%", tenths / 10, tenths % 10)
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
    if terminal_bg.is_none() {
        return [Color::Reset; 4];
    }
    if matches!(
        color_level,
        StdoutColorLevel::Ansi16 | StdoutColorLevel::Unknown
    ) {
        return [if terminal_bg.is_some_and(is_light) {
            Color::Black
        } else {
            Color::Yellow
        }; 4];
    }

    let palette = if terminal_bg.is_some_and(is_light) {
        [(145, 76, 0), (122, 95, 0), (96, 72, 24), (166, 99, 0)]
    } else {
        [
            (211, 126, 22),
            (248, 185, 52),
            (241, 219, 110),
            (184, 156, 89),
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

fn format_duration_ms(milliseconds: u64) -> String {
    if milliseconds >= 1_000 {
        format!("{:.1}s", milliseconds as f64 / 1_000.0)
    } else {
        format!("{milliseconds}ms")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_ledger_accents_have_readable_contrast_and_distinct_brightness() {
        let luminance = |rgb: (u8, u8, u8)| {
            let linear = |v: u8| {
                let v = f64::from(v) / 255.0;
                if v <= 0.04045 {
                    v / 12.92
                } else {
                    ((v + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * linear(rgb.0) + 0.7152 * linear(rgb.1) + 0.0722 * linear(rgb.2)
        };
        let mut levels = Vec::new();
        for color in smart_prune_on_colors(Some((17, 18, 20)), StdoutColorLevel::TrueColor) {
            let Color::Rgb(r, g, b) = color else {
                panic!("expected truecolor")
            };
            let level = luminance((r, g, b));
            assert!((level + 0.05) / (luminance((17, 18, 20)) + 0.05) >= 4.5);
            levels.push(level);
        }
        levels.sort_by(f64::total_cmp);
        assert!(
            levels[3] - levels[0] > 0.35,
            "categories need distinct brightness"
        );
    }

    #[test]
    fn ledger_source_palette_stays_in_the_gold_family() {
        for bg in [(255, 255, 255), (17, 18, 20)] {
            crate::terminal_palette::with_test_default_colors(
                crate::terminal_probe::DefaultColors {
                    fg: (120, 120, 120),
                    bg,
                },
                || {
                    for color in LedgerSourceGroup::ALL.map(LedgerSourceGroup::color) {
                        match color {
                            Color::Rgb(r, g, b) => assert!(r >= g && g > b),
                            Color::Black if is_light(bg) => {}
                            Color::Yellow | Color::Indexed(_) => {}
                            other => panic!("unexpected ledger accent: {other:?}"),
                        }
                    }
                },
            );
        }
    }

    #[test]
    fn smart_prune_palette_uses_a_readable_low_color_fallback() {
        for level in [
            StdoutColorLevel::TrueColor,
            StdoutColorLevel::Ansi256,
            StdoutColorLevel::Ansi16,
            StdoutColorLevel::Unknown,
        ] {
            assert_eq!(smart_prune_on_colors(None, level), [Color::Reset; 4]);
        }
        assert_eq!(
            smart_prune_on_colors(
                Some((0, 0, 0)),
                crate::terminal_palette::StdoutColorLevel::Ansi16,
            ),
            [Color::Yellow; 4]
        );
        assert_eq!(
            smart_prune_on_colors(Some((255, 255, 255)), StdoutColorLevel::Ansi16),
            [Color::Black; 4]
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
                Color::Rgb(145, 76, 0),
                Color::Rgb(122, 95, 0),
                Color::Rgb(96, 72, 24),
                Color::Rgb(166, 99, 0),
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
    fn usage_bar_never_fills_more_cells_than_total_usage() {
        let line = usage_bar_line(
            12,
            1_000,
            &[
                (25, Color::Blue),
                (25, Color::Green),
                (25, Color::Yellow),
                (25, Color::Magenta),
            ],
        );
        let filled = line
            .spans
            .iter()
            .map(|span| span.content.matches('█').count())
            .sum::<usize>();
        assert_eq!(filled, 1, "100/1000 of a ten-cell bar is one cell");
    }
}
