//! One colour per model, shared by task rows, task details and conversation speakers.
//! Known model families keep fixed hues; other models hash into a separate palette, so an
//! unknown model never borrows a family's colour. Every hue passes through
//! `readable_color_on`, which keeps it legible on light and dark terminals.

use crate::style::readable_color_on;
use crate::terminal_palette::rgb_color;
use codex_app_server_protocol::Thread;
use ratatui::style::Color;
use ratatui::style::Style;

const CLAUDE: (u8, u8, u8) = (0xb4, 0x53, 0x2a);
const SOL: (u8, u8, u8) = (0x0b, 0x7a, 0x5e);
const GEMINI: (u8, u8, u8) = (0x1a, 0x5f, 0xd0);
const LUNA: (u8, u8, u8) = (0x6d, 0x3f, 0xb5);
/// Hues for every other model, away from the family hues and the Working amber.
const OTHERS: [(u8, u8, u8); 4] = [
    (0xa3, 0x30, 0x7a),
    (0x5c, 0x7a, 0x0f),
    (0x00, 0x70, 0x8c),
    (0x7a, 0x52, 0x30),
];
/// Working is the only status with a colour; every other status stays neutral.
const WORKING: (u8, u8, u8) = (0x9a, 0x6e, 0x00);

fn agent_rgb(model: &str) -> (u8, u8, u8) {
    let model = model.to_ascii_lowercase();
    if model.starts_with("claude/") {
        CLAUDE
    } else if model.starts_with("agy/") {
        GEMINI
    } else if model.starts_with("gpt-6") && model.contains("luna") {
        LUNA
    } else if model.starts_with("gpt-6") && model.contains("sol") {
        SOL
    } else {
        // Explicit FNV-1a, so a model keeps its colour across runs and Rust versions.
        let hash = model.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
        OTHERS[(hash % OTHERS.len() as u64) as usize]
    }
}

/// The thread's model, when it reports one.
pub(in crate::app) fn thread_model(thread: &Thread) -> Option<&str> {
    thread.model.as_deref().filter(|model| !model.is_empty())
}

/// The agent colour on `background`; `None` means the terminal's own background.
fn agent_color_on(model: &str, background: Option<Color>) -> Color {
    readable_color_on(rgb_color(agent_rgb(model)), background)
}

/// Text in `model`'s colour on the surface `base` paints, or `base` itself without a model
/// or with colours turned off.
pub(in crate::app) fn agent_style(model: Option<&str>, base: Style, colors: bool) -> Style {
    match model.filter(|_| colors) {
        Some(model) => base.fg(agent_color_on(model, base.bg)),
        None => base,
    }
}

/// The Working status colour on the surface `base` paints.
pub(in crate::app) fn working_style(base: Style, colors: bool) -> Style {
    if colors {
        base.fg(readable_color_on(rgb_color(WORKING), base.bg))
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn luminance((r, g, b): (u8, u8, u8)) -> f64 {
        let channel = |value: u8| {
            let value = f64::from(value) / 255.0;
            if value <= 0.04045 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(/*n*/ 2.4)
            }
        };
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }

    fn contrast(a: (u8, u8, u8), b: (u8, u8, u8)) -> f64 {
        let (a, b) = (luminance(a), luminance(b));
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    #[test]
    fn families_keep_their_hues_and_other_models_avoid_them() {
        assert_eq!(agent_rgb("claude/opus"), CLAUDE);
        assert_eq!(agent_rgb("claude/sonnet"), CLAUDE);
        assert_eq!(agent_rgb("gpt-6.1-sol"), SOL);
        assert_eq!(agent_rgb("gpt-6-sol"), SOL);
        assert_eq!(agent_rgb("agy/gemini-3.8-flash-high"), GEMINI);
        assert_eq!(agent_rgb("gpt-6-luna"), LUNA);
        for model in ["gpt-5.5", "gpt-6-astra", "local/qwen", "gpt-reserve"] {
            assert_eq!(agent_rgb(model), agent_rgb(model), "{model} is stable");
            assert!(OTHERS.contains(&agent_rgb(model)), "{model}");
        }
    }

    #[test]
    fn agent_colours_stay_readable_on_light_and_dark_terminals() {
        for (fg, bg) in [
            ((20, 20, 20), (255, 255, 255)),
            ((230, 230, 230), (24, 24, 24)),
        ] {
            let colors = crate::terminal_probe::DefaultColors { fg, bg };
            let hues = [CLAUDE, SOL, GEMINI, LUNA, WORKING]
                .into_iter()
                .chain(OTHERS)
                .collect::<Vec<_>>();
            for hue in hues {
                let color = crate::terminal_palette::with_test_default_colors(colors, || {
                    readable_color_on(rgb_color(hue), /*background*/ None)
                });
                let Color::Rgb(r, g, b) = color else {
                    panic!("{hue:?} resolved to {color:?}");
                };
                assert!(
                    contrast((r, g, b), bg) >= 4.5,
                    "{hue:?} on {bg:?} became {color:?}"
                );
            }
        }
    }
}
