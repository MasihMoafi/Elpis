use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use crate::history_cell::PlainHistoryCell;
use crate::legacy_core::elpis_context::ContinuitySource;
use crate::legacy_core::elpis_context::ContinuitySourceCategory;

use super::*;

const WIDTH: u16 = 120;
const HEIGHT: u16 = 40;
const SAMPLE_COUNT: usize = 30;
const LEDGER_SOURCE_COUNT: usize = 24;
const SMALL_ACTIVE_LINES: usize = 4;
const LARGE_ACTIVE_LINES: usize = 1_024;
const ACTIVE_LINE_WIDTH: usize = 60;
const P95_BUDGET: Duration = Duration::from_millis(50);
const MAX_BUDGET: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug)]
enum ActiveCellSize {
    Small,
    Large,
}

impl ActiveCellSize {
    fn label(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Large => "large",
        }
    }

    fn line_count(self) -> usize {
        match self {
            Self::Small => SMALL_ACTIVE_LINES,
            Self::Large => LARGE_ACTIVE_LINES,
        }
    }
}

#[derive(Debug)]
struct Samples {
    fixture: String,
    character: Vec<Duration>,
    enter: Vec<Duration>,
}

/// Diagnostic experiment for the two synchronous render costs found in the typing-path audit.
///
/// Decision rule declared before running:
/// - every fixture should keep p95 at or below 50 ms and max at or below 100 ms;
/// - a fixed-variable p95 difference of at least 5 ms and 2x is material enough to justify
///   optimizing that variable before looking elsewhere.
///
/// The clock starts before key routing and includes the composer/queue mutation plus the real
/// `ChatWidget::desired_height` and `ChatWidget::render` calls. It deliberately excludes fixture
/// setup, buffer reset, assertions, the outer TUI event loop, and terminal writes. Consequently it
/// can identify synchronous widget-layout scaling, but cannot establish end-to-end key latency.
#[tokio::test]
#[ignore = "manual latency experiment; wall-clock thresholds must not make CI flaky"]
async fn typing_render_latency_matrix() {
    let mut results = Vec::new();

    for ledger_visible in [false, true] {
        for active_cell_size in [ActiveCellSize::Small, ActiveCellSize::Large] {
            let (mut chat, _events, _ops) = make_chatwidget_manual(None).await;
            configure_fixture(&mut chat, ledger_visible, active_cell_size);
            warm_render_path(&chat);

            let character = measure_character_samples(&mut chat);
            let enter = measure_enter_samples(&mut chat);
            results.push(Samples {
                fixture: format!(
                    "ledger={} active={}",
                    if ledger_visible { "on" } else { "off" },
                    active_cell_size.label()
                ),
                character,
                enter,
            });
        }
    }

    for result in &results {
        print_samples(&result.fixture, "char", &result.character);
        print_samples(&result.fixture, "enter", &result.enter);
    }
    print_materiality(&results);

    let failures = results
        .iter()
        .flat_map(|result| {
            [
                (result.fixture.as_str(), "char", &result.character),
                (result.fixture.as_str(), "enter", &result.enter),
            ]
        })
        .filter_map(|(fixture, action, samples)| {
            let p95 = percentile(samples, 95);
            let max = samples.iter().copied().max().unwrap_or_default();
            (p95 > P95_BUDGET || max > MAX_BUDGET).then(|| {
                format!(
                    "{fixture} {action}: p95={p95:?} max={max:?} (budgets {P95_BUDGET:?}/{MAX_BUDGET:?})"
                )
            })
        })
        .collect::<Vec<_>>();
    assert!(
        failures.is_empty(),
        "typing render latency budget failures:\n{}",
        failures.join("\n")
    );
}

fn configure_fixture(
    chat: &mut ChatWidget,
    ledger_visible: bool,
    active_cell_size: ActiveCellSize,
) {
    chat.manual_memory_cache.sources = synthetic_sources();
    chat.transcript.active_cell = Some(Box::new(PlainHistoryCell::new(active_cell_lines(
        active_cell_size,
    ))));
    chat.turn_lifecycle.agent_turn_running = true;
    chat.bottom_pane.set_task_running(true);
    chat.last_rendered_width.set(Some(WIDTH as usize));

    let initially_visible = chat.context_ledger_width(WIDTH) > 0;
    if initially_visible != ledger_visible {
        assert!(
            chat.handle_context_ledger_key_event(KeyEvent::new(
                KeyCode::Char('c'),
                KeyModifiers::ALT,
            ))
        );
    }
    assert_eq!(chat.context_ledger_width(WIDTH) > 0, ledger_visible);
}

fn synthetic_sources() -> Vec<ContinuitySource> {
    (0..LEDGER_SOURCE_COUNT)
        .map(|index| ContinuitySource {
            name: format!("source-{index:02}-{}.md", "context".repeat(4)),
            path: PathBuf::from(format!("/workspace/source-{index:02}.md")),
            bytes: 4_096,
            estimated_tokens: 1_024,
            category: match index % 3 {
                0 => ContinuitySourceCategory::Files,
                1 => ContinuitySourceCategory::Memory,
                _ => ContinuitySourceCategory::Instructions,
            },
            origin: "latency fixture",
            lifetime: "every turn",
            reason: "measure cached ledger rendering",
            admitted: index % 4 != 0,
            selectable: true,
        })
        .collect()
}

fn active_cell_lines(size: ActiveCellSize) -> Vec<Line<'static>> {
    (0..size.line_count())
        .map(|index| {
            let prefix = format!("active-{index:04} ");
            let fill = "x".repeat(ACTIVE_LINE_WIDTH.saturating_sub(prefix.len()));
            Line::from(format!("{prefix}{fill}"))
        })
        .collect()
}

fn warm_render_path(chat: &ChatWidget) {
    let area = Rect::new(0, 0, WIDTH, HEIGHT);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    for _ in 0..3 {
        buffer.reset();
        let _ = Renderable::desired_height(chat, WIDTH);
        Renderable::render(chat, area, &mut buffer);
    }
}

fn measure_character_samples(chat: &mut ChatWidget) -> Vec<Duration> {
    let area = Rect::new(0, 0, WIDTH, HEIGHT);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    let mut samples = Vec::with_capacity(SAMPLE_COUNT);

    for _ in 0..SAMPLE_COUNT {
        chat.bottom_pane
            .set_composer_text(String::new(), Vec::new(), Vec::new());
        assert!(chat.composer_text_with_pending().is_empty());
        buffer.reset();

        let started = Instant::now();
        chat.handle_key_event(KeyEvent::new(KeyCode::Char('Ω'), KeyModifiers::NONE));
        let _ = Renderable::desired_height(chat, WIDTH);
        Renderable::render(chat, area, &mut buffer);
        samples.push(started.elapsed());

        assert_eq!(chat.composer_text_with_pending(), "Ω");
        assert!(buffer_text(&buffer).contains('Ω'));
    }
    samples
}

fn measure_enter_samples(chat: &mut ChatWidget) -> Vec<Duration> {
    let area = Rect::new(0, 0, WIDTH, HEIGHT);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    let mut samples = Vec::with_capacity(SAMPLE_COUNT);

    for index in 0..SAMPLE_COUNT {
        let message = format!("queued-{index:02}");
        chat.bottom_pane
            .set_composer_text(message.clone(), Vec::new(), Vec::new());
        assert!(!chat.queued_user_message_texts().contains(&message));
        buffer.reset();

        let started = Instant::now();
        chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let _ = Renderable::desired_height(chat, WIDTH);
        Renderable::render(chat, area, &mut buffer);
        samples.push(started.elapsed());

        assert!(chat.composer_text_with_pending().is_empty());
        assert_eq!(
            chat.queued_user_message_texts().last().map(String::as_str),
            Some(message.as_str())
        );
        assert!(
            buffer_text(&buffer).contains(&message),
            "queued message was not visible after render"
        );

        chat.input_queue.queued_user_messages.pop_back();
        chat.input_queue
            .queued_user_message_history_records
            .pop_back();
        chat.refresh_pending_input_preview();
        assert!(!chat.queued_user_message_texts().contains(&message));
    }
    samples
}

fn buffer_text(buffer: &ratatui::buffer::Buffer) -> String {
    let area = *buffer.area();
    (area.top()..area.bottom())
        .flat_map(|row| {
            let mut line = (area.left()..area.right())
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>();
            line.push('\n');
            line.chars().collect::<Vec<_>>()
        })
        .collect()
}

fn percentile(samples: &[Duration], percentile: usize) -> Duration {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let rank = (sorted.len() * percentile).div_ceil(100).saturating_sub(1);
    sorted[rank]
}

fn print_samples(fixture: &str, action: &str, samples: &[Duration]) {
    let raw_micros = samples.iter().map(Duration::as_micros).collect::<Vec<_>>();
    let max = samples.iter().copied().max().unwrap_or_default();
    eprintln!(
        "{fixture} action={action} raw_us={raw_micros:?} p50={:?} p95={:?} max={max:?}",
        percentile(samples, 50),
        percentile(samples, 95),
    );
}

fn print_materiality(results: &[Samples]) {
    for action in ["char", "enter"] {
        for active in ["small", "large"] {
            let off = result_samples(results, "off", active, action);
            let on = result_samples(results, "on", active, action);
            eprintln!(
                "ledger_delta action={action} active={active} off_p95={:?} on_p95={:?}",
                percentile(off, 95),
                percentile(on, 95),
            );
        }
        for ledger in ["off", "on"] {
            let small = result_samples(results, ledger, "small", action);
            let large = result_samples(results, ledger, "large", action);
            eprintln!(
                "active_delta action={action} ledger={ledger} small_p95={:?} large_p95={:?}",
                percentile(small, 95),
                percentile(large, 95),
            );
        }
    }
}

fn result_samples<'a>(
    results: &'a [Samples],
    ledger: &str,
    active: &str,
    action: &str,
) -> &'a [Duration] {
    let result = results
        .iter()
        .find(|result| {
            result
                .fixture
                .contains(&format!("ledger={ledger} active={active}"))
        })
        .expect("matrix fixture");
    if action == "char" {
        &result.character
    } else {
        &result.enter
    }
}
