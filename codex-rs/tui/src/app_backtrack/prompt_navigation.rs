//! A persistent mode label and responsive hints, using the configured action for details.

use super::*;
use crate::bottom_pane::TranscriptFooter;
use crate::footer_hint::first_fitting_line;
use ratatui::style::Stylize;
use ratatui::text::Line;

impl App {
    pub(crate) fn prompt_navigation_footer(&self, width: u16) -> Option<TranscriptFooter> {
        if !self.backtrack.overlay_preview_active
            || (self.overlay.is_none()
                && (self.transcript_view.has_active_interaction()
                    || self.transcript_view.history == TranscriptHistoryState::Failed))
        {
            return None;
        }
        let details = self
            .keymap
            .primary_hint(crate::keymap::KeymapContext::Global, "open_transcript")
            .map(|key| (key.display_label(), "details"));
        // Elpis: on the full screen, letters type into the composer (typed_key_leaves_browsing),
        // so only the transcript overlay names its letter keys.
        let (scroll, prompts, both) = if self.overlay.is_some() {
            ("↑↓/jk", "←→/hl", "↑↓/jk ←→/hl")
        } else {
            ("↑↓", "←→", "↑↓ ←→")
        };
        let mut full_hints = vec![
            (scroll.to_string(), "scroll"),
            (prompts.to_string(), "prompts"),
        ];
        full_hints.extend(details.clone());
        full_hints.extend([("↵".to_string(), "rewind"), ("esc".to_string(), "back")]);
        let mut compact_hints = vec![(both.to_string(), "")];
        compact_hints.extend(details);
        compact_hints.extend([("↵".to_string(), "rewind"), ("esc".to_string(), "back")]);
        let line = first_fitting_line(
            [
                ("Browsing transcript", full_hints.clone()),
                ("Browsing", full_hints),
                ("Browsing", compact_hints),
                (
                    "Browsing",
                    vec![
                        (both.to_string(), ""),
                        ("↵".to_string(), "rewind"),
                        ("esc".to_string(), ""),
                    ],
                ),
                (
                    "Browsing",
                    vec![("↵".to_string(), "rewind"), ("esc".to_string(), "back")],
                ),
                ("Browsing", vec![("esc".to_string(), "back")]),
                ("Browsing", vec![("esc".to_string(), "")]),
                ("Browsing", Vec::new()),
            ]
            .map(|(label, hints)| {
                let mut line = Line::from(label.fg(crate::style::accent_color()));
                for (keys, action) in hints {
                    line.spans.push(" · ".dim());
                    line.spans.extend(crate::key_hint::key_label_spans(&keys));
                    if !action.is_empty() {
                        line.spans.push(format!(" {action}").dim());
                    }
                }
                line
            }),
            width,
        );
        Some(TranscriptFooter {
            text: line.into(),
            cursor_column: None,
            is_interactive: true,
        })
    }
}
