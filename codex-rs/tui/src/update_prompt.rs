//! Shared picker presentation for the installed CLI's update choices.
//! Update discovery and execution remain disabled in debug builds.

#![cfg(any(not(debug_assertions), test))]

use crate::bottom_pane::picker_option_list;
use crate::key_hint;
#[cfg(not(debug_assertions))]
use crate::legacy_core::config::Config;
use crate::render::Insets;
use crate::render::renderable::FlexRenderable;
use crate::render::renderable::Renderable;
use crate::render::renderable::RenderableExt as _;
use crate::render::renderable::RenderableItem;
use crate::tui::FrameRequester;
#[cfg(not(debug_assertions))]
use crate::tui::Tui;
#[cfg(not(debug_assertions))]
use crate::tui::TuiEvent;
use crate::update_action::UpdateAction;
#[cfg(not(debug_assertions))]
use crate::updates;
#[cfg(not(debug_assertions))]
use color_eyre::Result;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::prelude::Widget;
use ratatui::style::Stylize as _;
use ratatui::text::Line;
use ratatui::widgets::Clear;
use ratatui::widgets::Paragraph;
use ratatui::widgets::WidgetRef;
use ratatui::widgets::Wrap;
#[cfg(not(debug_assertions))]
use tokio_stream::StreamExt;

const RELEASE_NOTES_URL: &str = "https://github.com/openai/codex/releases/latest";

#[cfg(not(debug_assertions))]
pub(crate) enum UpdatePromptOutcome {
    Continue,
    RunUpdate(UpdateAction),
}

#[cfg(not(debug_assertions))]
pub(crate) async fn run_update_prompt_if_needed(
    tui: &mut Tui,
    config: &Config,
) -> Result<UpdatePromptOutcome> {
    let Some(latest_version) = updates::get_upgrade_version_for_popup(config) else {
        return Ok(UpdatePromptOutcome::Continue);
    };
    let Some(update_action) = crate::update_action::get_update_action() else {
        return Ok(UpdatePromptOutcome::Continue);
    };

    let mut screen =
        UpdatePromptScreen::new(tui.frame_requester(), latest_version.clone(), update_action);
    tui.draw(u16::MAX, |frame| {
        frame.render_widget_ref(&screen, frame.area());
    })?;

    tui.discard_pending_input_before_interactive_screen()?;
    let events = tui.event_stream();
    tokio::pin!(events);

    while !screen.is_done() {
        if let Some(event) = events.next().await {
            tui.screen_size_for_event(&event)?;
            match event {
                TuiEvent::Key(key_event) => screen.handle_key(key_event),
                TuiEvent::Paste(_) | TuiEvent::FocusLost | TuiEvent::Mouse(_) => {}
                TuiEvent::Draw | TuiEvent::Resume | TuiEvent::Resize(_) | TuiEvent::FocusGained => {
                    tui.draw(u16::MAX, |frame| {
                        frame.render_widget_ref(&screen, frame.area());
                    })?;
                }
            }
        } else {
            break;
        }
    }

    match screen.selection() {
        Some(UpdateSelection::UpdateNow) => {
            tui.terminal.clear()?;
            Ok(UpdatePromptOutcome::RunUpdate(update_action))
        }
        Some(UpdateSelection::NotNow) | None => Ok(UpdatePromptOutcome::Continue),
        Some(UpdateSelection::DontRemind) => {
            if let Err(err) = updates::dismiss_version(config, screen.latest_version()).await {
                tracing::error!("Failed to persist update dismissal: {err}");
            }
            Ok(UpdatePromptOutcome::Continue)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdateSelection {
    UpdateNow,
    NotNow,
    DontRemind,
}

struct UpdatePromptScreen {
    request_frame: FrameRequester,
    latest_version: String,
    current_version: String,
    update_action: UpdateAction,
    highlighted: UpdateSelection,
    selection: Option<UpdateSelection>,
}

impl UpdatePromptScreen {
    fn new(
        request_frame: FrameRequester,
        latest_version: String,
        update_action: UpdateAction,
    ) -> Self {
        Self {
            request_frame,
            latest_version,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            update_action,
            highlighted: UpdateSelection::UpdateNow,
            selection: None,
        }
    }

    fn handle_key(&mut self, key_event: KeyEvent) {
        if key_event.kind == KeyEventKind::Release {
            return;
        }
        if key_event.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key_event.code, KeyCode::Char('c') | KeyCode::Char('d'))
        {
            self.select(UpdateSelection::NotNow);
            return;
        }
        match key_event.code {
            KeyCode::Up | KeyCode::Char('k') => self.set_highlight(self.highlighted.prev()),
            KeyCode::Down | KeyCode::Char('j') => self.set_highlight(self.highlighted.next()),
            KeyCode::Char('1') => self.select(UpdateSelection::UpdateNow),
            KeyCode::Char('2') => self.select(UpdateSelection::NotNow),
            KeyCode::Char('3') => self.select(UpdateSelection::DontRemind),
            KeyCode::Enter => self.select(self.highlighted),
            KeyCode::Esc => self.select(UpdateSelection::NotNow),
            _ => {}
        }
    }

    fn set_highlight(&mut self, highlight: UpdateSelection) {
        if self.highlighted != highlight {
            self.highlighted = highlight;
            self.request_frame.schedule_frame();
        }
    }

    fn select(&mut self, selection: UpdateSelection) {
        self.highlighted = selection;
        self.selection = Some(selection);
        self.request_frame.schedule_frame();
    }

    fn is_done(&self) -> bool {
        self.selection.is_some()
    }

    fn selection(&self) -> Option<UpdateSelection> {
        self.selection
    }

    #[cfg(not(debug_assertions))]
    fn latest_version(&self) -> &str {
        self.latest_version.as_str()
    }
}

impl UpdateSelection {
    fn next(self) -> Self {
        match self {
            UpdateSelection::UpdateNow => UpdateSelection::NotNow,
            UpdateSelection::NotNow => UpdateSelection::DontRemind,
            UpdateSelection::DontRemind => UpdateSelection::UpdateNow,
        }
    }

    fn prev(self) -> Self {
        match self {
            UpdateSelection::UpdateNow => UpdateSelection::DontRemind,
            UpdateSelection::NotNow => UpdateSelection::UpdateNow,
            UpdateSelection::DontRemind => UpdateSelection::NotNow,
        }
    }
}

impl WidgetRef for &UpdatePromptScreen {
    fn render_ref(&self, area: Rect, buf: &mut Buffer) {
        Clear.render(area, buf);
        let mut column = FlexRenderable::new();

        let update_command = self.update_action.command_str();

        column.push(/*flex*/ 1, RenderableItem::Borrowed(&""));
        column.push(
            /*flex*/ 0,
            Paragraph::new(Line::from(vec![
                "Update available".bold(),
                " · ".dim(),
                format!(
                    "{current} → {latest}",
                    current = self.current_version,
                    latest = self.latest_version
                )
                .dim(),
            ]))
            .wrap(Wrap { trim: false })
            .inset(Insets::vh(/*v*/ 0, /*h*/ 2)),
        );
        column.push(
            /*flex*/ 1,
            Paragraph::new(Line::from(vec![
                "Release notes: ".dim(),
                RELEASE_NOTES_URL.dim().underlined(),
            ]))
            .wrap(Wrap { trim: false })
            .inset(Insets::vh(/*v*/ 0, /*h*/ 2)),
        );
        let selected_index = match self.highlighted {
            UpdateSelection::UpdateNow => 0,
            UpdateSelection::NotNow => 1,
            UpdateSelection::DontRemind => 2,
        };
        column.push(
            /*flex*/ 1,
            picker_option_list(
                vec![
                    format!("Update now (runs `{update_command}`)"),
                    "Skip".to_string(),
                    "Skip until next version".to_string(),
                ],
                selected_index,
            ),
        );
        column.push(
            /*flex*/ 0,
            Paragraph::new(Line::from(vec![
                key_hint::plain(KeyCode::Enter).into(),
                " continue · ".dim(),
                key_hint::plain(KeyCode::Esc).into(),
                " skip".dim(),
            ]))
            .wrap(Wrap { trim: false })
            .inset(Insets::vh(/*v*/ 0, /*h*/ 2)),
        );
        column.push(/*flex*/ 1, RenderableItem::Borrowed(&""));
        // Elpis: content stays inside the popup border.
        crate::bottom_pane::render_bordered_panel(area, buf, &column);
        crate::terminal_hyperlinks::mark_underlined_hyperlink(buf, area, RELEASE_NOTES_URL);
    }
}
