use super::*;
use pretty_assertions::assert_eq;

use crate::terminal_palette::with_test_default_colors;
use crate::terminal_probe::DefaultColors;

fn assert_readable_native_gold_wave(
    label: &str,
    shimmer: fn(&str, Duration, MotionMode) -> Vec<Span<'static>>,
    palette: fn() -> (Style, Style),
) {
    let rgb = |style: Style| match style.fg {
        Some(ratatui::style::Color::Rgb(r, g, b)) => (r, g, b),
        _ => panic!("expected RGB"),
    };
    for bg in [(255, 255, 255), (250, 248, 245), (16, 16, 16), (40, 40, 40)] {
        with_test_default_colors(
            DefaultColors {
                fg: (128, 128, 128),
                bg,
            },
            || {
                let (resting, peak) = palette();
                let (rest_rgb, peak_rgb) = (rgb(resting), rgb(peak));
                assert!(resting.add_modifier.is_empty());
                assert_eq!(
                    shimmer(label, Duration::ZERO, MotionMode::Reduced),
                    vec![Span::styled(label, resting)],
                );
                assert_eq!(
                    shimmer(label, Duration::from_secs(1), MotionMode::Reduced),
                    shimmer(label, Duration::ZERO, MotionMode::Reduced),
                );
                assert!(
                    shimmer(label, Duration::ZERO, MotionMode::Animated)
                        .iter()
                        .all(|span| rgb(span.style) == rest_rgb)
                );
                for ms in (0..=8600).step_by(32) {
                    let elapsed = Duration::from_millis(ms);
                    let actual = shimmer(label, elapsed, MotionMode::Animated);
                    // Recover the native wave from an equal-width neutral label.
                    // Gold changes only the color endpoints, never this envelope.
                    let native_label = ".".repeat(label.len());
                    let native = with_test_default_colors(
                        DefaultColors {
                            fg: (254, 254, 254),
                            bg: (0, 0, 0),
                        },
                        || summary_shimmer(&native_label, elapsed, MotionMode::Animated),
                    );
                    assert_eq!(actual.len(), native.len());
                    assert_eq!(
                        actual
                            .iter()
                            .map(|span| span.content.as_ref())
                            .collect::<String>(),
                        label,
                    );
                    for (actual, native) in actual.iter().zip(native) {
                        let intensity = f32::from(rgb(native.style).0 - 127) / 127.0;
                        let expected = blend(peak_rgb, rest_rgb, intensity);
                        let color = rgb(actual.style);
                        assert!(
                            crate::style::contrast_ratio(color, bg) >= 4.5,
                            "title contrast on {bg:?} at {ms}ms: {color:?}"
                        );
                        for (got, want) in [
                            (color.0, expected.0),
                            (color.1, expected.1),
                            (color.2, expected.2),
                        ] {
                            assert!(got.abs_diff(want) <= 1, "native wave at {ms}ms");
                        }
                        assert!(color.0 > color.1 && color.1 > color.2, "gold hue at {ms}ms");
                        assert!(
                            color.2 <= rest_rgb.2.max(peak_rgb.2),
                            "gold must not fade into the background at {ms}ms"
                        );
                    }
                }
            },
        );
    }
}

#[test]
fn ledger_title_keeps_solid_gold_and_the_native_wave_in_both_themes() {
    assert_readable_native_gold_wave(
        "CONTEXT LEDGER",
        ledger_title_shimmer,
        crate::style::ledger_title_styles,
    );
}

#[test]
fn idle_header_sleeps_between_sweeps() {
    for (elapsed, delay) in [
        (0, 600),
        (599, 1),
        (600, 32),
        (1100, 32),
        (1600, 3000),
        (4599, 1),
        (4600, 32),
    ] {
        let actual = next_summary_shimmer_frame(Duration::from_millis(elapsed));
        assert!(actual.abs_diff(Duration::from_millis(delay)) < Duration::from_micros(1));
    }
}

#[test]
fn elpising_keeps_reference_gold_readable_through_the_native_wave() {
    assert_readable_native_gold_wave(
        crate::branding::WORKING_LABEL,
        summary_shimmer,
        crate::style::working_label_styles,
    );
    // Masih selected the former light-theme resting gold for the dark theme.
    for bg in [(16, 16, 16), (40, 40, 40)] {
        with_test_default_colors(
            DefaultColors {
                fg: (240, 240, 240),
                bg,
            },
            || {
                let spans = summary_shimmer(
                    crate::branding::WORKING_LABEL,
                    Duration::ZERO,
                    MotionMode::Animated,
                );
                assert!(
                    spans
                        .iter()
                        .all(|span| span.style.fg == Some(rgb_color((200, 183, 127))))
                );
            },
        );
    }
}

#[test]
fn elpising_unknown_palette_stays_undimmed() {
    let label = crate::branding::WORKING_LABEL;
    let fallback = summary_shimmer(label, Duration::ZERO, MotionMode::Animated);
    assert_eq!(fallback.len(), 1);
    assert!(fallback[0].style.add_modifier.is_empty());
    assert_eq!(
        fallback,
        summary_shimmer(label, Duration::from_secs(1), MotionMode::Reduced),
    );
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
