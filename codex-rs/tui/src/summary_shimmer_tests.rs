use super::*;
use pretty_assertions::assert_eq;

use crate::terminal_palette::with_test_default_colors;
use crate::terminal_probe::DefaultColors;

#[test]
fn elpis_working_label_uses_gold_with_native_cadence_and_reduced_motion() {
    let luminance = |(r, g, b): (u8, u8, u8)| {
        let linear = |channel: u8| {
            let value = f64::from(channel) / 255.0;
            if value <= 0.04045 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    };
    for colors in [
        DefaultColors {
            fg: (240, 240, 240),
            bg: (16, 16, 16),
        },
        DefaultColors {
            fg: (16, 16, 16),
            bg: (240, 240, 240),
        },
    ] {
        with_test_default_colors(colors, || {
            let label = crate::branding::WORKING_LABEL;
            let still = summary_shimmer(label, Duration::ZERO, MotionMode::Reduced);
            assert_eq!(
                still,
                vec![Span::styled("Elpising", crate::style::brand_style())]
            );
            assert_eq!(
                still,
                summary_shimmer(label, Duration::from_secs(1), MotionMode::Reduced)
            );
            let quiet = summary_shimmer(label, Duration::ZERO, MotionMode::Animated);
            let sweeping =
                summary_shimmer(label, Duration::from_millis(1100), MotionMode::Animated);
            assert_ne!(quiet, sweeping);
            assert_eq!(
                quiet,
                summary_shimmer(label, Duration::from_millis(4500), MotionMode::Animated)
            );
            for span in quiet.iter().chain(&sweeping).chain(&still) {
                let Some(ratatui::style::Color::Rgb(r, g, b)) = span.style.fg else {
                    panic!("expected gold RGB text");
                };
                assert!(r > g && g > b, "expected gold, got {r},{g},{b}");
                let foreground = luminance((r, g, b));
                let background = luminance(colors.bg);
                let contrast =
                    (foreground.max(background) + 0.05) / (foreground.min(background) + 0.05);
                assert!(contrast >= 4.5, "gold text contrast: {contrast}");
            }
        });
    }
}

#[test]
fn short_and_long_labels_sweep_smoothly_in_both_themes() {
    let mut frames = Vec::new();
    for (theme, colors) in [
        (
            "dark",
            DefaultColors {
                fg: (240, 240, 240),
                bg: (16, 16, 16),
            },
        ),
        (
            "light",
            DefaultColors {
                fg: (16, 16, 16),
                bg: (240, 240, 240),
            },
        ),
    ] {
        with_test_default_colors(colors, || {
            for text in ["Working", "Preparing bootstrap diagnostics", "界e\u{301}界"] {
                // Initial delay, the first sweep, the gap, and the next sweep.
                for ms in [0, 850, 1100, 1350, 3600, 5100] {
                    let spans =
                        summary_shimmer(text, Duration::from_millis(ms), MotionMode::Animated);
                    let levels = spans
                        .iter()
                        .map(|span| match span.style.fg {
                            Some(ratatui::style::Color::Rgb(level, _, _)) => level,
                            color => panic!("expected interpolated RGB, got {color:?}"),
                        })
                        .collect::<Vec<_>>();
                    frames.push(format!("{theme} {text} {ms}ms: {levels:?}"));
                }
            }
        });
    }
    insta::assert_snapshot!(frames.join("\n"));
}

#[test]
fn working_has_overlapping_highlights_without_frame_to_frame_flashes() {
    with_test_default_colors(
        DefaultColors {
            fg: (240, 240, 240),
            bg: (16, 16, 16),
        },
        || {
            let mut previous = Vec::new();
            // Sample two sweeps and the intervening gap at the status row's 32 ms cadence.
            for ms in (0..=5600).step_by(/*step*/ 32) {
                let spans =
                    summary_shimmer("Working", Duration::from_millis(ms), MotionMode::Animated);
                let brightness = spans
                    .iter()
                    .map(|span| match span.style.fg {
                        Some(ratatui::style::Color::Rgb(r, _, _)) => r,
                        color => panic!("expected interpolated RGB, got {color:?}"),
                    })
                    .collect::<Vec<_>>();
                if brightness.iter().any(|value| *value > 220) {
                    assert!(brightness.iter().filter(|value| **value > 160).count() >= 2);
                }
                for (current, previous) in brightness.iter().zip(&previous) {
                    // At this speed the cosine band's maximum change over 32 ms is
                    // 112 * sin(PI * (13 * 0.032) / 6), rounded up.
                    assert!(u8::abs_diff(*current, *previous) <= 25);
                }
                previous = brightness;
            }
            let midpoint = summary_shimmer(
                "Working",
                Duration::from_millis(/*millis*/ 1100),
                MotionMode::Animated,
            );
            let expected = "Working"
                .chars()
                .zip([128, 156, 212, 240, 212, 156, 128])
                .map(|(ch, level)| {
                    Span::styled(
                        ch.to_string(),
                        Style::default().fg(rgb_color((level, level, level))),
                    )
                })
                .collect::<Vec<_>>();
            assert_eq!(midpoint, expected);
        },
    );
}

#[test]
fn sweep_preserves_combining_characters_and_emoji_clusters() {
    let text = "e\u{301}👨‍👩‍👧‍👦界";
    let spans = with_test_default_colors(
        DefaultColors {
            fg: (240, 240, 240),
            bg: (16, 16, 16),
        },
        || summary_shimmer(text, Duration::ZERO, MotionMode::Animated),
    );
    assert_eq!(
        spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<Vec<_>>(),
        vec!["e\u{301}", "👨‍👩‍👧‍👦", "界"]
    );
    assert_eq!(
        summary_shimmer(text, Duration::from_secs(/*secs*/ 1), MotionMode::Reduced),
        vec![Span::from(text.to_owned())]
    );
}
