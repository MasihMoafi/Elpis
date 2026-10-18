//! Keyboard activation of the inline audit link while reading activity.
use super::*;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

impl TranscriptView {
    pub(super) fn handle_prune_key(&mut self, key: KeyEvent) -> Option<ViewAction> {
        if key.code == KeyCode::Enter && key.modifiers.is_empty() {
            if let Some(url) = self.prune_focus.take() {
                return Some(ViewAction::OpenLink(url));
            }
        }
        if key.code == KeyCode::Esc && self.prune_focus.take().is_some() {
            return Some(ViewAction::Changed);
        }
        if matches!(key.code, KeyCode::Tab | KeyCode::BackTab)
            && (self.detailed || self.is_activity_focused() || self.prune_focus.is_some())
            && !self.search.is_active()
            && self.selection.is_none()
            && self.copy_mode.is_none()
        {
            let mut links = Vec::new();
            for row in &self.visible {
                for column in 0..self.area.width {
                    if let Some(link) = row.layout.link_at(row.row, column)
                        && link.starts_with(crate::chatwidget::smart_prune_log::INLINE_LINK_PREFIX)
                        && !links.contains(&link)
                    {
                        links.push(link);
                    }
                }
            }
            if links.is_empty() {
                return None;
            }
            let backwards =
                key.code == KeyCode::BackTab || key.modifiers.contains(KeyModifiers::SHIFT);
            let current = self
                .prune_focus
                .as_ref()
                .and_then(|focus| links.iter().position(|link| link == focus));
            let next = match current {
                Some(index) if backwards => (index + links.len() - 1) % links.len(),
                Some(index) => (index + 1) % links.len(),
                None if backwards => links.len() - 1,
                None => 0,
            };
            self.prune_focus = Some(links[next].clone());
            return Some(ViewAction::Changed);
        }
        self.prune_focus = None;
        None
    }

    pub(super) fn render_prune_focus(
        &self,
        layout: &TextLayout,
        row: usize,
        area: Rect,
        buf: &mut Buffer,
    ) {
        let Some(focus) = &self.prune_focus else {
            return;
        };
        for column in 0..area.width {
            if layout.link_at(row, column).as_ref() == Some(focus) {
                buf[(area.x + column, area.y)].set_style(
                    ratatui::style::Style::default()
                        .fg(crate::style::accent_color())
                        .underlined()
                        .remove_modifier(ratatui::style::Modifier::DIM),
                );
            }
        }
    }
}
