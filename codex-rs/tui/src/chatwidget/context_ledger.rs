//! Persistent, user-controlled view of Elpis-owned portable context.

use super::context_usage::CONTEXT_CATEGORY_MARKER;
use super::context_usage::category_bar_spans;
use super::context_usage::context_used_percent;
use super::context_usage::reconcile_context_categories;
use super::context_usage::run_built_context_categories;
use super::elpis_ledger_glue::ManualMemoryCache;
use super::elpis_ledger_glue::ManualMemoryPhase;
use super::elpis_ledger_glue::elpis_memory_dir;
use super::elpis_providers::CLAUDE_SUBSCRIPTION_PROVIDER_ID;
use super::elpis_providers::bridged_provider_of_model;
use super::*;
use crate::elpis_app_event::ElpisAppEvent;
use crate::elpis_ledger_events::ManualMemoryMutation;
use crate::elpis_ledger_events::ManualMemoryRequestTarget;
use crate::elpis_ledger_events::ManualMemoryStatusCompletion;
use ratatui::style::Color;
use ratatui::text::Span;
use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;

use crate::color::is_light;
use crate::terminal_palette::StdoutColorLevel;
use crate::terminal_palette::default_bg;
use crate::terminal_palette::default_fg;
use crate::terminal_palette::effective_stdout_color_level;

const CONTEXT_LEDGER_TITLE: &str = "CONTEXT LEDGER";
const LEDGER_MIN_TERMINAL_WIDTH: u16 = 80;
const LEDGER_WIDTH: u16 = 52;
/// A dragged Ledger keeps at least this many columns, so its rows stay readable...
const LEDGER_MIN_WIDTH: u16 = 28;
/// ...and leaves the transcript and composer at least this many.
const LEDGER_MIN_MAIN_WIDTH: u16 = 40;
/// Drag eight columns beyond the readable minimum to preview closing the pane.
const LEDGER_CLOSE_WIDTH: i32 = (LEDGER_MIN_WIDTH - 8) as i32;
/// The rule and the blank column beside it are the handle for resizing the Ledger.
const LEDGER_HANDLE_COLS: u16 = 2;
/// The rule column and one blank column before the text.
const LEDGER_LEFT_COLS: u16 = 2;
/// Codex keeps its last columns free: its footer hints stop `FOOTER_INDENT_COLS` before the
/// edge. The native inline Ledger keeps the same margin.
const LEDGER_RIGHT_MARGIN: u16 = crate::ui_consts::FOOTER_INDENT_COLS as u16;
const LEDGER_CLOSE_BUTTON_WIDTH: u16 = 3;

/// Columns of the Ledger column on a terminal `terminal_width` wide: none below
/// `LEDGER_MIN_TERMINAL_WIDTH`, otherwise 52 or two fifths of the terminal.
#[cfg(test)]
pub(crate) fn ledger_column_width(terminal_width: u16) -> u16 {
    ledger_column_width_for(terminal_width, /*preferred*/ None)
}

/// The same, for a Ledger the user has resized to `preferred` columns. The width is clamped so
/// both the Ledger and the transcript stay usable on this terminal.
pub(crate) fn ledger_column_width_for(terminal_width: u16, preferred: Option<u16>) -> u16 {
    if terminal_width < LEDGER_MIN_TERMINAL_WIDTH {
        return 0;
    }
    match preferred {
        Some(width) => width.clamp(
            LEDGER_MIN_WIDTH,
            terminal_width
                .saturating_sub(LEDGER_MIN_MAIN_WIDTH)
                .max(LEDGER_MIN_WIDTH),
        ),
        None => LEDGER_WIDTH.min(terminal_width * 2 / 5),
    }
}

/// The Ledger column as the startup screen draws it, before a session exists: the rule and the
/// title, where the live Ledger will be. `column` is the whole column and `title_row` the row the
/// live Ledger starts on.
pub(crate) fn render_startup_ledger_column(column: Rect, title_row: u16, buf: &mut Buffer) {
    let top = title_row.clamp(column.top(), column.bottom());
    let area = Rect {
        y: top,
        height: column.bottom() - top,
        ..column
    };
    render_ledger_rule(area, &[], buf);
    let content_width =
        ledger_content_width(area.width, false).min(area.width.saturating_sub(LEDGER_LEFT_COLS));
    if content_width == 0 || area.height == 0 {
        return;
    }
    let muted = Style::default().fg(crate::style::adaptive_palette_color(
        default_bg(),
        (80, 81, 75),
        (133, 134, 128),
    ));
    let mut title = crate::status_indicator_widget::ledger_title_shimmer(
        CONTEXT_LEDGER_TITLE,
        std::time::Duration::ZERO,
        crate::motion::MotionMode::Reduced,
    );
    title.extend([Span::raw("  "), Span::styled("loading", muted)]);
    Paragraph::new(Line::from(title)).render(
        Rect::new(
            area.x + LEDGER_LEFT_COLS,
            area.y,
            content_width,
            /*height*/ 1,
        ),
        buf,
    );
}

/// The columns for the Ledger's text in a Ledger `ledger_width` columns wide.
fn ledger_content_width(ledger_width: u16, close_button: bool) -> u16 {
    // The owned column reserves the whole button and one cell at the screen edge on every
    // row, including source rows that scroll to the top. Inline rendering keeps Codex's margin.
    let right_margin = if close_button {
        LEDGER_CLOSE_BUTTON_WIDTH + 1
    } else {
        LEDGER_RIGHT_MARGIN
    };
    ledger_width
        .saturating_sub(LEDGER_LEFT_COLS + right_margin)
        .max(1)
}
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
}

/// The ledger's rendered content: its rows, already wrapped to the content width with Codex's
/// wrapper, the row range each source occupies (for selection scrolling), and
/// `(row index, file:// destination)` for each row of a source that is a real file on disk.
pub(super) struct LedgerLines {
    rows: Vec<Line<'static>>,
    title_rows: std::ops::Range<usize>,
    source_row_ranges: Vec<std::ops::Range<usize>>,
    source_links: Vec<(usize, String)>,
    click_targets: Vec<(std::ops::Range<usize>, LedgerClickTarget)>,
}

/// What a plain left click on a Ledger row does: the same as Space on that row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LedgerClickTarget {
    Close,
    SmartPrune,
    Subagents,
    Source(usize),
}

/// Where the last drawn Ledger sits on screen, so a click can be traced back to its row.
struct LedgerClickMap {
    close_button: Option<Rect>,
    content: Rect,
    scroll_rows: u16,
    targets: Vec<(std::ops::Range<usize>, LedgerClickTarget)>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PendingContextAdmission {
    original: bool,
    desired: bool,
}

/// A captured divider drag survives the preview that temporarily hides its column.
struct LedgerResize {
    pressed_at: u16,
    width_then: u16,
    terminal_width: u16,
    restore_width: Option<u16>,
    collapsed: bool,
}

pub(super) struct ContextLedgerState {
    visible: bool,
    title_started_at: Instant,
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
    /// Full screen only: the Ledger would leave the transcript too few rows, so it hides
    /// until Alt+C focuses it.
    crowded: std::cell::Cell<bool>,
    /// Full screen only, where Elpis owns the mouse: written by each draw, read by a click.
    click_map: std::cell::RefCell<Option<LedgerClickMap>>,
    /// The width the user dragged the Ledger to; `None` keeps the default for the terminal.
    pub(super) preferred_width: Option<u16>,
    /// Full screen only: the column as last drawn, for hit-testing its rule.
    pub(super) column: std::cell::Cell<Option<Rect>>,
    /// The captured drag, including the preference to restore if it snaps closed.
    resize_anchor: Option<LedgerResize>,
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
            title_started_at: Instant::now(),
            focused: false,
            selected: 0,
            smart_prune_selected: false,
            subagents_selected: false,
            pending_g: false,
            why_visible: false,
            crowded: std::cell::Cell::new(false),
            click_map: std::cell::RefCell::new(None),
            preferred_width: None,
            column: std::cell::Cell::new(None),
            resize_anchor: None,
            pending_smart_prune_enabled: None,
            pending_subagents_enabled: None,
            projected_token_delta: 0,
            projection_baseline_turn_id: None,
            pending_context_admissions: std::collections::BTreeMap::new(),
        }
    }
}

impl ChatWidget {
    pub(crate) fn context_ledger_has_focus(&self) -> bool {
        self.context_ledger.visible && self.context_ledger.focused
    }

    pub(crate) fn unfocus_context_ledger(&mut self) {
        self.context_ledger.focused = false;
        self.context_ledger.pending_g = false;
    }

    /// The ledger is a sidebar shown by default and controlled with `Alt+C`:
    /// Alt+C focuses the sidebar, then closes it. Tab closes only a focused sidebar.
    /// On narrower terminals it takes a proportional slice instead of a fixed
    /// 52 columns so the composer keeps room.
    ///
    /// A modal view (a menu, a prompt) hides it. The warnings panel does not: it sits above the
    /// composer, and a startup warning must not make the Ledger look missing.
    pub(crate) fn context_ledger_width(&self, terminal_width: u16) -> u16 {
        if !self.context_ledger.visible
            || self
                .context_ledger
                .resize_anchor
                .as_ref()
                .is_some_and(|drag| drag.collapsed)
            || self.bottom_pane.has_active_modal()
            || (self.context_ledger.crowded.get() && !self.context_ledger.focused)
        {
            return 0;
        }
        ledger_column_width_for(terminal_width, self.context_ledger.preferred_width)
    }

    /// Resizing the Ledger by its rule (full screen, where Elpis owns the mouse). A press on the
    /// rule starts a drag, moving it left or right sets the width, and releasing ends it. Returns
    /// whether the event was part of that drag; a press anywhere else is not.
    pub(crate) fn handle_context_ledger_divider_mouse(
        &mut self,
        mouse: crossterm::event::MouseEvent,
    ) -> bool {
        use crossterm::event::MouseButton::Left;
        use crossterm::event::MouseEventKind::Down;
        use crossterm::event::MouseEventKind::Drag;
        use crossterm::event::MouseEventKind::Up;

        match mouse.kind {
            Down(Left) => {
                let Some(column) = self.context_ledger.column.get() else {
                    return false;
                };
                let on_handle = self.context_ledger_width(column.right()) > 0
                    && mouse.modifiers.is_empty()
                    && (column.x..column.x + LEDGER_HANDLE_COLS).contains(&mouse.column)
                    && (column.top()..column.bottom()).contains(&mouse.row);
                self.context_ledger.resize_anchor = on_handle.then_some(LedgerResize {
                    pressed_at: mouse.column,
                    width_then: column.width,
                    terminal_width: column.right(),
                    restore_width: self.context_ledger.preferred_width,
                    collapsed: false,
                });
                on_handle
            }
            Drag(Left) | Up(Left) => {
                let Some(mut drag) = self.context_ledger.resize_anchor.take() else {
                    return false;
                };
                self.update_context_ledger_resize(&mut drag, mouse.column);
                if mouse.kind == Up(Left) {
                    if drag.collapsed {
                        self.context_ledger.preferred_width = drag.restore_width;
                        self.close_context_ledger();
                    } else if self.context_ledger.preferred_width != drag.restore_width
                        && let Some(width) = self.context_ledger.preferred_width
                    {
                        self.local_settings.tui.context_ledger_width = Some(width);
                        self.app_event_tx
                            .send(AppEvent::PersistContextLedgerWidth(width));
                    }
                } else {
                    self.context_ledger.resize_anchor = Some(drag);
                }
                self.request_redraw();
                true
            }
            _ => false,
        }
    }

    fn update_context_ledger_resize(&mut self, drag: &mut LedgerResize, pointer: u16) {
        let width = i32::from(drag.width_then) + i32::from(drag.pressed_at) - i32::from(pointer);
        if width <= LEDGER_CLOSE_WIDTH {
            drag.collapsed = true;
            self.context_ledger.preferred_width = drag.restore_width;
        } else if drag.collapsed {
            // Re-entering the open region restores the saved width immediately. Subsequent
            // movement resizes from here, without making the pointer jump to the restored rule.
            drag.collapsed = false;
            self.context_ledger.preferred_width = drag.restore_width;
            drag.pressed_at = pointer;
            drag.width_then = ledger_column_width_for(drag.terminal_width, drag.restore_width);
        } else if pointer == drag.pressed_at {
            self.context_ledger.preferred_width = drag.restore_width;
        } else {
            self.context_ledger.preferred_width = Some(ledger_column_width_for(
                drag.terminal_width,
                Some(u16::try_from(width.max(0)).unwrap_or(0)),
            ));
        }
    }

    /// Keep at least this many transcript rows above the Ledger in either terminal mode.
    const MIN_TRANSCRIPT_ROWS: u16 = 8;

    /// An unfocused Ledger that would leave the transcript fewer than `MIN_TRANSCRIPT_ROWS`
    /// rows hides; Alt+C still opens it whole.
    pub(crate) fn fit_context_ledger_to_screen(&self, screen: ratatui::layout::Size) {
        self.context_ledger.crowded.set(false);
        let width = self.context_ledger_width(screen.width);
        if width == 0 || self.context_ledger.focused {
            return;
        }
        let height = self.context_ledger_desired_height(width);
        self.context_ledger
            .crowded
            .set(height + Self::MIN_TRANSCRIPT_ROWS > screen.height);
    }

    /// Full screen gives the Ledger its own full-height column, so its height never takes
    /// rows from the transcript and it is never crowded out.
    pub(crate) fn fit_context_ledger_column(&self) {
        self.context_ledger.crowded.set(false);
    }

    pub(super) fn context_ledger_desired_height(&self, ledger_width: u16) -> u16 {
        self.context_ledger_lines_with_height(ledger_width, false)
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
        close_button: bool,
    ) -> Option<(u16, LedgerLines)> {
        if !self.context_ledger.visible || ledger_width == 0 {
            return None;
        }
        // The rows are wrapped once, with the same wrapper that draws them, so the height is
        // their count and the panel cannot be measured differently from what it draws.
        let ledger_lines = self.ledger_lines(usize::from(ledger_content_width(
            ledger_width,
            close_button,
        )));
        let height = u16::try_from(ledger_lines.rows.len()).unwrap_or(u16::MAX);
        Some((height, ledger_lines))
    }

    pub(super) fn handle_context_ledger_key_event(&mut self, key_event: KeyEvent) -> bool {
        if key_event.kind != KeyEventKind::Press {
            return false;
        }
        let is_tab = matches!(key_event.code, KeyCode::Tab) && key_event.modifiers.is_empty();
        // Voice mute and chords are routed by App first. Menus and explicit user
        // bindings keep Ctrl+X; Alt+C remains the existing Ledger shortcut.
        let is_ctrl_x = key_hint::ctrl(KeyCode::Char('x')).is_press(key_event)
            && self.bottom_pane.no_modal_or_popup_active()
            && !crate::keymap::configured_main_surface_alias_is_used(
                &self.local_settings.tui.keymap,
                "ctrl-x",
            );
        // Elpis: Tab moves between the composer and the Ledger unless a menu, popup or pasted
        // text owns it, or the user explicitly bound Tab to queueing.
        let tab_toggles = is_tab
            && (self.context_ledger.focused
                || (self.bottom_pane.no_modal_or_popup_active()
                    && !self.bottom_pane.is_in_paste_burst()
                    && !self.bottom_pane.is_composer_queue_key(key_event)));
        let is_toggle_key =
            tab_toggles || key_hint::alt(KeyCode::Char('c')).is_press(key_event) || is_ctrl_x;
        if is_toggle_key {
            let crowded_out = self.context_ledger.crowded.get() && !self.context_ledger.focused;
            if !self.context_ledger.visible || crowded_out || !self.context_ledger.focused {
                if !self.context_ledger.visible || crowded_out {
                    self.context_ledger.title_started_at = Instant::now();
                }
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
            }
            self.context_ledger.pending_g = false;
            self.request_redraw();
            return true;
        }
        let ledger_is_rendered = self.context_ledger.visible
            && self
                .last_rendered_width
                .get()
                .is_some_and(|width| width >= LEDGER_MIN_TERMINAL_WIDTH);
        if !ledger_is_rendered {
            return false;
        }
        // The panel says "Tab/Esc close", and the owner reads that from the
        // composer too. Esc still belongs to a running turn and to a composer
        // with something in it; when it would otherwise do nothing, it closes
        // the panel that claims it.
        if !self.context_ledger.focused {
            // A dismissible banner ("esc to dismiss") takes Esc before the panel does.
            let esc_is_idle = matches!(key_event.code, KeyCode::Esc)
                && !self.bottom_pane.has_active_view()
                && !self.bottom_pane.is_task_running()
                && !self.bottom_pane.inline_banner_accepts_dismissal()
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
                    if matches!(key_event.code, KeyCode::Char(_) | KeyCode::Backspace) {
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
            KeyCode::Delete => {
                let source = sources[self.context_ledger.selected].clone();
                self.remove_context_source(&source, &selectable);
            }
            _ => {
                // Typing, Backspace included, belongs to the draft.
                if matches!(key_event.code, KeyCode::Char(_) | KeyCode::Backspace) {
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
        let context = crate::style::context_style();
        let section = crate::style::section_style();
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
            attribution_segments.push((used_tokens, context.fg.unwrap_or(Color::Reset)));
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
            "Alt+C controls · Ctrl+click open file"
        };
        let mut lines = self.agent_ledger_lines(content_width);
        let title_line = lines.len();
        let mut title = crate::status_indicator_widget::ledger_title_shimmer(
            CONTEXT_LEDGER_TITLE,
            self.context_ledger.title_started_at.elapsed(),
            crate::motion::MotionMode::from_animations_enabled(
                self.local_settings.tui.animations && self.local_settings.tui.effects.shimmer,
            ),
        );
        title.extend([Span::raw("  "), Span::styled(context_header, context)]);
        // The close button sits in the column's wider right margin; one blank column keeps
        // the title off its padding.
        let title = crate::line_truncation::truncate_line_with_ellipsis_if_overflow(
            Line::from(title),
            content_width.saturating_sub(1),
        );
        lines.extend(vec![
            title,
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
        // The cursor leads the row, as it does on every source below. Placed
        // after the label it sat against the switch and read as part of it,
        // which is why a selected switch looked no different from an idle one.
        let smart_prune_cursor =
            if self.context_ledger.focused && self.context_ledger.smart_prune_selected {
                "› "
            } else {
                // An idle row has no cursor and no leading blanks.
                ""
            };
        let smart_prune_pad = content_width
            .saturating_sub(
                smart_prune_cursor.width() + smart_prune_label.width() + smart_prune_button.width(),
            )
            .max(1);
        let switch_spans = if !self.smart_prune_synced && pending_smart_prune_enabled.is_none() {
            vec![Span::styled(smart_prune_button, section.bold())]
        } else if smart_prune_enabled {
            vec![Span::styled("[━━━●] ON", context)]
        } else {
            vec![Span::styled(smart_prune_button, muted)]
        };
        let mut smart_prune_spans = vec![Span::styled(smart_prune_cursor, brand.bold())];
        smart_prune_spans.push(Span::styled(smart_prune_label, section.bold()));
        smart_prune_spans.push(Span::raw(" ".repeat(smart_prune_pad)));
        smart_prune_spans.extend(switch_spans);
        let smart_prune_line = lines.len();
        lines.push(Line::from(smart_prune_spans));
        // Elpis: a Claude chat's requests go through the Claude bridge's Smart Prune proxy while
        // the switch is on (`tools/elpis-claude`); an Antigravity chat's go to Google unseen.
        let bridged = bridged_provider_of_model(self.current_model());
        let smart_prune_detail = if bridged.is_some_and(|b| b.id != CLAUDE_SUBSCRIPTION_PROVIDER_ID)
        {
            "Does not apply to Antigravity chats".to_string()
        } else if bridged.is_some() && smart_prune_enabled {
            "Large tool results shrink through the Claude proxy".to_string()
        } else if pending_smart_prune_enabled.is_some() {
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
            // Elpis: the attempt's audit record opens as a readable report.
            if let Some(path) = attempt.audit_path.as_deref().and_then(|path| {
                super::elpis_dashboard::smart_prune_attempt_evidence_path(
                    self.config.codex_home.as_path(),
                    path,
                )
            }) && let Some(destination) = crate::dashboard_server::evidence_url(
                self.config.codex_home.as_path(),
                "Smart Prune attempt",
                &path,
            ) {
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
                subagents_cursor.width() + subagents_label.width() + subagents_button.width(),
            )
            .max(1);
        let subagents_switch_spans = if subagents_enabled {
            vec![Span::styled("[━━━●] ON", context)]
        } else {
            vec![Span::styled(subagents_button, muted)]
        };
        let mut subagents_spans = vec![Span::styled(subagents_cursor, brand.bold())];
        subagents_spans.push(Span::styled(subagents_label, section.bold()));
        subagents_spans.push(Span::raw(" ".repeat(subagents_pad)));
        subagents_spans.extend(subagents_switch_spans);
        let subagents_line = lines.len();
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
            Span::styled("CONTEXT WINDOW", context.bold()),
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
                context,
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
                let marker = format!("{CONTEXT_CATEGORY_MARKER} ");
                let pad = content_width
                    .saturating_sub(2 + marker.width() + category.label.width() + right.width())
                    .max(1);
                lines.push(Line::from(vec![
                    Span::raw("  "),
                    Span::styled(
                        marker,
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
            let cat_style = source_heading_style();
            lines.push(Line::from(vec![
                Span::styled(format!("{CONTEXT_CATEGORY_MARKER} "), cat_style),
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
                let state_style = if source.admitted { context } else { muted };
                let marker_style = if source.admitted { context } else { muted };
                let prefix = if selected { "› " } else { "  " };
                // Per-source estimates stay exact so similarly sized files remain
                // distinguishable; category and context totals remain compact.
                let right = format!(
                    "≈{} est. tokens {state}",
                    format_source_count(source.estimated_tokens),
                );
                // "› " + "[x]" + " " ahead of the name; truncate long names from the
                // left with '…' so the token count and state stay right-aligned. Widths are
                // terminal columns, as Codex measures them, not character counts.
                let fixed = prefix.width() + marker.width() + 1;
                let name_budget = content_width
                    .saturating_sub(fixed + right.width() + 1)
                    .max(1);
                let shown_name = truncate_start_to_width(&source.name, name_budget);
                let pad = content_width
                    .saturating_sub(fixed + shown_name.width())
                    .saturating_sub(right.width())
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
                    lines.push(Line::from(Span::styled("WHY INCLUDED", section.bold())));
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

        let (rows, row_starts) = wrap_ledger_rows(&lines, content_width);
        let row_of = |line: usize| row_starts[line.min(lines.len())];
        let mut click_targets = vec![
            (
                row_of(smart_prune_line)..row_of(smart_prune_line + 1),
                LedgerClickTarget::SmartPrune,
            ),
            (
                row_of(subagents_line)..row_of(subagents_line + 1),
                LedgerClickTarget::Subagents,
            ),
        ];
        click_targets.extend(
            source_line_ranges
                .iter()
                .enumerate()
                .filter(|(index, _)| sources[*index].selectable)
                .map(|(index, range)| {
                    (
                        row_of(range.start)..row_of(range.end),
                        LedgerClickTarget::Source(index),
                    )
                }),
        );
        let source_row_ranges = source_line_ranges
            .into_iter()
            .map(|range| row_of(range.start)..row_of(range.end))
            .collect();
        // Each row of a linked line opens the same file.
        let source_links = source_links
            .into_iter()
            .flat_map(|(line, destination)| {
                (row_of(line)..row_of(line + 1)).map(move |row| (row, destination.clone()))
            })
            .collect();
        LedgerLines {
            title_rows: row_of(title_line)..row_of(title_line + 1),
            rows,
            source_row_ranges,
            source_links,
            click_targets,
        }
    }

    #[cfg(test)]
    pub(super) fn render_context_ledger(&self, area: Rect, buf: &mut Buffer) {
        let ledger_lines = self.ledger_lines(usize::from(ledger_content_width(
            area.width,
            self.context_ledger.column.get() == Some(area),
        )));
        self.render_context_ledger_lines(area, buf, ledger_lines, /*box_rules*/ &[]);
    }

    /// Draws the Ledger in `area`: its rule in the first column, then its rows after one blank
    /// column, so that Codex's right margin stays free. `box_rules` holds the rows of the top
    /// and bottom rules of each box that ends on the Ledger's rule.
    pub(super) fn render_context_ledger_lines(
        &self,
        area: Rect,
        buf: &mut Buffer,
        ledger_lines: LedgerLines,
        box_rules: &[(u16, u16)],
    ) {
        let LedgerLines {
            rows,
            title_rows,
            source_row_ranges,
            source_links,
            click_targets,
        } = ledger_lines;
        self.forget_context_ledger_clicks();
        render_ledger_rule(area, box_rules, buf);
        let owned_column = self.context_ledger.column.get() == Some(area);
        let content_width = ledger_content_width(area.width, owned_column)
            .min(area.width.saturating_sub(LEDGER_LEFT_COLS));
        if content_width == 0 || area.height == 0 {
            return;
        }
        let content = Rect::new(
            area.x + LEDGER_LEFT_COLS,
            area.y,
            content_width,
            area.height,
        );
        let scroll_rows = if self.context_ledger.focused {
            source_row_ranges
                .get(self.context_ledger.selected)
                .map(|rows| selected_source_scroll_offset(rows.clone(), area.height))
                .unwrap_or(0)
        } else {
            0
        };
        if let Some(delay) =
            self.ledger_title_animation_delay(&title_rows, scroll_rows, area.height)
        {
            self.frame_requester.schedule_frame_in(delay);
        }
        Paragraph::new(rows.clone())
            .scroll((scroll_rows, 0))
            .render(content, buf);
        // Only the owned column handles mouse input. Keep the native inline Ledger unchanged.
        let close_button = owned_column.then(|| {
            Rect::new(
                area.right() - LEDGER_CLOSE_BUTTON_WIDTH - 1,
                area.y,
                LEDGER_CLOSE_BUTTON_WIDTH,
                1,
            )
        });
        if let Some(button) = close_button {
            buf.set_string(
                button.x,
                button.y,
                " ✕ ",
                crate::style::user_message_style().bold(),
            );
        }
        *self.context_ledger.click_map.borrow_mut() = Some(LedgerClickMap {
            close_button,
            content,
            scroll_rows,
            targets: click_targets,
        });

        // Attach OSC 8 destinations to the cells just drawn. Each row fits the content width,
        // so one row of text is one row on screen.
        if !source_links.is_empty() {
            let links: std::collections::HashMap<usize, String> =
                source_links.into_iter().collect();
            let hyperlink_lines = rows
                .into_iter()
                .enumerate()
                .map(|(index, line)| {
                    let mut hyperlink_line = crate::terminal_hyperlinks::HyperlinkLine::new(line);
                    if let Some(destination) = links.get(&index) {
                        let mut hyperlink = crate::terminal_hyperlinks::TerminalHyperlink::web(
                            0..usize::from(content_width),
                            destination.clone(),
                        );
                        // Ledger rows link files Elpis itself chose, never model output.
                        if let Ok(url) = url::Url::parse(destination)
                            && url.scheme() == "file"
                        {
                            hyperlink.retarget_to_trusted_file(&url);
                        }
                        hyperlink_line.hyperlinks.push(hyperlink);
                    }
                    hyperlink_line
                })
                .collect::<Vec<_>>();
            crate::terminal_hyperlinks::mark_buffer_hyperlinks(
                buf,
                content,
                &hyperlink_lines,
                usize::from(scroll_rows),
            );
        }
    }

    pub(super) fn forget_context_ledger_clicks(&self) {
        self.context_ledger.click_map.borrow_mut().take();
    }

    /// Full screen only, where Elpis owns the mouse: a plain left click on a switch or a
    /// source row does what Space does on that row. Ctrl+click stays with the row's file
    /// link, and every other click falls through to the composer and the transcript.
    pub(crate) fn handle_context_ledger_mouse(
        &mut self,
        mouse: crossterm::event::MouseEvent,
    ) -> bool {
        if mouse.kind != crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left)
            || !mouse.modifiers.is_empty()
            || !self
                .last_rendered_width
                .get()
                .is_some_and(|width| self.context_ledger_width(width) > 0)
        {
            return false;
        }
        let target = {
            let map = self.context_ledger.click_map.borrow();
            let Some(map) = map.as_ref() else {
                return false;
            };
            let position = ratatui::layout::Position::new(mouse.column, mouse.row);
            if map
                .close_button
                .is_some_and(|button| button.contains(position))
            {
                Some(LedgerClickTarget::Close)
            } else if map.content.contains(position) {
                let row = usize::from(mouse.row - map.content.y + map.scroll_rows);
                map.targets
                    .iter()
                    .find(|(rows, _)| rows.contains(&row))
                    .map(|(_, target)| *target)
            } else {
                None
            }
        };
        match target {
            Some(LedgerClickTarget::Close) => self.close_context_ledger(),
            Some(LedgerClickTarget::SmartPrune) => {
                self.toggle_smart_prune();
            }
            Some(LedgerClickTarget::Subagents) => {
                self.toggle_subagents();
            }
            Some(LedgerClickTarget::Source(index)) => {
                let sources = self.continuity_sources();
                let Some(source) = sources.get(index).filter(|source| source.selectable) else {
                    return false;
                };
                self.context_ledger.selected = index;
                self.set_context_source_admitted(source, !source.admitted);
            }
            None => return false,
        }
        self.request_redraw();
        true
    }

    fn ledger_title_animation_delay(
        &self,
        title_rows: &std::ops::Range<usize>,
        scroll_rows: u16,
        visible_rows: u16,
    ) -> Option<Duration> {
        let scroll = usize::from(scroll_rows);
        (self.context_ledger.visible
            && self.local_settings.tui.animations
            && self.local_settings.tui.effects.shimmer
            && effective_stdout_color_level() == StdoutColorLevel::TrueColor
            && default_bg().is_some()
            && default_fg().is_some()
            && visible_rows > 0
            && title_rows.start < scroll + usize::from(visible_rows)
            && title_rows.end > scroll)
            .then(|| {
                crate::status_indicator_widget::next_summary_shimmer_frame(
                    self.context_ledger.title_started_at.elapsed(),
                )
            })
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

    pub(crate) fn manual_memory_refresh_requested(&self) -> bool {
        self.manual_memory_cache.refresh_requested
    }

    pub(crate) fn manual_memory_context_report_pending(&self) -> bool {
        self.manual_memory_cache.pending_context_report
    }

    pub(crate) fn manual_memory_pending_mutation(&self) -> Option<ManualMemoryMutation> {
        self.manual_memory_cache.pending_mutation
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
            .send(AppEvent::Elpis(ElpisAppEvent::ManualMemoryCreateRequested(
                target,
            )));
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
        self.app_event_tx.send(AppEvent::Elpis(
            ElpisAppEvent::ManualMemoryAdmissionRequested(target, admitted),
        ));
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
            self.app_event_tx.send(AppEvent::Elpis(
                ElpisAppEvent::ManualMemoryStatusRefreshRequested(target),
            ));
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
            .send(AppEvent::Elpis(ElpisAppEvent::RequestContextUsageReport(
                target,
            )));
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
        if let Some(drag) = self.context_ledger.resize_anchor.take() {
            self.context_ledger.preferred_width = drag.restore_width;
        }
        self.context_ledger.visible = false;
        self.context_ledger.focused = false;
        self.context_ledger.smart_prune_selected = false;
        self.context_ledger.subagents_selected = false;
        self.context_ledger.pending_g = false;
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
                Some(elpis_memory_dir(&self.config).as_path()),
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

    /// Delete on a manually added row drops it from the ledger for good.
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
            Some(elpis_memory_dir(&self.config).as_path()),
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
            Some(elpis_memory_dir(&self.config).as_path()),
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
                Some(elpis_memory_dir(&self.config).as_path()),
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
    let bar_width = content_width.max(1);
    let total_tokens = segments
        .iter()
        .map(|(tokens, _)| *tokens)
        .sum::<u64>()
        .min(context_window);
    let cells_used = ((total_tokens as u128 * bar_width as u128
        + u128::from(context_window.max(1)) / 2)
        / u128::from(context_window.max(1))) as usize;
    let mut spans = category_bar_spans(segments, cells_used);
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

fn source_heading_style() -> Style {
    crate::style::section_style()
}

/// The Ledger's left rule. The top and bottom rules of each box beside it end on it, so it
/// joins them.
fn render_ledger_rule(area: Rect, box_rules: &[(u16, u16)], buf: &mut Buffer) {
    if area.width == 0 {
        return;
    }
    let style = crate::style::rule_style();
    for y in area.top()..area.bottom() {
        let joins = box_rules
            .iter()
            .any(|(top, bottom)| y == *top || y == *bottom);
        let (up, down) = (y > area.top(), y + 1 < area.bottom());
        let symbol = match (joins, up, down) {
            (false, _, _) => "│",
            (true, true, true) => "┤",
            (true, false, true) => "┐",
            (true, true, false) => "┘",
            (true, false, false) => "─",
        };
        buf[(area.x, y)].set_symbol(symbol).set_style(style);
    }
}

/// Wraps each line to `width` with Codex's own wrapper. Returns the rows and, for each line,
/// the index of its first row, followed by the row count.
fn wrap_ledger_rows(lines: &[Line<'static>], width: usize) -> (Vec<Line<'static>>, Vec<usize>) {
    let mut rows = Vec::new();
    let mut row_starts = Vec::with_capacity(lines.len() + 1);
    for line in lines {
        row_starts.push(rows.len());
        let wrapped = crate::wrapping::word_wrap_lines(std::iter::once(line), width.max(1));
        if wrapped.is_empty() {
            rows.push(Line::default());
        } else {
            rows.extend(wrapped);
        }
    }
    row_starts.push(rows.len());
    (rows, row_starts)
}

/// `text` cut from the left to `max_width` terminal columns, with "…" in front when it is cut.
fn truncate_start_to_width(text: &str, max_width: usize) -> String {
    if text.width() <= max_width {
        return text.to_string();
    }
    let budget = max_width.saturating_sub(1);
    let mut width = 0;
    let mut start = text.len();
    for (index, character) in text.char_indices().rev() {
        let character_width = character.width().unwrap_or(0);
        if width + character_width > budget {
            break;
        }
        width += character_width;
        start = index;
    }
    format!("…{}", &text[start..])
}

/// The scroll that shows the selected source's rows in `visible_rows`.
fn selected_source_scroll_offset(source_rows: std::ops::Range<usize>, visible_rows: u16) -> u16 {
    let start = u16::try_from(source_rows.start).unwrap_or(u16::MAX);
    let end = u16::try_from(source_rows.end.max(source_rows.start)).unwrap_or(u16::MAX);
    end.saturating_sub(visible_rows.max(1)).min(start)
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
    fn ledger_sections_and_admitted_states_have_distinct_roles() {
        for bg in [(255, 255, 255), (17, 18, 20)] {
            crate::terminal_palette::with_test_default_colors(
                crate::terminal_probe::DefaultColors {
                    fg: (120, 120, 120),
                    bg,
                },
                || {
                    let Some(Color::Rgb(r, g, b)) = source_heading_style().fg else {
                        panic!("expected truecolor teal");
                    };
                    assert!(g > r && b > r);
                    assert_ne!(source_heading_style().fg, crate::style::context_style().fg);
                    assert_ne!(source_heading_style().fg, crate::style::brand_style().fg);
                },
            );
        }
    }

    #[tokio::test]
    async fn ledger_title_only_requests_motion_while_visible_and_enabled() {
        let (mut chat, _sender, _rx, _op_rx) =
            crate::chatwidget::tests::make_chatwidget_manual_with_sender().await;
        crate::terminal_palette::with_test_default_colors(
            crate::terminal_probe::DefaultColors {
                fg: (16, 16, 16),
                bg: (255, 255, 255),
            },
            || {
                chat.context_ledger.visible = true;
                chat.local_settings.tui.animations = true;
                chat.local_settings.tui.effects.shimmer = true;
                assert!(chat.ledger_title_animation_delay(&(2..3), 0, 4).is_some());
                assert!(chat.ledger_title_animation_delay(&(2..3), 3, 4).is_none());
                assert!(chat.ledger_title_animation_delay(&(4..5), 0, 4).is_none());
                assert!(chat.ledger_title_animation_delay(&(2..3), 0, 0).is_none());
                chat.local_settings.tui.effects.shimmer = false;
                assert!(chat.ledger_title_animation_delay(&(2..3), 0, 4).is_none());
                chat.local_settings.tui.effects.shimmer = true;
                chat.local_settings.tui.animations = false;
                assert!(chat.ledger_title_animation_delay(&(2..3), 0, 4).is_none());
                chat.local_settings.tui.animations = true;
                chat.context_ledger.visible = false;
                assert!(chat.ledger_title_animation_delay(&(2..3), 0, 4).is_none());
            },
        );
    }

    #[test]
    fn selected_source_scrolls_into_a_short_ledger() {
        assert_eq!(selected_source_scroll_offset(1..3, 4), 0);
        assert_eq!(selected_source_scroll_offset(6..8, 4), 4);
        assert_eq!(selected_source_scroll_offset(0..0, 4), 0);
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
        let offset = |width| {
            let (_, starts) = wrap_ledger_rows(&lines, width);
            selected_source_scroll_offset(starts[5]..starts[7], 4)
        };
        assert!(offset(12) > offset(52));
    }

    #[test]
    fn wide_names_are_cut_by_columns_from_the_left() {
        let name = "数据数据数据.md";
        let shown = truncate_start_to_width(name, 8);
        assert_eq!(shown, "…数据.md");
        assert!(shown.width() <= 8);
        assert_eq!(truncate_start_to_width("short.md", 8), "short.md");
    }

    #[test]
    fn usage_bar_never_fills_more_cells_than_total_usage() {
        let line = usage_bar_line(
            10,
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
            .filter(|span| !span.content.contains('░'))
            .count();
        assert_eq!(filled, 1, "100/1000 of a ten-cell bar is one cell");
    }

    #[test]
    fn usage_bar_aligns_with_ledger_text_and_fits_the_available_width() {
        for width in [1, 10, 32, 48] {
            let line = usage_bar_line(width, 100, &[(25, Color::Blue)]);
            let text: String = line
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect();
            assert!(text.starts_with(['█', '░']));
            assert_eq!(text.width(), width);
        }
    }

    #[test]
    fn usage_bar_keeps_allocated_width_at_low_full_and_excess_usage() {
        for width in [1, 2, 10, 32, 48] {
            for tokens in [0, 1, 25, 50, 100] {
                let line =
                    usage_bar_line(width, 100, &[(tokens, Color::Blue), (tokens, Color::Red)]);
                let text: String = line
                    .spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect();
                let used = (((tokens * 2).min(100) as usize * width + 50) / 100).min(width);
                assert_eq!(line.width(), width);
                assert_eq!(text.chars().filter(|c| *c != '░').count(), used);
                assert_eq!(text.matches('░').count(), width - used);
                // One cell holds both halves; from two cells on, the last cell is all red.
                if used >= 2 {
                    assert_eq!(text.chars().nth(used - 1), Some('█'), "{text}");
                }
            }
        }
    }
}
