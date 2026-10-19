//! Smooth, whole-grapheme status shimmer with the desktop's cadenced sweep.
//!
//! Only brightness changes: the moving band uses the terminal foreground, while
//! the remaining text blends halfway into the background. The wave spans at
//! least six terminal columns so short labels do not flash one letter at a time.
//! New headers wait 600 ms, then sweep for one second every four seconds.
//! Unknown palettes use static dim text instead of a stepped animation, except
//! Elpising and the Ledger title: solid gold waves and undimmed fallbacks retain legibility.

use std::time::Duration;

use ratatui::style::Style;
use ratatui::text::Span;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::color::blend;
use crate::motion::MotionMode;
use crate::terminal_palette::StdoutColorLevel;
use crate::terminal_palette::default_bg;
use crate::terminal_palette::default_fg;
use crate::terminal_palette::effective_stdout_color_level;
use crate::terminal_palette::rgb_color;

// Match the desktop app's thinking and reasoning header timings.
const START_DELAY: Duration = Duration::from_millis(/*millis*/ 600);
const SWEEP_SECONDS: f64 = 1.0;
const INTERVAL_SECONDS: f64 = 4.0;

pub(crate) fn summary_shimmer(
    text: &str,
    elapsed: Duration,
    motion: MotionMode,
) -> Vec<Span<'static>> {
    if text == crate::branding::WORKING_LABEL {
        let (resting, peak) = crate::style::working_label_styles();
        summary_shimmer_with_colors(text, elapsed, motion, Some(resting), Some(peak))
    } else {
        summary_shimmer_with_colors(text, elapsed, motion, None, None)
    }
}

/// Preserve the status wave while keeping the Ledger's gold solid and readable.
pub(crate) fn ledger_title_shimmer(
    text: &str,
    elapsed: Duration,
    motion: MotionMode,
) -> Vec<Span<'static>> {
    let (resting, peak) = crate::style::ledger_title_styles();
    summary_shimmer_with_colors(text, elapsed, motion, Some(resting), Some(peak))
}

fn summary_shimmer_with_colors(
    text: &str,
    elapsed: Duration,
    motion: MotionMode,
    accent: Option<Style>,
    peak: Option<Style>,
) -> Vec<Span<'static>> {
    if motion == MotionMode::Reduced {
        return vec![Span::styled(text.to_owned(), accent.unwrap_or_default())];
    }
    let (StdoutColorLevel::TrueColor, Some(fg), Some(bg)) =
        (effective_stdout_color_level(), default_fg(), default_bg())
    else {
        return vec![Span::styled(
            text.to_owned(),
            if peak.is_some() {
                accent.unwrap_or_default()
            } else {
                accent.unwrap_or_default().dim()
            },
        )];
    };
    let fg = match accent.and_then(|style| style.fg) {
        Some(ratatui::style::Color::Rgb(r, g, b)) => (r, g, b),
        _ => fg,
    };
    let (resting, peak, minimum_alpha) = match peak.and_then(|style| style.fg) {
        Some(ratatui::style::Color::Rgb(r, g, b)) => (fg, (r, g, b), 0.0),
        _ => (bg, fg, 0.5),
    };
    let width = text.width() as f64;
    let half_width = (width * 0.1).max(/*other*/ 3.0);
    let sweep =
        (elapsed.saturating_sub(START_DELAY).as_secs_f64() % INTERVAL_SECONDS).min(SWEEP_SECONDS);
    let position = sweep / SWEEP_SECONDS * (width + 2.0 * half_width) - half_width;
    let mut column = 0.0;
    text.graphemes(/*is_extended*/ true)
        .map(|grapheme| {
            let glyph_width = grapheme.width() as f64;
            let center = column + glyph_width / 2.0;
            column += glyph_width;
            let distance = ((center - position).abs() / half_width).min(/*other*/ 1.0);
            let intensity = 0.5 * (1.0 + (std::f64::consts::PI * distance).cos());
            let alpha = (minimum_alpha + (1.0 - minimum_alpha) * intensity) as f32;
            let color = rgb_color(blend(peak, resting, alpha));
            let style = Style::default().fg(color);
            Span::styled(grapheme.to_owned(), style)
        })
        .collect()
}

/// Idle titles do not need continuous redraws during the delay or between sweeps.
pub(crate) fn next_summary_shimmer_frame(elapsed: Duration) -> Duration {
    if elapsed < START_DELAY {
        return START_DELAY - elapsed;
    }
    let phase = elapsed.saturating_sub(START_DELAY).as_secs_f64() % INTERVAL_SECONDS;
    if phase < SWEEP_SECONDS {
        Duration::from_millis(32)
    } else {
        Duration::from_secs_f64(INTERVAL_SECONDS - phase)
    }
}

#[cfg(test)]
#[path = "summary_shimmer_tests.rs"]
mod tests;
